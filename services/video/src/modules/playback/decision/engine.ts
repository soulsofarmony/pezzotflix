// Playback Decision Engine (doc 02 §3.9, doc 03 §8, doc 04 §3–§4): pure, no I/O. For each candidate
// file it picks the tracks, evaluates every dimension against the capabilities, takes the lightest
// mode that works, then picks the file (no video transcode, highest quality, lighter mode).
import type { HdrFormat, MediaFacts, VideoStreamFacts } from '../../../shared/media-facts.ts';
import {
  type DeliveryMode,
  type DirectPlayPlan,
  type DirectStreamPlan,
  type DolbyVisionHandling,
  type PlanExclusion,
  type PlanFile,
  type PlanReason,
  type PlanSubtitles,
  PLAN_VERSION,
  type PlaybackPlan,
  type ServedSubtitle,
  type TranscodeCause,
  type TranscodePlan,
  type VideoSource,
} from '../../../shared/playback-plan.ts';
import type { ClientCapabilities, PlayableFile } from '../../../shared/ports.ts';
import { type AudioOutcome, type AudioPick, audioStreams, chooseAudio, servedAudioBps } from './audio.ts';
import { resolveSelection } from './resolve.ts';
import {
  audioToken,
  clientPlaysContainer,
  clientPlaysDolbyVision,
  clientPresentsHdr,
  displayIsSdr,
  h264Output,
  hasProtocol,
  isBrowser,
  selectsTracks,
  videoFit,
} from './caps.ts';
import { codecName, containerName, exclusionMessage, modeName, reason, subtitleName, uniqueReasons, videoName } from './reasons.ts';
import { burnExcluded, chooseSubtitle, exclusionsForFile, rendersFromStream, servedFor, servedReason, type SubtitleChoice, subtitleTracks } from './subtitles.ts';
import type { CandidateOutcome, DecideInput, Decision } from './types.ts';

type CopyMode = 'direct_play' | 'direct_stream';

/** P2: the software Transcode takes sources up to 1080p only. */
export const TRANSCODE_MAX_WIDTH = 1920;
export const TRANSCODE_MAX_HEIGHT = 1080;
/** Three automatic attempts per StartPlayback, re-plans and restarts together (doc 04 §8, ADR 0003 D7). */
export const MAX_AUTOMATIC_ATTEMPTS = 3;

const MODE_RANK: Readonly<Record<DeliveryMode, number>> = { direct_play: 0, direct_stream: 1, transcode: 2 };
/** S2 d1–d3: the only audio codecs measured in a browser's MKV Direct Play (doc 04 §4.1). */
const MKV_DIRECT_PLAY_AUDIO: ReadonlySet<string> = new Set(['aac', 'ac3', 'eac3']);

const isUpTo1080p = (v: VideoStreamFacts): boolean => v.width <= TRANSCODE_MAX_WIDTH && v.height <= TRANSCODE_MAX_HEIGHT;

const mbps = (bps: number): string => `${Math.round(bps / 100_000) / 10} Mb/s`;

// ---------------------------------------------------------------- per-file evaluation

interface VideoCopyCheck {
  /** Why the bitstream cannot be served as is (Direct Stream and Direct Play). */
  blockers: PlanReason[];
  /** Extra reasons that only stop Direct Play (DV in the browser). */
  directPlayBlockers: PlanReason[];
  causes: TranscodeCause[];
  dolbyVision: DolbyVisionHandling;
  /** What the client presents when the stream is copied: drives the P5 reason and the version quality. */
  presented: HdrFormat;
  /** What a copy does to the video, per mode (the hvc1 tag exists in Direct Stream only). */
  actionReasons: Record<CopyMode, PlanReason[]>;
}

/** Base-layer format of a DV stream for a client without DV (analyzer hdrFallback), or null (P5). */
function dvBase(v: VideoStreamFacts): HdrFormat | null {
  for (const f of ['HDR10', 'HLG', 'SDR'] as const) if (v.hdrFallback.includes(f) || (f === 'HDR10' && v.hdrFallback.includes('HDR10+'))) return f;
  return null;
}

