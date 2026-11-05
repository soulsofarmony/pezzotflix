// Track ids are file-local (s<index>, x:<id>): a choice made on one version is applied to another by
// its descriptor (orchestrator decision E1, doc 04 §3.1 steps 1–2).
import type { AudioStreamFacts, MediaFacts } from '../../../shared/media-facts.ts';
import { streamTrackId } from '../../../shared/media-facts.ts';
import type { PlayableFile } from '../../../shared/ports.ts';
import { type AudioIntent, audioStreams } from './audio.ts';
import { audioToken } from './caps.ts';
import { type SubtitleIntent, type SubtitleTrack, subtitleTracks } from './subtitles.ts';
import type { TrackPick, TrackSelection } from './types.ts';

export interface ResolvedSelection {
  audio: AudioIntent | null;
  subtitle: SubtitleIntent | null;
}

const audioById = (facts: MediaFacts, id: string): AudioStreamFacts | undefined => audioStreams(facts).find((a) => streamTrackId(a.index) === id);
const subtitleById = (facts: MediaFacts, id: string): SubtitleTrack | undefined => subtitleTracks(facts).find((x) => x.trackId === id);

const sameAudio = (a: AudioStreamFacts, b: AudioStreamFacts): boolean =>
  a.language === b.language &&
  audioToken(a) === audioToken(b) &&
  a.channels === b.channels &&
  a.commentary === b.commentary &&
  (a.audioDescription === true) === (b.audioDescription === true);

const sameSubtitle = (a: SubtitleTrack, b: SubtitleTrack): boolean =>
  a.language === b.language && a.codec === b.codec && a.forced === b.forced && a.sdh === b.sdh && a.commentary === b.commentary;

const ownFile = (pick: { fileId: string | null }, file: PlayableFile): boolean => pick.fileId === null || pick.fileId === file.fileId;

function resolveAudio(file: PlayableFile, files: readonly PlayableFile[], pick: TrackPick | undefined): AudioIntent | null {
  if (!pick) return null;
  if (ownFile(pick, file)) {
    const t = audioById(file.facts, pick.trackId);
    return t ? { track: t, hard: pick.strength === 'explicit' } : null;
  }
  const source = files.find((f) => f.fileId === pick.fileId);
  const src = source ? audioById(source.facts, pick.trackId) : undefined;
  const match = src ? audioStreams(file.facts).find((x) => sameAudio(x, src)) : undefined;
  return match ? { track: match, hard: false } : null;
}

function resolveSubtitle(file: PlayableFile, files: readonly PlayableFile[], pick: TrackPick<string | null> | undefined): SubtitleIntent | null {
  if (!pick) return null;
  const own = ownFile(pick, file);
  if (pick.trackId === null) return { track: null, hard: own && pick.strength === 'explicit' };
  if (own) {
    const t = subtitleById(file.facts, pick.trackId);
    return t ? { track: t, hard: pick.strength === 'explicit' } : null;
  }
  const source = files.find((f) => f.fileId === pick.fileId);
  const src = source ? subtitleById(source.facts, pick.trackId) : undefined;
  const match = src ? subtitleTracks(file.facts).find((x) => sameSubtitle(x, src)) : undefined;
  return match ? { track: match, hard: false } : null;
}

/**
 * What the selection means on `file`: on the file a pick belongs to (or any file, fileId null) the
 * id itself; on another file the track with the same descriptor, as a remembered choice. Nothing
 * found: null, so the prefs decide.
 */
export function resolveSelection(file: PlayableFile, files: readonly PlayableFile[], sel: TrackSelection): ResolvedSelection {
  return { audio: resolveAudio(file, files, sel.audio), subtitle: resolveSubtitle(file, files, sel.subtitle) };
}
