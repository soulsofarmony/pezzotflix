import { describe, expect, it } from 'vitest';
import { audioDecoded, classifyHlsError, classifyMediaError, classifyProbe, type FailureAction, type HlsErrorLike, MEDIA_ERR } from './failures.ts';
import type { UrlStatus } from './probe.ts';

const MIME = 'video/mp4; codecs="avc1.640028, ec-3"';
// Chrome in S2: H.264 yes, E-AC-3 no.
const chrome = (t: string) => !t.includes('ec-3') && !t.includes('ac-3');

const err = (over: Partial<HlsErrorLike>): HlsErrorLike => ({ type: 'mediaError', details: 'x', fatal: true, ...over });

describe('classifyHlsError: failure table of doc 05 §7.8.5', () => {
  it.each<[string, HlsErrorLike, FailureAction]>([
    ['bufferAddCodecError on audio', err({ details: 'bufferAddCodecError', sourceBufferName: 'audio' }), { kind: 'replan', suspect: 'audio', error: 'bufferAddCodecError' }],
    ['bufferAddCodecError on video', err({ details: 'bufferAddCodecError', sourceBufferName: 'video' }), { kind: 'replan', suspect: 'video', error: 'bufferAddCodecError' }],
    ['bufferAddCodecError on audiovideo → decomposition (S2: E-AC-3 in Chrome)', err({ details: 'bufferAddCodecError', sourceBufferName: 'audiovideo' }), { kind: 'replan', suspect: 'audio', error: 'bufferAddCodecError' }],
    ['bufferIncompatibleCodecsError without a buffer name', err({ details: 'bufferIncompatibleCodecsError' }), { kind: 'replan', suspect: 'unknown', error: 'bufferIncompatibleCodecsError' }],
    ['bufferAppendError → decomposition', err({ details: 'bufferAppendError' }), { kind: 'replan', suspect: 'audio', error: 'bufferAppendError' }],
    ['fragParsingError → decomposition', err({ details: 'fragParsingError' }), { kind: 'replan', suspect: 'audio', error: 'fragParsingError' }],
    ['manifestIncompatibleCodecsError → decomposition', err({ details: 'manifestIncompatibleCodecsError' }), { kind: 'replan', suspect: 'audio', error: 'manifestIncompatibleCodecsError' }],
    ['other fatal media error → unknown', err({ details: 'internalException' }), { kind: 'replan', suspect: 'unknown', error: 'internalException' }],
    ['fatal 500 on a fragment → STREAM_FAILED, unknown', err({ type: 'networkError', details: 'fragLoadError', response: { code: 500 } }), { kind: 'replan', suspect: 'unknown', error: 'STREAM_FAILED' }],
    ['fatal 503 after the retries → STREAM_FAILED, unknown', err({ type: 'networkError', details: 'fragLoadError', response: { code: 503 } }), { kind: 'replan', suspect: 'unknown', error: 'STREAM_FAILED' }],
    ['404 → session closed', err({ type: 'networkError', details: 'fragLoadError', response: { code: 404 } }), { kind: 'restart', error: 'HTTP_404' }],
    ['410 → session closed', err({ type: 'networkError', details: 'levelLoadError', response: { code: 410 } }), { kind: 'restart', error: 'HTTP_410' }],
    ['401 → session closed', err({ type: 'networkError', details: 'manifestLoadError', response: { code: 401 } }), { kind: 'restart', error: 'HTTP_401' }],
    ['403 even when not fatal → session closed', err({ type: 'networkError', details: 'fragLoadError', fatal: false, response: { code: 403 } }), { kind: 'restart', error: 'HTTP_403' }],
    ['non-fatal network error → hls.js retries', err({ type: 'networkError', details: 'fragLoadError', fatal: false, response: { code: 503 } }), { kind: 'ignore' }],
    ['fatal network error without an answer → network', err({ type: 'networkError', details: 'fragLoadTimeOut' }), { kind: 'network', error: 'fragLoadTimeOut' }],
    ['status from networkDetails (xhr)', err({ type: 'networkError', details: 'fragLoadError', networkDetails: { status: 410 } }), { kind: 'restart', error: 'HTTP_410' }],
    ['bufferFullError → not a failure', err({ details: 'bufferFullError', fatal: false }), { kind: 'ignore', note: 'buffer_full' }],
    ['bufferStalledError not fatal → hls.js nudges', err({ details: 'bufferStalledError', fatal: false }), { kind: 'ignore', note: 'stalled' }],
    ['bufferSeekOverHole not fatal → hls.js jumps it', err({ details: 'bufferSeekOverHole', fatal: false }), { kind: 'ignore', note: 'stalled' }],
    // hls.js 1.7.4 makes a stall fatal after nudgeMaxRetry: one reload, then a re-plan with unknown.
    ['bufferStalledError fatal → reload, then unknown', err({ details: 'bufferStalledError' }), { kind: 'reload', error: 'bufferStalledError', suspect: 'unknown' }],
    ['bufferSeekOverHole fatal → reload, then unknown', err({ details: 'bufferSeekOverHole' }), { kind: 'reload', error: 'bufferSeekOverHole', suspect: 'unknown' }],
    ['bufferNudgeOnStall fatal → reload, then unknown', err({ details: 'bufferNudgeOnStall' }), { kind: 'reload', error: 'bufferNudgeOnStall', suspect: 'unknown' }],
    ['mediaSourceRequiresReset not fatal → ignore', err({ details: 'mediaSourceRequiresReset', fatal: false }), { kind: 'ignore' }],
    ['mediaSourceRequiresReset fatal → reload, then the decomposition', err({ details: 'mediaSourceRequiresReset' }), { kind: 'reload', error: 'mediaSourceRequiresReset', suspect: 'audio' }],
    ['non-fatal media error → ignore', err({ details: 'bufferAppendError', fatal: false }), { kind: 'ignore' }],
  ])('%s', (_name, e, expected) => {
    expect(classifyHlsError(e, MIME, chrome)).toEqual(expected);
  });

  it('falls back to unknown without a mimeType', () => {
    expect(classifyHlsError(err({ details: 'bufferAppendError' }), null, chrome)).toEqual({ kind: 'replan', suspect: 'unknown', error: 'bufferAppendError' });
    expect(classifyHlsError(err({ details: 'mediaSourceRequiresReset' }), null, chrome)).toEqual({ kind: 'reload', error: 'mediaSourceRequiresReset', suspect: 'unknown' });
  });

  it('fatal mediaSourceRequiresReset with video.error set: no reload, a re-plan from the decomposition', () => {
    expect(classifyHlsError(err({ details: 'mediaSourceRequiresReset' }), MIME, chrome, true)).toEqual({ kind: 'replan', suspect: 'audio', error: 'mediaSourceRequiresReset' });
    expect(classifyHlsError(err({ details: 'mediaSourceRequiresReset' }), null, chrome, true)).toEqual({ kind: 'replan', suspect: 'unknown', error: 'mediaSourceRequiresReset' });
  });
});