function checkVideoCopy(v: VideoStreamFacts, caps: ClientCapabilities): VideoCopyCheck {
  const blockers: PlanReason[] = [];
  const directPlayBlockers: PlanReason[] = [];
  const causes: TranscodeCause[] = [];
  const both: PlanReason[] = [];
  const dsOnly: PlanReason[] = [];
  let dolbyVision: DolbyVisionHandling = 'none';
  let presented: HdrFormat = v.hdr;

  const fit = videoFit(caps, v);
  if (!fit.ok) {
    if (fit.why === 'resolution') {
      const max = fit.cap ? `${fit.cap.maxWidth ?? '?'}×${fit.cap.maxHeight ?? '?'}` : 'the client maximum';
      blockers.push(reason('video_resolution_exceeded', 'video', `Video ${v.width}×${v.height} above the client maximum ${max}`));
      causes.push('resolution');
    } else {
      const detail =
        fit.why === 'bit_depth'
          ? ` at ${v.bitDepth ?? '?'} bit`
          : fit.why === 'frame_rate'
            ? ` at ${v.frameRate ?? '?'} fps`
            : '';
      blockers.push(reason('video_codec_unsupported', 'video', `Video ${videoName(v)}${detail} is not decoded by the client`));
      causes.push('codec');
    }
  }

  const dv = v.hdr === 'DV' ? v.dolbyVision : null;
  // A native player (audioTrackSelection, the caps.ts proxy) without DV decodes the base layer of the
  // file and ignores the DV layers; browsers are not measured on that (S2 H3, doc 04 §4.1–4.2).
  const native = selectsTracks(caps);
  const tag = v.codec === 'hevc' ? ' with hvc1' : '';
  if (dv && clientPlaysDolbyVision(caps, dv.profile, dv.blCompatId)) {
    dolbyVision = 'keep_rpu';
  } else if (dv) {
    if (!native) {
      directPlayBlockers.push(reason('dv_direct_play_unmeasured', 'video', `Dolby Vision profile ${dv.profile}: no Direct Play on a client without Dolby Vision`));
    }
    const base = dvBase(v);
    if (base === null) {
      blockers.push(reason('dv_p5_transcode', 'video', `Dolby Vision profile ${dv.profile} has no compatible base layer: it needs a Transcode`));
      causes.push('dv_p5');
      presented = 'SDR';
    } else if (!clientPresentsHdr(caps, base)) {
      blockers.push(reason('hdr_tonemap', 'video', `Dolby Vision base layer ${base} is not presented by the client: it needs tone-mapping`));
      causes.push('hdr_tonemap');
      presented = 'SDR';
    } else {
      presented = base;
      if (native) {
        dolbyVision = 'keep_rpu';
        both.push(reason('dv_base_layer', 'video', `Dolby Vision ${dv.profile}.${dv.blCompatId}: the client plays the ${base} base layer and ignores the Dolby Vision layers`));
      } else if (dv.profile === 7 && v.codec === 'hevc') {
        dolbyVision = 'remove_dovi';
        dsOnly.push(reason('dv_p7_remove_dovi', 'video', 'Dolby Vision profile 7: DV layers removed without re-encoding, served as HDR10 with hvc1 (provisional, H11)'));
      } else {
        dolbyVision = 'keep_rpu';
        dsOnly.push(reason('dv_p81_as_hdr10', 'video', `Dolby Vision ${dv.profile}.${dv.blCompatId} served as ${base}${tag}, RPU kept`));
      }
    }
  } else if (!clientPresentsHdr(caps, v.hdr)) {
    blockers.push(reason('hdr_tonemap', 'video', `${v.hdr} is not presented by the client: it needs tone-mapping`));
    causes.push('hdr_tonemap');
    presented = 'SDR';
  }
  if (presented !== 'SDR' && presented !== 'DV' && blockers.every((b) => b.code !== 'hdr_tonemap') && displayIsSdr(caps)) {
    // P5: displayHdr false changes the reason only, never the plan.
    const who = isBrowser(caps) ? 'browser' : 'client';
    both.push(reason('hdr_client_conversion', 'video', `${presented} on an SDR display: conversion left to the ${who}`));
  }
  return { blockers, directPlayBlockers, causes, dolbyVision, presented, actionReasons: { direct_play: both, direct_stream: [...dsOnly, ...both] } };
}

/** Sum of the known audio track rates (unknown ones count 0). */
const audioTotalBps = (facts: MediaFacts): number => audioStreams(facts).reduce((n, a) => n + (a.bitRate ?? 0), 0);

