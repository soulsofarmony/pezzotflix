// Types of the contract used across the client, plus the hand-written strict types of PlaybackSession and
// Event (ADR 0004 point 2: no discriminated oneOf in v1, so the client narrows them itself).
// Enums are open (ADR 0004): every narrowing keeps a branch for unknown values.
import type { components } from './schema.d.ts';

type S = components['schemas'];

export type Id = S['Id'];
export type Problem = S['Problem'];
export type ServerInfo = S['ServerInfo'];
export type Profile = S['Profile'];
export type ProfileInput = S['ProfileInput'];
export type ProfilePrefs = S['ProfilePrefs'];
export type ProfileSelection = S['ProfileSelection'];
export type ItemKind = S['ItemKind'];
export type ItemSummary = S['ItemSummary'];
export type ItemDetail = S['ItemDetail'];
export type ItemPage = S['ItemPage'];
export type ImageRef = S['ImageRef'];
export type HomeRow = S['HomeRow'];
export type Home = S['Home'];
export type Track = S['Track'];
export type MediaVersion = S['MediaVersion'];
export type Chapter = S['Chapter'];
export type Credit = S['Credit'];
export type ClientCapabilities = S['ClientCapabilities'];
export type StartPlaybackRequest = S['StartPlaybackRequest'];
export type ChangeTracksRequest = S['ChangeTracksRequest'];
export type ChangeVersionRequest = S['ChangeVersionRequest'];
export type FallbackRequest = S['FallbackRequest'];
export type ProgressReport = S['ProgressReport'];
export type ActiveSession = S['ActiveSession'];
export type PlaybackPlanExplanation = S['PlaybackPlanExplanation'];
export type ExplainRequest = S['ExplainRequest'];
export type LibraryRoot = S['LibraryRoot'];
export type IngestStatus = S['IngestStatus'];
export type IdentificationCase = S['IdentificationCase'];
export type CasePage = S['CasePage'];
export type Candidate = S['Candidate'];
export type ResolveCaseRequest = S['ResolveCaseRequest'];
export type ProviderSearchResult = S['ProviderSearchResult'];
export type MediaFileDetails = S['MediaFileDetails'];
export type RawPlaybackSession = S['PlaybackSession'];
export type RawSessionTrack = S['SessionTrack'];
export type RawEvent = S['Event'];
export type EventPage = S['EventPage'];

export type DeliveryMode = 'direct_play' | 'direct_stream' | 'transcode';
export type Suspect = 'container' | 'video' | 'audio' | 'subtitle' | 'unknown';
export type SubtitleDelivery = 'embedded' | 'sidecar' | 'burned' | 'client_render';
export type SubtitleAvailability = 'complete' | 'growing';

/** A session track after normalization: optional flags made explicit. */
export interface SessionTrack {
  id: string;
  type: 'audio' | 'subtitle' | 'video' | (string & {});
  index: number;
  codec: string | null;
  language: string | null;
  title: string | null;
  default: boolean;
  forced: boolean;
  sdh: boolean;
  commentary: boolean;
  channels: number | null;
  channelLayout: string | null;
  objectAudio: string | null;
  subtitleKind: 'text' | 'image' | null;
  selected: boolean;
  switchWithoutRestart: boolean;
  /** Unknown delivery values become null: the client then treats the track as not switchable locally. */
  delivery: SubtitleDelivery | null;
  url: string | null;
  /** Only for tracks served separately; absent means complete. */
  availability: SubtitleAvailability;
}

interface StreamBase {
  url: string;
  mimeType: string | null;
  /** Constant PTS offset of the media timestamps (ADR 0003); absent means 0. */
  mediaTimestampOffsetMs: number;
  bitrate: { peakBps: number | null; averageBps: number | null; audioBps: number | null };
}
export interface ProgressiveStream extends StreamBase {
  protocol: 'progressive';
}
export interface HlsStream extends StreamBase {
  protocol: 'hls-fmp4';
}
export type Stream = ProgressiveStream | HlsStream;

/** PlaybackSession as the player uses it: strict protocol union, defaults applied. */
export interface PlaybackSession {
  sessionId: string;
  expiresAt: number;
  heartbeatIntervalMs: number;
  itemId: string | null;
  fileId: string | null;
  /** Open enum: an unknown mode is shown as is. */
  mode: DeliveryMode | (string & {});
  reasons: string[];
  stream: Stream;
  tracks: { audio: SessionTrack[]; subtitles: SessionTrack[] };
  resumePositionMs: number;
  durationMs: number;
  chapters: Chapter[];
}

export const DEFAULT_HEARTBEAT_MS = 10_000;

/** Thrown when a session uses a protocol this client does not know: no engine can play it. */
export class UnsupportedProtocolError extends Error {
  readonly protocol: string;
  constructor(protocol: string) {
    super(`unsupported stream protocol ${protocol}`);
    this.name = 'UnsupportedProtocolError';
    this.protocol = protocol;
  }
}