describe('classifyProbe: status of a progressive url after a <video> error', () => {
  const status = (s: number): UrlStatus => ({ kind: 'status', status: s, retryAfterMs: null });
  it.each<[string, UrlStatus, FailureAction | null]>([
    ['410 → session closed', status(410), { kind: 'restart', error: 'HTTP_410' }],
    ['404 → session closed', status(404), { kind: 'restart', error: 'HTTP_404' }],
    ['403 → session closed', status(403), { kind: 'restart', error: 'HTTP_403' }],
    ['500 → re-plan, unknown', status(500), { kind: 'replan', suspect: 'unknown', error: 'STREAM_FAILED' }],
    ['503 → re-plan, unknown', status(503), { kind: 'replan', suspect: 'unknown', error: 'STREAM_FAILED' }],
    ['no answer → network', { kind: 'error', error: 'Failed to fetch' }, { kind: 'network', error: 'Failed to fetch' }],
    ['206 → the element decides', status(206), null],
    ['200 → the element decides', status(200), null],
    ['timeout → the element decides', { kind: 'timeout' }, null],
  ])('%s', (_name, st, expected) => {
    expect(classifyProbe(st)).toEqual(expected);
  });
});

describe('classifyMediaError', () => {
  it.each<[string, number, boolean | null, boolean, FailureAction]>([
    ['SRC_NOT_SUPPORTED → container', MEDIA_ERR.SRC_NOT_SUPPORTED, null, false, { kind: 'replan', suspect: 'container', error: 'MEDIA_ERR_SRC_NOT_SUPPORTED' }],
    ['DECODE with audio decoded → video', MEDIA_ERR.DECODE, true, false, { kind: 'replan', suspect: 'video', error: 'MEDIA_ERR_DECODE' }],
    ['DECODE without audio → unknown', MEDIA_ERR.DECODE, false, false, { kind: 'replan', suspect: 'unknown', error: 'MEDIA_ERR_DECODE' }],
    ['DECODE, counters missing → unknown', MEDIA_ERR.DECODE, null, false, { kind: 'replan', suspect: 'unknown', error: 'MEDIA_ERR_DECODE' }],
    ['NETWORK first time → one browser retry', MEDIA_ERR.NETWORK, null, false, { kind: 'reload', error: 'MEDIA_ERR_NETWORK', suspect: 'unknown' }],
    ['NETWORK after the retry → STREAM_FAILED', MEDIA_ERR.NETWORK, null, true, { kind: 'replan', suspect: 'unknown', error: 'STREAM_FAILED' }],
    ['ABORTED → ignore', MEDIA_ERR.ABORTED, null, false, { kind: 'ignore' }],
  ])('%s', (_name, code, audio, retried, expected) => {
    expect(classifyMediaError(code, audio, retried)).toEqual(expected);
  });
});

describe('audioDecoded', () => {
  it('reads the Chromium counter, then the Firefox flag', () => {
    expect(audioDecoded({ webkitAudioDecodedByteCount: 0 })).toBe(false);
    expect(audioDecoded({ webkitAudioDecodedByteCount: 1024 })).toBe(true);
    expect(audioDecoded({ mozHasAudio: false })).toBe(false);
    expect(audioDecoded({ mozHasAudio: true })).toBe(true);
    expect(audioDecoded({})).toBeNull();
  });
});