/** Video rate, or file rate minus the audio tracks when the stream has none (E3); null when unknown. */
function videoRateOf(v: VideoStreamFacts, facts: MediaFacts): number | null {
  if (v.bitRate !== null) return v.bitRate;
  return facts.bitRate === null ? null : Math.max(0, facts.bitRate - audioTotalBps(facts));
}

const modeExclusion = (ex: readonly PlanExclusion[], fileId: string, mode: DeliveryMode): PlanExclusion | undefined =>
  ex.find((e) => (e.dimension === 'video' || e.dimension === 'container') && e.fileId === fileId && e.mode === mode);

interface TranscodeCheck {
  blockers: PlanReason[];
  width: number;
  height: number;
}

const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2);

function checkTranscode(v: VideoStreamFacts, file: PlayableFile, input: DecideInput): TranscodeCheck {
  const { capabilities: caps, constraints } = input;
  const blockers: PlanReason[] = [];
  if (!isUpTo1080p(v)) {
    blockers.push(reason('transcode_limited', 'video', `Source ${v.width}×${v.height} above 1080p: a Transcode would be needed and is not available for it (P2)`));
  }
  if (constraints.transcode === 'disabled') blockers.push(reason('transcode_disabled', 'video', 'A Transcode would be needed and is disabled (MAX_TRANSCODES = 0)'));
  if (constraints.transcode === 'busy') blockers.push(reason('transcode_disabled', 'video', 'A Transcode would be needed and every transcode slot is taken (P4)'));
  if (!hasProtocol(caps, 'hls-fmp4')) blockers.push(reason('container_unsupported', 'container', 'The client does not play HLS fMP4'));
  const out = h264Output(caps, v.frameRate);
  if (!out) blockers.push(reason('video_codec_unsupported', 'video', 'The client declares no H.264 decoder for a Transcode'));
  const excluded = modeExclusion(input.exclusions, file.fileId, 'transcode');
  if (excluded) blockers.push(reason('format_excluded', excluded.dimension, exclusionMessage(excluded)));

  const maxW = Math.min(TRANSCODE_MAX_WIDTH, out?.maxWidth ?? TRANSCODE_MAX_WIDTH);
  const maxH = Math.min(TRANSCODE_MAX_HEIGHT, out?.maxHeight ?? TRANSCODE_MAX_HEIGHT);
  const scale = Math.min(1, maxW / Math.max(1, v.width), maxH / Math.max(1, v.height));
  return { blockers, width: even(v.width * scale), height: even(v.height * scale) };
}

type SubtitleTreatment =
  | { kind: 'off' }
  | { kind: 'embedded' }
  | { kind: 'served'; served: ServedSubtitle }
  | { kind: 'burn' }
  | { kind: 'drop'; why: string };

interface Outcome {
  plan: PlaybackPlan;
  /** Video quality served, for the version choice: pixels, HDR kept, bit depth. */
  pixels: number;
  hdrKept: number;
  bitDepth: number;
  audioLossless: number;
  audioChannels: number;
  /** Video rate served: the last quality criterion. */
  videoBitRate: number;
  label: string;
}

interface FileEvaluation {
  file: PlayableFile;
  outcome: Outcome | null;
  /** Why no mode works (outcome null) or, for a playable file, the plan's reasons. */
  reasons: PlanReason[];
  /** An explicitly chosen subtitle track the plan cannot show. */
  droppedSubtitle: string | null;
}

function versionLabel(v: VideoStreamFacts): string {
  return `${v.height}p ${codecName(v.codec)}${v.hdr !== 'SDR' ? ` ${v.hdr}` : ''}`;
}

function planFile(f: PlayableFile): PlanFile {
  return {
    fileId: f.fileId,
    location: { ...f.facts.location },
    sizeBytes: f.facts.sizeBytes,
    mtimeMs: f.facts.mtimeMs,
    container: f.facts.container,
    durationMs: f.facts.durationMs,
  };
}

function videoSource(v: VideoStreamFacts): VideoSource {
  return {
    streamIndex: v.index,
    codec: v.codec,
    profile: v.profile,
    width: v.width,
    height: v.height,
    frameRate: v.frameRate,
    bitDepth: v.bitDepth,
    hdr: v.hdr,
    dolbyVisionProfile: v.dolbyVision?.profile ?? null,
    bitRate: v.bitRate,
  };
}

