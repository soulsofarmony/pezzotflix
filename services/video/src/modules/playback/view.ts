// PlaybackSession response (doc 03 §4.3) built from the plan and the StreamHandle: tracks from the
// file's facts, subtitle urls and availability from the handle's locators (ADR 0003 D12).
import type { components } from '../../contract/schema.d.ts';
import type { AudioStreamFacts, MediaFacts, SubtitleStreamFacts } from '../../shared/media-facts.ts';
import { streamTrackId } from '../../shared/media-facts.ts';
import type { PlaybackPlan, SubtitleAvailability } from '../../shared/playback-plan.ts';
import type { ClientCapabilities, StreamHandle } from '../../shared/ports.ts';
import { exclusionsForFile, rendersFromStream, subtitleTracks } from './decision/index.ts';

type Schemas = components['schemas'];
export type PlaybackSessionView = Schemas['PlaybackSession'];
type Track = Schemas['Track'];
type SessionTrack = Schemas['SessionTrack'];

const SIDECAR_CODEC: Readonly<Record<string, string>> = { srt: 'subrip', ass: 'ass', ssa: 'ssa', vtt: 'webvtt', sup: 'hdmv_pgs_subtitle' };

const EMPTY = {
  profile: null,
  title: null,
  channels: null,
  channelLayout: null,
  lossless: null,
  objectAudio: null,
  width: null,
  height: null,
  frameRate: null,
  bitDepth: null,
  hdr: null,
  dolbyVision: null,
  subtitleKind: null,
} as const;

function audioTrack(a: AudioStreamFacts): Track {
  return {
    ...EMPTY,
    id: streamTrackId(a.index),
    type: 'audio',
    index: a.index,
    codec: a.codec,
    profile: a.profile,
    language: a.language,
    title: a.title,
    default: a.default,
    forced: a.forced,
    sdh: false,
    commentary: a.commentary,
    channels: a.channels,
    channelLayout: a.channelLayout,
    lossless: a.lossless,
    objectAudio: a.objectAudio,
    external: false,
  };
}

function embeddedSubtitleTrack(s: SubtitleStreamFacts): Track {
  return {
    ...EMPTY,
    id: streamTrackId(s.index),
    type: 'subtitle',
    index: s.index,
    codec: s.codec,
    profile: s.profile,
    language: s.language,
    title: s.title,
    default: s.default,
    forced: s.forced,
    sdh: s.sdh,
    commentary: false,
    subtitleKind: s.kind,
    external: false,
  };
}

/** Same shape as the catalog's MediaVersion tracks: a sidecar's index is its position among the sidecars. */
function sidecarTrack(facts: MediaFacts, i: number): Track {
  const x = facts.sidecars[i]!;
  return {
    ...EMPTY,
    id: x.id,
    type: 'subtitle',
    index: i,
    codec: SIDECAR_CODEC[x.format] ?? x.format,
    language: x.language,
    default: false,
    forced: x.forced,
    sdh: x.sdh,
    commentary: false,
    subtitleKind: x.format === 'sup' ? 'image' : 'text',
    external: true,
  };
}

export interface SessionViewInput {
  sessionId: string;
  itemId: string;
  facts: MediaFacts;
  itemDurationMs: number | null;
  capabilities: ClientCapabilities;
  plan: PlaybackPlan;
  handle: StreamHandle;
  /** Subtitle selected by a local switch since the plan; undefined: the plan's own selection. */
  subtitleSelected: string | null | undefined;
  /** Latest availability from delivery's status, overriding the handle's. */
  availability: ReadonlyMap<string, SubtitleAvailability>;
  expiresAt: number;
  heartbeatIntervalMs: number;
}

export function sessionView(v: SessionViewInput): PlaybackSessionView {
  const { plan, handle, facts } = v;
  const selectedAudio = plan.audio?.source.trackId ?? null;
  const selectedSub = v.subtitleSelected === undefined ? (plan.subtitles.selected?.trackId ?? null) : v.subtitleSelected;
  const locators = new Map(handle.locators.subtitles.map((l) => [l.trackId, l]));
  const served = new Map(plan.subtitles.served.map((s) => [s.trackId, s]));
  const fromStream = new Set(
    plan.mode === 'direct_play' ? subtitleTracks(facts).filter((t) => rendersFromStream(t, v.capabilities, exclusionsForFile(plan.exclusions, plan.file.fileId), [])).map((t) => t.trackId) : [],
  );

  const audio: SessionTrack[] = facts.streams
    .filter((s): s is AudioStreamFacts => s.type === 'audio')
    .map((a) => ({ ...audioTrack(a), selected: streamTrackId(a.index) === selectedAudio, switchWithoutRestart: false }));

  const subtitleBase: Track[] = [
    ...facts.streams.filter((s): s is SubtitleStreamFacts => s.type === 'subtitle').map(embeddedSubtitleTrack),
    ...facts.sidecars.map((_x, i) => sidecarTrack(facts, i)),
  ];
  const subtitles: SessionTrack[] = subtitleBase.map((t) => {
    const loc = locators.get(t.id);
    const servedAs = served.get(t.id);
    const selected = t.id === selectedSub;
    const out: SessionTrack = { ...t, selected, switchWithoutRestart: false, url: null };
    if (servedAs) {
      out.delivery = servedAs.delivery;
      out.url = loc?.url ?? null;
      out.switchWithoutRestart = out.url !== null;
      const availability = v.availability.get(t.id) ?? loc?.availability;
      if (availability) out.availability = availability;
    } else if (selected && plan.subtitles.selected?.delivery === 'burned') {
      out.delivery = 'burned';
    } else if (fromStream.has(t.id)) {
      // A native player switches between tracks of the file it plays itself.
      out.delivery = 'embedded';
      out.switchWithoutRestart = true;
    }
    return out;
  });

  return {
    sessionId: v.sessionId,
    expiresAt: v.expiresAt,
    heartbeatIntervalMs: v.heartbeatIntervalMs,
    itemId: v.itemId,
    fileId: plan.file.fileId,
    mode: plan.mode,
    reasons: plan.reasons.map((r) => r.message),
    stream: {
      url: handle.locators.stream,
      protocol: handle.protocol,
      mimeType: handle.mimeType,
      startOffsetMs: 0,
      mediaTimestampOffsetMs: handle.mediaTimestampOffsetMs,
      bitrate: { peakBps: handle.bitrate.peakBps, averageBps: handle.bitrate.averageBps, audioBps: handle.bitrate.audioBps },
    },
    tracks: { audio, subtitles },
    resumePositionMs: plan.startPositionMs,
    durationMs: plan.file.durationMs ?? v.itemDurationMs ?? 0,
    chapters: facts.chapters.map((c) => ({ title: c.title, startMs: c.startMs, endMs: c.endMs })),
  };
}
