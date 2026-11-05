// hls-fmp4 engine: hls.js 1.7.4 light build via MSE (doc 05 §7.8.1). Audio is muxed in the video segments
// (ADR 0003), subtitles are ours (subtitles.ts), so the light build is enough.
import type HlsType from 'hls.js/light';
import type { ErrorData, HlsConfig, InitPTSFoundData, LevelLoadedData, LoadPolicy, ManifestParsedData, RetryConfig } from 'hls.js/light';
import type { HlsStream, SessionTrack } from '../api/types.ts';
import { deliveredAudioCodec, hlsBufferConfig } from './buffer.ts';
import type { Engine, EngineCallbacks } from './engine.ts';
import { classifyHlsError } from './failures.ts';
import { timelineOffsetFromInitPts } from './timeline.ts';

export type HlsClass = typeof HlsType;

/** Provisional target duration until the media playlist is loaded: the ADR 0003 cut at 6 s. */
export const PROVISIONAL_TARGET_DURATION_S = 6;

/**
 * A 500 is STREAM_FAILED, terminal for the stream (ADR 0003): no hls.js retries, so the error turns fatal at once.
 * A 503 keeps hls.js's own retry (default decision passed as `retry`).
 */
export const no500Retry: NonNullable<RetryConfig['shouldRetry']> = (_cfg, _count, _timeout, response, retry) => (response?.code === 500 ? false : retry);

export function withNo500Retry(policy: LoadPolicy): LoadPolicy {
  const d = policy.default;
  return { default: { ...d, errorRetry: d.errorRetry ? { ...d.errorRetry, shouldRetry: no500Retry } : null } };
}

export interface HlsEngineDeps {
  Hls: HlsClass;
  workerPath: string;
  isTypeSupported: ((t: string) => boolean) | null;
}

export function createHlsEngine(video: HTMLVideoElement, stream: HlsStream, audio: SessionTrack | null, cb: EngineCallbacks, deps: HlsEngineDeps): Engine {
  const { Hls } = deps;
  let destroyed = false;
  let startS = 0;
  let bandwidthBps: number | null = null;
  let targetDurationKnown = false;
  let bufferFullCount = 0;

  // The estimate uses the delivered codec (a TrueHD source may arrive as FLAC or AAC); channels from the source.
  const audioCodec = deliveredAudioCodec(stream.mimeType) ?? audio?.codec ?? null;
  const bufferFor = (targetDurationS: number) =>
    hlsBufferConfig({
      peakBps: stream.bitrate.peakBps,
      audioBps: stream.bitrate.audioBps,
      bandwidthBps,
      audioCodec,
      audioChannels: audio?.channels ?? null,
      targetDurationS,
    });

  const initial = bufferFor(PROVISIONAL_TARGET_DURATION_S);
  const defaults = Hls.DefaultConfig;
  const config: Partial<HlsConfig> = {
    enableWorker: true,
    workerPath: deps.workerPath,
    autoStartLoad: false,
    maxBufferLength: initial.maxBufferLength,
    maxMaxBufferLength: initial.maxMaxBufferLength,
    maxBufferSize: initial.maxBufferSize,
    backBufferLength: initial.backBufferLength,
    manifestLoadPolicy: withNo500Retry(defaults.manifestLoadPolicy),
    playlistLoadPolicy: withNo500Retry(defaults.playlistLoadPolicy),
    fragLoadPolicy: withNo500Retry(defaults.fragLoadPolicy),
  };
  const hls = new Hls(config);

  /** provisional: TD is not known yet (MANIFEST_PARSED), so the T < 2·TD warning waits for LEVEL_LOADED. */
  const applyBuffer = (targetDurationS: number, provisional: boolean) => {
    const b = bufferFor(targetDurationS);
    // hls.js reads its config on every tick: changing it before the first fragment is enough.
    Object.assign(hls.config, {
      maxBufferLength: b.maxBufferLength,
      maxMaxBufferLength: b.maxMaxBufferLength,
      maxBufferSize: b.maxBufferSize,
      backBufferLength: b.backBufferLength,
    });
    const warn = b.warn && !provisional;
    cb.log(warn ? 'warn' : 'info', warn ? 'buffer floor above the margin (T < 2·TD)' : provisional ? 'buffer sized (provisional TD)' : 'buffer sized', { ...b, targetDurationS });
  };

  hls.on(Hls.Events.MANIFEST_PARSED, (_e, data: ManifestParsedData) => {
    if (destroyed) return;
    bandwidthBps = data.levels[0]?.bitrate ?? null;
    applyBuffer(PROVISIONAL_TARGET_DURATION_S, true);
    hls.startLoad(startS);
  });

  hls.on(Hls.Events.LEVEL_LOADED, (_e, data: LevelLoadedData) => {
    if (destroyed || targetDurationKnown) return;
    targetDurationKnown = true;
    applyBuffer(data.details.targetduration, false);
  });

  hls.on(Hls.Events.INIT_PTS_FOUND, (_e, data: InitPTSFoundData) => {
    // PlaylistLevelType is a runtime enum of the full bundle; compare its string value instead of importing it.
    if (destroyed || (data.id as string) !== 'main') return;
    cb.onTimelineOffset(timelineOffsetFromInitPts(data.initPTS, data.timescale, stream.mediaTimestampOffsetMs));
  });

  hls.on(Hls.Events.ERROR, (_e, data: ErrorData) => {
    if (destroyed) return;
    const action = classifyHlsError(data, stream.mimeType, deps.isTypeSupported, video.error !== null);
    if (action.kind === 'ignore') {
      if (action.note === 'buffer_full') {
        bufferFullCount += 1;
        cb.log('warn', 'bufferFullError', { count: bufferFullCount });
        cb.onBufferFull();
      }
      return;
    }
    cb.log('warn', 'hls.js error', { type: data.type, details: data.details, fatal: data.fatal, action: action.kind });
    // Never let hls.js retry the same stream after a fatal error (S2 finding 4): stop now, the controller replaces it.
    hls.stopLoad();
    cb.onFailure(action);
  });

  return {
    protocol: 'hls-fmp4',
    start(s) {
      if (destroyed) return;
      startS = s;
      hls.attachMedia(video);
      hls.loadSource(stream.url);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      hls.destroy();
    },
  };
}