const clampPosition = (ms: number, durationMs: number | null): number =>
  Math.round(Math.max(0, durationMs === null ? ms : Math.min(ms, durationMs)));

function evaluateFile(file: PlayableFile, input: DecideInput): FileEvaluation {
  const { capabilities: caps, exclusions } = input;
  const facts = file.facts;
  const v = facts.streams.find((s): s is VideoStreamFacts => s.type === 'video' && !s.attachedPic);
  if (!v) return { file, outcome: null, reasons: [reason('video_codec_unsupported', 'video', 'The file has no video stream')], droppedSubtitle: null };

  // Tracks.
  const intent = resolveSelection(file, input.files, input.selection);
  const audio: AudioOutcome = chooseAudio(facts, caps, input.prefs, intent.audio, exclusions, input.selection.audioLanguage);
  const pick: AudioPick | null = audio.kind === 'ok' ? audio.pick : null;
  const subs = subtitleTracks(facts);
  const subEx = exclusionsForFile(exclusions, file.fileId);
  const skippedSub: PlanReason[] = [];
  const servedAll = subs.map((t) => servedFor(t, caps, subEx, skippedSub)).filter((s): s is ServedSubtitle => s !== null);
  const choice: SubtitleChoice | null = chooseSubtitle(subs, caps, input.prefs, intent.subtitle, pick?.track.language ?? null);

  // Dimensions.
  const copy = checkVideoCopy(v, caps);
  const tc = checkTranscode(v, file, input);
  const audioBlockers = audio.kind === 'unsupported' ? audio.reasons : [];

  // Bitrate limit (doc 04 §4.5, E3): Direct Play sends the whole file, Direct Stream the video and
  // the one audio track as served.
  const limit = caps.limits?.maxBitrate;
  const videoRate = videoRateOf(v, facts);
  const fileRate = facts.bitRate ?? (v.bitRate === null ? null : v.bitRate + audioTotalBps(facts));
  const dsRate = videoRate === null ? null : videoRate + servedAudioBps(pick);
  const over = (rate: number | null): rate is number => limit !== undefined && rate !== null && rate > limit;
  const dpBitrate = over(fileRate) ? [reason('video_bitrate_exceeded', 'video', `File bitrate ${mbps(fileRate)} above the client limit ${mbps(limit!)}`)] : [];
  const dsBitrate = over(dsRate) ? [reason('video_bitrate_exceeded', 'video', `Video and audio bitrate ${mbps(dsRate)} above the client limit ${mbps(limit!)}`)] : [];

  // Subtitle treatment: burn-in needs a Transcode, so it depends on whether one is possible.
  const selectedServed = choice ? (servedAll.find((s) => s.trackId === choice.track.trackId) ?? null) : null;
  const burnBlock = choice ? burnExcluded(choice.track, subEx) : undefined;
  let burnDrop: string | null = null;
  if (choice && !selectedServed) {
    if (burnBlock) burnDrop = exclusionMessage(burnBlock);
    else if (tc.blockers.length > 0) burnDrop = tc.blockers.map((b) => b.message).join('; ');
  }
  const treatment = (mode: DeliveryMode): SubtitleTreatment => {
    if (!choice) return { kind: 'off' };
    if (mode === 'direct_play' && rendersFromStream(choice.track, caps, subEx, skippedSub)) return { kind: 'embedded' };
    if (selectedServed) return { kind: 'served', served: selectedServed };
    return burnDrop === null ? { kind: 'burn' } : { kind: 'drop', why: burnDrop };
  };
  const subName = choice ? subtitleName(choice.track.codec, choice.track.language) : '';
  const burnBlocker = reason('subtitle_burn_in', 'subtitle', `Subtitles ${subName} cannot be rendered by the client: burn-in needs a Transcode`);

  // Direct Play.
  const dp: PlanReason[] = [];
  if (!hasProtocol(caps, 'progressive')) dp.push(reason('container_unsupported', 'container', 'The client does not play progressive files'));
  if (!clientPlaysContainer(caps, facts.container)) {
    dp.push(reason('container_unsupported', 'container', `${containerName(facts.container)} is not played directly by the client: remux to fMP4`));
  }
  const nAudio = audioStreams(facts).length;
  if (nAudio > 1 && !selectsTracks(caps)) {
    dp.push(reason('audio_track_selection', 'container', `${nAudio} audio tracks: the client cannot choose the track inside the container`));
  }
  dp.push(...copy.blockers, ...copy.directPlayBlockers, ...dpBitrate);
  if (pick && pick.action.kind !== 'copy') dp.push(...pick.actionReasons.filter((r) => r.code === 'audio_converted'));
  if (pick && pick.action.kind === 'copy' && facts.container === 'matroska' && !selectsTracks(caps) && !MKV_DIRECT_PLAY_AUDIO.has(audioToken(pick.track))) {
    dp.push(reason('container_unsupported', 'container', `${codecName(pick.track.codec)} audio in MKV: Direct Play not measured in the browser, remux to fMP4`));
  }
  dp.push(...audioBlockers);
  if (treatment('direct_play').kind === 'burn') dp.push(burnBlocker);
  const dpExcluded = modeExclusion(exclusions, file.fileId, 'direct_play');
  if (dpExcluded) dp.push(reason('format_excluded', dpExcluded.dimension, exclusionMessage(dpExcluded)));

  // Direct Stream.
  const ds: PlanReason[] = [];
  if (!hasProtocol(caps, 'hls-fmp4')) ds.push(reason('container_unsupported', 'container', 'The client does not play HLS fMP4'));
  ds.push(...copy.blockers, ...dsBitrate, ...audioBlockers);
  if (treatment('direct_stream').kind === 'burn') ds.push(burnBlocker);
  const dsExcluded = modeExclusion(exclusions, file.fileId, 'direct_stream');
  if (dsExcluded) ds.push(reason('format_excluded', dsExcluded.dimension, exclusionMessage(dsExcluded)));

  // Transcode.
  const tx: PlanReason[] = [...tc.blockers, ...audioBlockers];

  const blockers: Record<DeliveryMode, PlanReason[]> = { direct_play: dp, direct_stream: ds, transcode: tx };
  const modes: DeliveryMode[] = input.forceMode ? [input.forceMode] : ['direct_play', 'direct_stream', 'transcode'];
  const mode = modes.find((m) => blockers[m].length === 0);
  const forced = input.forceMode ? [reason('forced_mode', 'file', `Mode forced to ${modeName(input.forceMode)} (diagnostics)`)] : [];
  if (!mode) {
    // The heavier modes explain the failure; Direct Play's own blockers are added when Direct Stream
    // does not already cover them. An audio conversion is not a failure cause.
    const key = (r: PlanReason): string => `${r.code}\u0000${r.message}`;
    const dsKeys = new Set(ds.map(key));
    const dpOnly = dp.filter((r) => !dsKeys.has(key(r)) && r.code !== 'audio_converted');
    const explaining = input.forceMode ? blockers[input.forceMode] : [...ds, ...tx, ...dpOnly];
    const all = uniqueReasons([...forced, ...explaining, ...skippedSub]);
    return { file, outcome: null, reasons: all, droppedSubtitle: null };
  }

  // Reasons: why the lighter modes did not work, then what the chosen mode does.
  const reasons: PlanReason[] = [...forced];
  if (mode === 'direct_play') reasons.push(reason('direct_play', 'file', 'Direct Play: the file is served as is'));
  for (const m of ['direct_play', 'direct_stream'] as const) if (!input.forceMode && MODE_RANK[m] < MODE_RANK[mode]) reasons.push(...blockers[m]);
  if (mode !== 'transcode') reasons.push(...copy.actionReasons[mode]);
  if (pick) reasons.push(...pick.skipReasons);
  if (pick && mode !== 'direct_play') reasons.push(...pick.actionReasons);

  const t = treatment(mode);
  let subtitles: PlanSubtitles<'embedded' | 'sidecar' | 'client_render' | 'burned'>;
  let droppedSubtitle: string | null = null;
  // Tracks a native player renders from the file need no extraction in Direct Play.
  const served = mode === 'direct_play' ? servedAll.filter((s) => !rendersFromStream(subs.find((x) => x.trackId === s.trackId)!, caps, subEx, [])) : servedAll;
  if (!choice || t.kind === 'off') {
    subtitles = { selected: null, served };
  } else if (t.kind === 'embedded') {
    subtitles = { selected: { trackId: choice.track.trackId, source: choice.track.source, codec: choice.track.codec, delivery: 'embedded' }, served };
  } else if (t.kind === 'served') {
    subtitles = { selected: { trackId: t.served.trackId, source: t.served.source, codec: t.served.codec, delivery: t.served.delivery }, served };
    reasons.push(servedReason(t.served));
  } else if (t.kind === 'burn') {
    subtitles = { selected: { trackId: choice.track.trackId, source: choice.track.source, codec: choice.track.codec, delivery: 'burned' }, served };
    reasons.push(reason('subtitle_burn_in', 'subtitle', `Subtitles ${subName} burned into the video: the client cannot render them`));
  } else {
    subtitles = { selected: null, served };
    droppedSubtitle = choice.explicit ? choice.track.trackId : null;
    reasons.push(reason('subtitle_dropped', 'subtitle', `Subtitles ${subName} cannot be shown: ${t.why}`));
  }
  reasons.push(...skippedSub);

  const base = {
    planVersion: PLAN_VERSION as typeof PLAN_VERSION,
    file: planFile(file),
    startPositionMs: clampPosition(input.startPositionMs, facts.durationMs),
    exclusions: exclusions.map((e) => ({ ...e })),
  };
  const source = videoSource(v);
  let plan: PlaybackPlan;
  let pixels = v.width * v.height;
  let hdrKept = copy.presented === 'SDR' ? 0 : 1;
  let videoBitRate = videoRate ?? 0;
  if (mode === 'direct_play') {
    const p: DirectPlayPlan = {
      ...base,
      mode,
      protocol: 'progressive',
      video: { kind: 'original', source },
      audio: pick ? { source: pick.source, action: { kind: 'copy' } } : null,
      subtitles: subtitles as DirectPlayPlan['subtitles'],
      reasons: [],
    };
    plan = p;
  } else if (mode === 'direct_stream') {
    const p: DirectStreamPlan = {
      ...base,
      mode,
      protocol: 'hls-fmp4',
      video: { kind: 'copy', source, tag: v.codec === 'hevc' ? 'hvc1' : null, dolbyVision: copy.dolbyVision },
      audio: pick ? { source: pick.source, action: pick.action } : null,
      subtitles: subtitles as DirectStreamPlan['subtitles'],
      reasons: [],
    };
    plan = p;
  } else {
    const causes = [...copy.causes];
    if (dsBitrate.length > 0) causes.push('bitrate');
    if (subtitles.selected?.delivery === 'burned') causes.push('burn_in');
    // Nothing in the source needs it: the lighter modes were excluded by failures (doc 04 §8).
    if (causes.length === 0 && dsExcluded) causes.push('excluded');
    // H.264 8-bit output cannot carry HDR: any HDR source is tone-mapped.
    const toneMap = v.hdr === 'SDR' ? 'none' : 'to_sdr';
    if (toneMap === 'to_sdr' && !reasons.some((r) => r.code === 'hdr_tonemap')) {
      reasons.push(reason('hdr_tonemap', 'video', `${v.hdr} tone-mapped to SDR for the H.264 Transcode`));
    }
    const share = Math.min(1, (tc.width * tc.height) / (TRANSCODE_MAX_WIDTH * TRANSCODE_MAX_HEIGHT));
    let maxBitrateBps = Math.max(1_000_000, Math.round(input.constraints.transcodeMaxBitrateBps * share));
    if (limit !== undefined) maxBitrateBps = Math.max(500_000, Math.min(maxBitrateBps, limit - servedAudioBps(pick)));
    const p: TranscodePlan = {
      ...base,
      mode,
      protocol: 'hls-fmp4',
      video: { kind: 'transcode', source, codec: 'h264', width: tc.width, height: tc.height, maxBitrateBps, toneMap, causes },
      audio: pick ? { source: pick.source, action: pick.action } : null,
      subtitles: subtitles as TranscodePlan['subtitles'],
      reasons: [],
    };
    plan = p;
    pixels = tc.width * tc.height;
    hdrKept = 0;
    videoBitRate = maxBitrateBps;
  }
  plan.reasons = uniqueReasons(reasons);
  // A lossy source stays lossy in FLAC: only a lossless source copied or in FLAC counts (version choice).
  const lossless = pick ? pick.track.lossless && (pick.action.kind === 'copy' || pick.action.codec === 'flac') : false;
  const channels = pick ? (pick.action.kind === 'copy' ? pick.track.channels : pick.action.channels) : 0;
  return {
    file,
    outcome: {
      plan,
      pixels,
      hdrKept,
      bitDepth: mode === 'transcode' ? 8 : (v.bitDepth ?? 8),
      audioLossless: Number(lossless),
      audioChannels: channels,
      videoBitRate,
      label: versionLabel(v),
    },
    reasons: plan.reasons,
    droppedSubtitle,
  };
}

