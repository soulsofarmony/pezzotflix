// Module 'profiles' (doc 02 §3.8): profiles and preferences, profile tokens, watch state.
// Provides profileState (catalog), profilePlayback (playback) and profileTokens (HTTP security).
import { join } from 'node:path';
import type { Ok } from '../../app/http.ts';
import { requireProfile, typed } from '../../app/http.ts';
import type { ModuleFactory } from '../../app/module.ts';
import { notFound } from '../../app/problem.ts';
import type { ProfilePlaybackPort, ProfileStatePort, ProfileTokenVerifier } from '../../shared/ports.ts';
import { createProfileStore } from './store.ts';
import { createProfileTokens, loadOrCreateKey, type ProfileTokens } from './tokens.ts';
import { createWatchState } from './watch.ts';

export interface ProfilesModuleOptions {
  /** Signing key of the profile tokens; default: read or created under DATA_DIR/secrets. */
  tokenKey?: Buffer;
}

export function profilesModule(opts: ProfilesModuleOptions = {}): ModuleFactory {
  return function createProfilesModule({ db, now, ports, config, log }) {
    const store = createProfileStore({ db, now });
    const watch = createWatchState({ db, now, catalog: () => ports.catalogRead, profileExists: store.exists, log });

    // Created on first use, so composing the module never touches the data volume.
    let tokens: ProfileTokens | null = null;
    const tokenSigner = (): ProfileTokens =>
      (tokens ??= createProfileTokens(opts.tokenKey ?? loadOrCreateKey(join(config.DATA_DIR, 'secrets', 'profile-token.key'), log)));

    const profileTokens: ProfileTokenVerifier = {
      verify(token) {
        const id = tokenSigner().open(token);
        return id && store.exists(id) ? id : null;
      },
    };
    const profileState: Required<ProfileStatePort> = {
      getStates: watch.getStates,
      continueWatching: watch.continueWatching,
      nextUp: watch.nextUp,
      lastPlayed: watch.lastPlayed,
      moveFileState: watch.moveFileState,
    };
    const profilePlayback: ProfilePlaybackPort = {
      getPrefs: (profileId) => store.get(profileId)?.prefs ?? null,
      recordProgress: watch.recordProgress,
      resumePositionMs: watch.resumePositionMs,
      lastTrackChoice: watch.lastTrackChoice,
      profileName: (profileId) => store.get(profileId)?.name ?? null,
    };

    const noContent = (reply: { code: (n: number) => { send: () => unknown } }) => reply.code(204).send();

    return {
      name: 'profiles',
      provides: { profileState, profilePlayback, profileTokens },
      handlers: {
        listProfiles: async (): Promise<Ok<'listProfiles'>> => ({ profiles: store.list() }),
        createProfile: async (req, reply): Promise<Ok<'createProfile'>> => {
          const p = store.create(typed<'createProfile'>(req).body);
          void reply.code(201);
          return p;
        },
        updateProfile: async (req): Promise<Ok<'updateProfile'>> => {
          const { params, body } = typed<'updateProfile'>(req);
          return store.update(params.profileId, body);
        },
        deleteProfile: async (req, reply) => {
          store.remove(typed<'deleteProfile'>(req).params.profileId);
          return noContent(reply);
        },
        selectProfile: async (req): Promise<Ok<'selectProfile'>> => {
          const p = store.get(typed<'selectProfile'>(req).params.profileId);
          if (!p) throw notFound('profile');
          return { profileToken: tokenSigner().sign(p.id), profile: p };
        },

        markWatched: async (req, reply) => {
          watch.markWatched(requireProfile(req), typed<'markWatched'>(req).params.itemId);
          return noContent(reply);
        },
        markUnwatched: async (req, reply) => {
          watch.markUnwatched(requireProfile(req), typed<'markUnwatched'>(req).params.itemId);
          return noContent(reply);
        },
        clearProgress: async (req, reply) => {
          watch.clearProgress(requireProfile(req), typed<'clearProgress'>(req).params.itemId);
          return noContent(reply);
        },
        addToWatchlist: async (req, reply) => {
          watch.addToWatchlist(requireProfile(req), typed<'addToWatchlist'>(req).params.itemId);
          return noContent(reply);
        },
        removeFromWatchlist: async (req, reply) => {
          watch.removeFromWatchlist(requireProfile(req), typed<'removeFromWatchlist'>(req).params.itemId);
          return noContent(reply);
        },
      },
    };
  };
}

export const createProfilesModule: ModuleFactory = profilesModule();
