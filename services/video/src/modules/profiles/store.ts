// Profiles: CRUD and playback preferences (doc 01 §7.1). Profile names are unique, case-insensitive.
import type { Db } from '../../db/index.ts';
import { conflict, notFound, ProblemError } from '../../app/problem.ts';
import { newId } from '../../shared/ids.ts';
import { normalizeLanguageTag } from '../../shared/languages.ts';
import type { ApiSchemas, ProfilePrefs } from '../../shared/ports.ts';
import { DEFAULT_PREFS } from './rules.ts';

export type Profile = ApiSchemas['Profile'];
export type ProfileInput = ApiSchemas['ProfileInput'];

interface ProfileRow {
  id: string;
  name: string;
  avatar: string | null;
  prefs: string;
}

const toProfile = (r: ProfileRow): Profile => ({ id: r.id, name: r.name, avatar: r.avatar, prefs: JSON.parse(r.prefs) as ProfilePrefs });

/** Languages to ISO 639-2/B, deduplicated in order; an unknown code is a validation error. */
function normalizePrefs(prefs: ProfilePrefs): ProfilePrefs {
  const langs = (field: 'audioLanguages' | 'subtitleLanguages') => {
    const out: string[] = [];
    prefs[field].forEach((tag, i) => {
      const code = normalizeLanguageTag(tag);
      if (!code || !/^[a-z]{3}$/.test(code)) {
        throw new ProblemError('VALIDATION_FAILED', `unknown language '${tag}'`, {
          errors: [{ path: `/body/prefs/${field}/${i}`, message: 'not an ISO 639 language code' }],
        });
      }
      if (!out.includes(code)) out.push(code);
    });
    return out;
  };
  return { audioLanguages: langs('audioLanguages'), subtitleLanguages: langs('subtitleLanguages'), subtitleMode: prefs.subtitleMode };
}

export function createProfileStore({ db, now }: { db: Db; now: () => number }) {
  const sql = db.$client;
  const all = sql.prepare('SELECT id, name, avatar, prefs FROM profile ORDER BY created_at, id');
  const one = sql.prepare('SELECT id, name, avatar, prefs FROM profile WHERE id = ?');
  const names = sql.prepare('SELECT id, name FROM profile');
  const insert = sql.prepare('INSERT INTO profile (id, name, avatar, prefs, created_at) VALUES (?, ?, ?, ?, ?)');
  const update = sql.prepare('UPDATE profile SET name = ?, avatar = ?, prefs = ? WHERE id = ?');
  const exists = sql.prepare('SELECT 1 FROM profile WHERE id = ?').pluck();
  const deletes = ['playback_progress', 'watch_state', 'viewing_record', 'watchlist_entry'].map((t) =>
    sql.prepare(`DELETE FROM ${t} WHERE profile_id = ?`),
  );
  const deleteProfile = sql.prepare('DELETE FROM profile WHERE id = ?');

  const cleanName = (raw: string): string => {
    const name = raw.trim();
    if (!name) throw new ProblemError('VALIDATION_FAILED', 'name is blank', { errors: [{ path: '/body/name', message: 'must not be blank' }] });
    return name;
  };
  // SQLite lower() only folds ASCII, so names are compared in JS ("Élodie" = "élodie"). Called inside
  // the write transaction; profiles are a handful of rows.
  const fold = (name: string) => name.toLocaleLowerCase('it');
  const assertNameFree = (name: string, selfId: string | null) => {
    const wanted = fold(name);
    const other = (names.all() as { id: string; name: string }[]).find((r) => r.id !== selfId && fold(r.name) === wanted);
    if (other) throw conflict(`a profile named '${name}' already exists`);
  };

  return {
    list: (): Profile[] => (all.all() as ProfileRow[]).map(toProfile),
    get(id: string): Profile | null {
      const r = one.get(id) as ProfileRow | undefined;
      return r ? toProfile(r) : null;
    },
    exists: (id: string): boolean => exists.get(id) !== undefined,
    create: (input: ProfileInput): Profile =>
      sql.transaction(() => {
        const name = cleanName(input.name);
        assertNameFree(name, null);
        const p: Profile = { id: newId(), name, avatar: input.avatar ?? null, prefs: normalizePrefs(input.prefs ?? DEFAULT_PREFS) };
        insert.run(p.id, p.name, p.avatar, JSON.stringify(p.prefs), now());
        return p;
      })(),
    /** Fields left out of the input keep their value; name is required by the contract. */
    update: (id: string, input: ProfileInput): Profile =>
      sql.transaction(() => {
        const r = one.get(id) as ProfileRow | undefined;
        if (!r) throw notFound('profile');
        const name = cleanName(input.name);
        assertNameFree(name, id);
        const current = toProfile(r);
        const p: Profile = {
          id,
          name,
          avatar: input.avatar === undefined ? (current.avatar ?? null) : input.avatar,
          prefs: input.prefs ? normalizePrefs(input.prefs) : current.prefs,
        };
        update.run(p.name, p.avatar, JSON.stringify(p.prefs), id);
        return p;
      })(),
    /** Removes the profile and all its watch state in one transaction (not relying on FK cascades). */
    remove: (id: string): void =>
      sql.transaction(() => {
        if (exists.get(id) === undefined) throw notFound('profile');
        for (const d of deletes) d.run(id);
        deleteProfile.run(id);
      })(),
  };
}

export type ProfileStore = ReturnType<typeof createProfileStore>;