// ---------------------------------------------------------------- version choice

const transcodes = (o: Outcome): number => (o.plan.mode === 'transcode' ? 1 : 0);

/** Higher is better: pixels, HDR kept, bit depth, lossless audio, channels, then the video bitrate. */
function compareQuality(x: Outcome, y: Outcome): number {
  return (
    y.pixels - x.pixels ||
    y.hdrKept - x.hdrKept ||
    y.bitDepth - x.bitDepth ||
    y.audioLossless - x.audioLossless ||
    y.audioChannels - x.audioChannels ||
    y.videoBitRate - x.videoBitRate
  );
}

/**
 * Orchestrator decision (2026-11-05, doc 04 §3 and P6 updated): a video transcode always loses;
 * among the rest quality comes first ("never degrade the media"), the lighter mode only breaks ties
 * (the server cost), then the file id.
 */
function compareOutcomes(a: FileEvaluation, b: FileEvaluation): number {
  const x = a.outcome!;
  const y = b.outcome!;
  return transcodes(x) - transcodes(y) || compareQuality(x, y) || MODE_RANK[x.plan.mode] - MODE_RANK[y.plan.mode] || byFileId(a.file, b.file);
}

function whyChosen(a: Outcome, b: Outcome | undefined): string {
  if (!b) return 'the only playable version';
  if (transcodes(a) !== transcodes(b)) return `no video transcode, unlike ${b.label}`;
  if (compareQuality(a, b) !== 0) return `higher quality than ${b.label}`;
  if (a.plan.mode !== b.plan.mode) return `lighter mode than ${b.label}`;
  return `same quality and mode as ${b.label}`;
}

