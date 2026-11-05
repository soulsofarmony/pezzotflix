// The plan and the StreamDelivery DTOs cross the C1 boundary as JSON: checked at type level
// (no functions, Dates, Maps, undefined) and by a round trip on a realistic plan.
import { describe, expect, it } from 'vitest';
import type { DeliveryKeyframeIndexPayload } from './job-types.ts';
import { PLAN_VERSION, type DirectStreamPlan, type PlaybackPlan } from './playback-plan.ts';
import type { StreamFailure, StreamHandle, StreamStartResult, StreamStatus } from './ports.ts';

type Json = string | number | boolean | null;
/** true only if every member of T is plain JSON all the way down (distributes over unions). */
type JsonSafe<T> = [T] extends [never]
  ? true
  : T extends Json
    ? true
    : T extends (...args: never[]) => unknown
      ? false
      : T extends readonly (infer U)[]
        ? JsonSafe<U>
        : T extends object
          ? false extends { [K in keyof T]-?: JsonSafe<T[K]> }[keyof T]
            ? false
            : true
          : false;
type AllTrue<B> = false extends B ? false : true;

const jsonChecks: [
  AllTrue<JsonSafe<PlaybackPlan>>,
  AllTrue<JsonSafe<StreamHandle>>,
  AllTrue<JsonSafe<StreamStatus>>,
  AllTrue<JsonSafe<StreamFailure>>,
  AllTrue<JsonSafe<StreamStartResult>>,
  AllTrue<JsonSafe<DeliveryKeyframeIndexPayload>>,
] = [true, true, true, true, true, true];

// Negative control: the checker must reject what JSON would lose.
const negativeChecks: [
  AllTrue<JsonSafe<{ at: Date }>>,
  AllTrue<JsonSafe<{ f: () => void }>>,
  AllTrue<JsonSafe<{ m: Map<string, number> }>>,
  AllTrue<JsonSafe<{ u: undefined }>>,
] = [false, false, false, false];

/** UHD HEVC Main10 HDR10 remux, TrueHD 7.1 Atmos → FLAC 7.1, PGS rendered by the browser. */
const uhdRemux: DirectStreamPlan = {
  planVersion: PLAN_VERSION,
  mode: 'direct_stream',
  protocol: 'hls-fmp4',
  file: {
    fileId: '01936f0e-7b2a-7c3d-9e4f-5a6b7c8d9e0f',
    location: { rootName: 'Film', relPath: 'Blade Runner 2049 (2017)/Blade Runner 2049 (2017) - 2160p.mkv' },
    sizeBytes: 78_123_456_789,
    mtimeMs: 1_762_300_000_000,
    container: 'matroska',
    durationMs: 9_840_000,
  },
  video: {
    kind: 'copy',
    source: {
      streamIndex: 0,
      codec: 'hevc',
      profile: 'Main 10',
      width: 3840,
      height: 2160,
      frameRate: 23.976,
      bitDepth: 10,
      hdr: 'HDR10',
      dolbyVisionProfile: null,
      bitRate: 62_000_000,
    },
    tag: 'hvc1',
    dolbyVision: 'none',
  },
  audio: {
    source: {
      streamIndex: 1,
      trackId: 's1',
      codec: 'truehd',
      profile: null,
      language: 'eng',
      channels: 8,
      channelLayout: '7.1',
      sampleRate: 48_000,
      bitRate: null,
    },
    action: { kind: 'convert', codec: 'flac', channels: 8, bitrateBps: null, layout: null },
  },
  subtitles: {
    selected: { trackId: 's5', source: { kind: 'embedded', streamIndex: 5 }, codec: 'hdmv_pgs_subtitle', delivery: 'client_render' },
    served: [
      {
        trackId: 's5',
        source: { kind: 'embedded', streamIndex: 5 },
        codec: 'hdmv_pgs_subtitle',
        language: 'ita',
        forced: false,
        delivery: 'client_render',
        format: 'sup',
      },
      {
        trackId: 'x:1a2b3c4d',
        source: { kind: 'sidecar', relPath: 'Blade Runner 2049 (2017)/Blade Runner 2049 (2017).eng.srt', format: 'srt' },
        codec: 'subrip',
        language: 'eng',
        forced: false,
        delivery: 'sidecar',
        format: 'webvtt',
      },
    ],
  },
  startPositionMs: 3_723_000,
  reasons: [
    { code: 'container_unsupported', dimension: 'container', message: 'MKV with several audio tracks: remux to fMP4' },
    { code: 'hdr_client_conversion', dimension: 'video', message: 'HDR10 on an SDR display: conversion left to the browser' },
    { code: 'audio_converted', dimension: 'audio', message: 'TrueHD not supported by the browser: converted to FLAC 7.1' },
    { code: 'subtitle_client_render', dimension: 'subtitle', message: 'PGS rendered by the browser' },
    { code: 'format_excluded', dimension: 'audio', message: 'E-AC-3 excluded after a playback failure' },
  ],
  exclusions: [{ dimension: 'audio', action: 'convert', codec: 'eac3', cause: 'client', error: 'MEDIA_ERR_DECODE' }],
};

describe('PlaybackPlan serialization', () => {
  it('passes the type-level JSON checks', () => {
    expect(jsonChecks.every(Boolean)).toBe(true);
    expect(negativeChecks.some(Boolean)).toBe(false);
  });

  it('round-trips a UHD HDR10 Direct Stream plan through JSON unchanged', () => {
    const plan: PlaybackPlan = uhdRemux;
    const back = JSON.parse(JSON.stringify(plan)) as PlaybackPlan;
    expect(back).toStrictEqual(plan);
    expect(back.mode === 'direct_stream' && back.video.tag).toBe('hvc1');
  });
});
