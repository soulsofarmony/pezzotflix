// Audio: track choice (doc 04 §3.1, P1 quality first) and the quality ladder (doc 04 §4.3, ADR 0003 D11).
import { normalizeLanguageTag } from '../../../shared/languages.ts';
import { type AudioStreamFacts, type MediaFacts, streamTrackId } from '../../../shared/media-facts.ts';
import type { AudioAction, AudioSource, PlanExclusion, PlanReason } from '../../../shared/playback-plan.ts';
import type { ClientCapabilities, ProfilePlaybackPrefs } from '../../../shared/ports.ts';
import { aacWithPce, audioToken, clientDecodesAudio, clientHasMultichannelLossy } from './caps.ts';
import { audioName, channelsName, codecName, exclusionMessage, outputName, reason } from './reasons.ts';

/** The audio track a selection asks for on a file (resolve.ts); hard only for an explicit choice on its own file. */
export interface AudioIntent {
  track: AudioStreamFacts;
  hard: boolean;
}

/** ADR 0003 D11 bitrates; stereo ones are delivery-neutral defaults for a stereo client. */
export const AUDIO_BITRATES = { eac3: 640_000, aac51: 640_000, opus51: 448_000, aac20: 192_000, opus20: 128_000 } as const;

export interface AudioPick {
  track: AudioStreamFacts;
  source: AudioSource;
  action: AudioAction;
  /** What happens to the audio in Direct Stream / Transcode (copy, conversion, downmix). */
  actionReasons: PlanReason[];
  /** Steps skipped because an earlier failure excluded them, and tracks skipped for lack of a format. */
  skipReasons: PlanReason[];
}

export type AudioOutcome =
  | { kind: 'none' }
  | { kind: 'ok'; pick: AudioPick }
  | { kind: 'unsupported'; reasons: PlanReason[] };

export const audioStreams = (facts: MediaFacts): AudioStreamFacts[] =>
  facts.streams.filter((s): s is AudioStreamFacts => s.type === 'audio');

export const audioSourceOf = (a: AudioStreamFacts): AudioSource => ({
  streamIndex: a.index,
  trackId: streamTrackId(a.index),
  codec: a.codec,
  profile: a.profile,
  language: a.language,
  channels: a.channels,
  channelLayout: a.channelLayout,
  sampleRate: a.sampleRate,
  bitRate: a.bitRate,
});

/** Commentaries and audio descriptions are never a main track (audioDescription absent in older facts). */
export const isDemoted = (a: AudioStreamFacts): boolean => a.commentary || a.audioDescription === true;

export interface RankOptions {
  /** The client copies this track (minimal conversion, P1): preferred at equal quality. */
  copies?: (a: AudioStreamFacts) => boolean;
  /** A remembered language ranked before the profile's (TrackSelection.audioLanguage). */
  language?: string;
}

/**
 * Quality order within a language (P1): commentary and audio description last, lossless first, more
 * channels, object audio, then the track the client copies, then the default flag.
 */
function qualityOrder(copies: (a: AudioStreamFacts) => boolean) {
  return (a: AudioStreamFacts, b: AudioStreamFacts): number =>
    Number(isDemoted(a)) - Number(isDemoted(b)) ||
    Number(b.lossless) - Number(a.lossless) ||
    b.channels - a.channels ||
    Number(b.objectAudio !== null) - Number(a.objectAudio !== null) ||
    Number(copies(b)) - Number(copies(a)) ||
    Number(b.default) - Number(a.default) ||
    a.index - b.index;
}

/**
 * Tracks in the order they are tried: main tracks of each preferred language in turn, then the other
 * main tracks (default first), then commentaries and audio descriptions. Within each group the best
 * quality comes first.
 */
export function rankAudio(tracks: readonly AudioStreamFacts[], prefs: ProfilePlaybackPrefs, o: RankOptions = {}): AudioStreamFacts[] {
  const order = qualityOrder(o.copies ?? (() => false));
  const wanted = o.language === undefined ? prefs.audioLanguages : [o.language, ...prefs.audioLanguages];
  const langs = [...new Set(wanted.map((l) => normalizeLanguageTag(l)).filter((l): l is string => l !== null))];
  const main = tracks.filter((t) => !isDemoted(t));
  const out: AudioStreamFacts[] = [];
  for (const lang of langs) out.push(...main.filter((t) => t.language === lang).sort(order));
  const rest = main.filter((t) => !out.includes(t)).sort((a, b) => Number(b.default) - Number(a.default) || order(a, b));
  out.push(...rest, ...tracks.filter(isDemoted).sort(order));
  return out;
}

const isExcluded = (ex: readonly PlanExclusion[], match: (e: PlanExclusion) => boolean): PlanExclusion | undefined => ex.find(match);

type Step = { action: AudioAction; skipped: PlanReason[] } | { action: null; skipped: PlanReason[] };

/**
 * The first step of the ladder the client accepts and no failure excluded (doc 04 §4.3):
 * copy → FLAC at the source channels → E-AC-3 5.1 (if declared) → AAC 5.1 → Opus 5.1 → stereo, the
 * last only when the client has no multichannel lossy output or the source is stereo.
 */