const DELIVERIES: ReadonlySet<string> = new Set(['embedded', 'sidecar', 'burned', 'client_render']);

function toTrack(t: RawSessionTrack): SessionTrack {
  return {
    id: t.id,
    type: t.type,
    index: t.index,
    codec: t.codec ?? null,
    language: t.language ?? null,
    title: t.title ?? null,
    default: t.default ?? false,
    forced: t.forced ?? false,
    sdh: t.sdh ?? false,
    commentary: t.commentary ?? false,
    channels: t.channels ?? null,
    channelLayout: t.channelLayout ?? null,
    objectAudio: t.objectAudio ?? null,
    subtitleKind: t.subtitleKind === 'text' || t.subtitleKind === 'image' ? t.subtitleKind : null,
    selected: t.selected,
    switchWithoutRestart: t.switchWithoutRestart,
    delivery: t.delivery && DELIVERIES.has(t.delivery) ? t.delivery : null,
    url: t.url ?? null,
    availability: t.availability === 'growing' ? 'growing' : 'complete',
  };
}

/** Narrows the generated PlaybackSession. Throws UnsupportedProtocolError for an unknown protocol. */
export function toPlaybackSession(raw: RawPlaybackSession): PlaybackSession {
  const protocol: string = raw.stream.protocol;
  if (protocol !== 'progressive' && protocol !== 'hls-fmp4') throw new UnsupportedProtocolError(protocol);
  const b = raw.stream.bitrate;
  const base: StreamBase = {
    url: raw.stream.url,
    mimeType: raw.stream.mimeType ?? null,
    mediaTimestampOffsetMs: raw.stream.mediaTimestampOffsetMs ?? 0,
    bitrate: { peakBps: b?.peakBps ?? null, averageBps: b?.averageBps ?? null, audioBps: b?.audioBps ?? null },
  };
  return {
    sessionId: raw.sessionId,
    expiresAt: raw.expiresAt,
    heartbeatIntervalMs: raw.heartbeatIntervalMs && raw.heartbeatIntervalMs > 0 ? raw.heartbeatIntervalMs : DEFAULT_HEARTBEAT_MS,
    itemId: raw.itemId ?? null,
    fileId: raw.fileId ?? null,
    mode: raw.mode,
    reasons: raw.reasons,
    stream: { ...base, protocol },
    tracks: { audio: raw.tracks.audio.map(toTrack), subtitles: raw.tracks.subtitles.map(toTrack) },
    resumePositionMs: raw.resumePositionMs,
    durationMs: raw.durationMs,
    chapters: raw.chapters,
  };
}

// ---------------------------------------------------------------- events

interface EventBase {
  seq: number;
  at: number;
}
export type AppEvent =
  | (EventBase & { type: 'library.item_added' | 'library.item_updated'; itemId: string | null })
  /** replacedBy: the item that took its place (a provisional item identified), or null. */
  | (EventBase & { type: 'library.item_removed'; itemId: string | null; replacedBy: string | null })
  | (EventBase & { type: 'ingest.progress' })
  | (EventBase & { type: 'identification.needs_review'; caseId: string | null })
  | (EventBase & { type: 'playback.session_terminated'; sessionId: string; reason: string | null })
  | (EventBase & { type: 'playback.subtitle_ready'; sessionId: string; trackId: string; availability: SubtitleAvailability })
  | (EventBase & { type: 'unknown'; rawType: string });

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Narrows a polled event by its type. Unknown types, or known types with an unusable payload, become 'unknown'. */
export function toAppEvent(raw: RawEvent): AppEvent {
  const base = { seq: raw.seq, at: raw.at };
  const p: Record<string, unknown> = raw.payload ?? {};
  const unknown = (): AppEvent => ({ ...base, type: 'unknown', rawType: raw.type });
  switch (raw.type) {
    case 'library.item_added':
    case 'library.item_updated':
      return { ...base, type: raw.type, itemId: str(p.itemId) };
    case 'library.item_removed':
      return { ...base, type: raw.type, itemId: str(p.itemId), replacedBy: str(p.replacedBy) };
    case 'ingest.progress':
      return { ...base, type: 'ingest.progress' };
    case 'identification.needs_review':
      return { ...base, type: 'identification.needs_review', caseId: str(p.caseId) };
    case 'playback.session_terminated': {
      const sessionId = str(p.sessionId);
      return sessionId ? { ...base, type: 'playback.session_terminated', sessionId, reason: str(p.reason) } : unknown();
    }
    case 'playback.subtitle_ready': {
      const sessionId = str(p.sessionId);
      const trackId = str(p.trackId);
      if (!sessionId || !trackId) return unknown();
      return { ...base, type: 'playback.subtitle_ready', sessionId, trackId, availability: p.availability === 'growing' ? 'growing' : 'complete' };
    }
    default:
      return unknown();
  }
}