const byFileId = (a: { fileId: string }, b: { fileId: string }): number => (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0);

export function decide(input: DecideInput): Decision {
  const pool = (input.fileId === undefined ? input.files : input.files.filter((f) => f.fileId === input.fileId)).slice().sort(byFileId);
  const available = pool.filter((f) => f.available);
  const unavailable: CandidateOutcome[] = pool
    .filter((f) => !f.available)
    .map((f) => ({ fileId: f.fileId, mode: null, reasons: [reason('file_unavailable', 'file', 'The file is not available (missing, or its library root is offline)')] }));
  if (available.length === 0) return { ok: false, code: 'MEDIA_UNAVAILABLE', reasons: [], candidates: unavailable };

  const evals = available.map((f) => evaluateFile(f, input));
  const candidates: CandidateOutcome[] = [
    ...evals.map((e) => ({ fileId: e.file.fileId, mode: e.outcome?.plan.mode ?? null, reasons: e.reasons })),
    ...unavailable,
  ].sort(byFileId);
  const header: PlanReason[] = [];
  if (input.exclusions.length > 0) {
    header.push(reason('replanned_after_failure', 'file', `Re-planned after a playback failure: ${input.exclusions.length} format(s) excluded`));
  }

  const playable = evals.filter((e) => e.outcome !== null).sort(compareOutcomes);
  const winner = playable[0];
  if (!winner?.outcome) {
    const many = evals.length > 1;
    const labelled = evals.flatMap((e) => {
      const v = e.file.facts.streams.find((s): s is VideoStreamFacts => s.type === 'video' && !s.attachedPic);
      const label = v ? versionLabel(v) : e.file.fileId;
      return e.reasons.map((r) => (many ? { ...r, message: `${label}: ${r.message}` } : r));
    });
    return { ok: false, code: 'NO_COMPATIBLE_PLAN', reasons: uniqueReasons([...header, ...labelled]), candidates };
  }

  const plan = winner.outcome.plan;
  if (available.length > 1 && input.fileId === undefined) {
    header.push(reason('version_chosen', 'file', `Version ${winner.outcome.label} chosen: ${whyChosen(winner.outcome, playable[1]?.outcome ?? undefined)}`));
  }
  plan.reasons = uniqueReasons([...header, ...plan.reasons]);
  return { ok: true, plan, candidates, droppedSubtitleTrackId: winner.droppedSubtitle };
}