export function audioLadder(a: AudioStreamFacts, caps: ClientCapabilities, exclusions: readonly PlanExclusion[]): Step {
  const skipped: PlanReason[] = [];
  const token = audioToken(a);
  const tryStep = (accepts: boolean, match: (e: PlanExclusion) => boolean): boolean => {
    if (!accepts) return false;
    const ex = isExcluded(exclusions, match);
    if (ex) {
      skipped.push(reason('format_excluded', 'audio', exclusionMessage(ex)));
      return false;
    }
    return true;
  };
  const convertExcluded = (codec: string) => (e: PlanExclusion) => e.dimension === 'audio' && e.action === 'convert' && e.codec === codec;

  // A copy exclusion names codec and profile: excluding a DTS-HD MA copy leaves the DTS core alone.
  const copyExcluded = (e: PlanExclusion) => e.dimension === 'audio' && e.action === 'copy' && e.codec === a.codec && e.profile === a.profile;
  if (tryStep(clientDecodesAudio(caps, token, a.channels) && !aacWithPce(a), copyExcluded)) {
    return { action: { kind: 'copy' }, skipped };
  }
  if (tryStep(clientDecodesAudio(caps, 'flac', a.channels), convertExcluded('flac'))) {
    return { action: { kind: 'convert', codec: 'flac', channels: a.channels, bitrateBps: null, layout: null }, skipped };
  }
  if (a.channels > 2) {
    if (tryStep(clientDecodesAudio(caps, 'eac3', 6), convertExcluded('eac3'))) {
      return { action: { kind: 'convert', codec: 'eac3', channels: 6, bitrateBps: AUDIO_BITRATES.eac3, layout: '5.1' }, skipped };
    }
    if (tryStep(clientDecodesAudio(caps, 'aac', 6), convertExcluded('aac'))) {
      return { action: { kind: 'convert', codec: 'aac', channels: 6, bitrateBps: AUDIO_BITRATES.aac51, layout: '5.1' }, skipped };
    }
    if (tryStep(clientDecodesAudio(caps, 'opus', 6), convertExcluded('opus'))) {
      return { action: { kind: 'convert', codec: 'opus', channels: 6, bitrateBps: AUDIO_BITRATES.opus51, layout: '5.1' }, skipped };
    }
  }
  // Stereo only for a stereo source or a client that is stereo (ADR 0003 D11).
  if (a.channels <= 2 || !clientHasMultichannelLossy(caps)) {
    if (tryStep(clientDecodesAudio(caps, 'aac', 2), convertExcluded('aac'))) {
      return { action: { kind: 'convert', codec: 'aac', channels: 2, bitrateBps: AUDIO_BITRATES.aac20, layout: 'stereo' }, skipped };
    }
    if (tryStep(clientDecodesAudio(caps, 'opus', 2), convertExcluded('opus'))) {
      return { action: { kind: 'convert', codec: 'opus', channels: 2, bitrateBps: AUDIO_BITRATES.opus20, layout: 'stereo' }, skipped };
    }
  }
  return { action: null, skipped };
}

function actionReasons(a: AudioStreamFacts, action: AudioAction): PlanReason[] {
  if (action.kind === 'copy') return [reason('audio_copy', 'audio', `Audio ${audioName(a)} copied`)];
  const why = aacWithPce(a) ? 'has no standard AAC channel configuration (PCE)' : 'is not decoded by the client';
  const out = [reason('audio_converted', 'audio', `Audio ${audioName(a)} ${why}: converted to ${outputName(action)}`)];
  if (action.channels < a.channels) {
    out.push(reason('audio_downmixed', 'audio', `Audio ${channelsName(a.channels)} downmixed to ${channelsName(action.channels)} for ${codecName(action.codec)}`));
  }
  return out;
}

/**
 * The audio track and its action (doc 04 §3.1). A hard choice is honoured or fails. A remembered one
 * is tried first unless it is a commentary or an audio description, then the ranking. Otherwise the
 * best track in the preferred language, and only when no step of the ladder serves it, the next (P1).
 */
export function chooseAudio(
  facts: MediaFacts,
  caps: ClientCapabilities,
  prefs: ProfilePlaybackPrefs,
  intent: AudioIntent | null,
  exclusions: readonly PlanExclusion[],
  language?: string,
): AudioOutcome {
  const tracks = audioStreams(facts);
  if (tracks.length === 0) return { kind: 'none' };
  const copies = (t: AudioStreamFacts): boolean => audioLadder(t, caps, exclusions).action?.kind === 'copy';
  const ranked = rankAudio(tracks, prefs, { copies, ...(language === undefined ? {} : { language }) });
  const order = !intent ? ranked : intent.hard ? [intent.track] : isDemoted(intent.track) ? ranked : [intent.track, ...ranked.filter((t) => t !== intent.track)];
  const skipReasons: PlanReason[] = [];
  for (const track of order) {
    const step = audioLadder(track, caps, exclusions);
    skipReasons.push(...step.skipped);
    if (step.action) {
      return { kind: 'ok', pick: { track, source: audioSourceOf(track), action: step.action, actionReasons: actionReasons(track, step.action), skipReasons } };
    }
    skipReasons.push(reason('audio_unsupported', 'audio', `Audio ${audioName(track)}: no audio format the client plays`));
  }
  return { kind: 'unsupported', reasons: skipReasons };
}

/** Estimated bitrate of the audio as served, for the Transcode VBV budget (doc 05 §7.8.4 table). */
export function servedAudioBps(pick: AudioPick | null): number {
  if (!pick) return 0;
  const { action, track } = pick;
  if (action.kind === 'convert') return action.bitrateBps ?? 750_000 * action.channels;
  return track.bitRate ?? (track.lossless ? 750_000 * track.channels : 640_000);
}
