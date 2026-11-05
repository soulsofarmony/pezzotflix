// Session Manager and control-plane handlers through compose() and Fastify (doc 03 §4, doc 04 §6–§8,
// ADR 0003 D7/D9): lifecycle, limits, re-plans with a stable sessionId, the 3-attempt budget, the
// delivery record winning over the client's suspect, Retry-After, and every response against the contract.
/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- response bodies are untyped JSON, checked against the contract by the harness */
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWatchState } from '../src/modules/profiles/watch.ts';
import type { PlayableItem } from '../src/shared/ports.ts';
import { aac, ac3, audio, chrome, edge, facts, file, firefox, sdr1080, sub, video } from './playback-fixtures.ts';
import { failure, P1, P2, type PlaybackHarness, playbackHarness } from './playback-harness.ts';
import { fakeCatalogRead, seedCatalog } from './profiles-fixtures.ts';

const ITEM = '01936f0e-0000-7000-8000-0000000000b1';
const ITEM_HD = '01936f0e-0000-7000-8000-0000000000b2';
const F1 = '01936f0e-0000-7000-8000-000000000f01';
const F2 = '01936f0e-0000-7000-8000-000000000f02';
const SESSIONS = '/video/api/v1/playback/sessions';
const S1 = '01936f0e-0000-7000-8000-000000000001';

/** UHD remux: HEVC HDR10, TrueHD 7.1 eng, AC-3 5.1 ita, PGS ita, PGS eng, VobSub fre; 2 h, 2 chapters. */
const uhd = (): PlayableItem => ({
  itemId: ITEM,
  kind: 'movie',
  title: 'Blade Runner 2049',
  durationMs: 9_840_000,
  files: [
    file(
      F1,
      facts([video(), audio(1), ac3(2, 'ita'), sub(3), sub(4, { language: 'eng' }), sub(5, { codec: 'dvd_subtitle', language: 'fre' })], {
        durationMs: 9_840_000,
        chapters: [
          { index: 0, title: 'Opening', startMs: 0, endMs: 300_000 },
          { index: 1, title: null, startMs: 300_000, endMs: 9_840_000 },
        ],
      }),
    ),
  ],
});
/** 1080p: H.264 + AAC 2.0 ita alone (Direct Play in a browser), VobSub ita. */
const hd = (o: Partial<PlayableItem> = {}): PlayableItem => ({
  itemId: ITEM_HD,
  kind: 'movie',
  title: 'Il buono, il brutto, il cattivo',
  durationMs: 10_000_000,
  files: [file(F2, facts([sdr1080(), aac(1, 'ita'), sub(2, { codec: 'dvd_subtitle' })], { durationMs: 10_000_000 }))],
  ...o,
});

let h: PlaybackHarness;
beforeEach(async () => {
  h = await playbackHarness();
  h.catalog.items.set(ITEM, uhd());
  h.catalog.items.set(ITEM_HD, hd());
});
afterEach(async () => h.close());

const start = (body: Record<string, unknown>, token = 't1') => h.call('startPlayback', 'POST', SESSIONS, { capabilities: chrome(), ...body }, token);

describe('startPlayback', () => {
  it('UHD remux in Chrome: 201 Direct Stream session from the plan and the StreamHandle', async () => {
    h.profiles.resume.set(`${P1}/${ITEM}`, 3_723_000);
    const r = await start({ itemId: ITEM });
    expect(r.status).toBe(201);
    const s = r.body;
    expect(s).toMatchObject({
      sessionId: S1,
      itemId: ITEM,
      fileId: F1,
      mode: 'direct_stream',
      resumePositionMs: 3_723_000,
      durationMs: 9_840_000,
      heartbeatIntervalMs: 10_000,
      expiresAt: 1_000_000 + 60_000,
      stream: {
        url: '/video/media/s/token000000000001/hls/main.m3u8',
        protocol: 'hls-fmp4',
        mimeType: 'video/mp4; codecs="hvc1.2.4.L153.B0, flac"',
        startOffsetMs: 0,
        mediaTimestampOffsetMs: 10_000,
        bitrate: { peakBps: 90_000_000, averageBps: 60_000_000, audioBps: 4_000_000 },
      },
      chapters: [
        { title: 'Opening', startMs: 0, endMs: 300_000 },
        { title: null, startMs: 300_000, endMs: 9_840_000 },
      ],
    });
    expect(s.reasons).toContain('HDR10 on an SDR display: conversion left to the browser');
    expect(s.tracks.audio.map((t: any) => [t.id, t.selected, t.switchWithoutRestart])).toEqual([
      ['s1', false, false],
      ['s2', true, false],
    ]);
    const subs = Object.fromEntries(s.tracks.subtitles.map((t: any) => [t.id, t]));
    expect(subs.s3).toMatchObject({ delivery: 'client_render', url: '/video/media/s/token000000000001/subtitles/s3.sup', availability: 'growing', switchWithoutRestart: true, selected: false });
    expect(subs.s5).toMatchObject({ url: null, switchWithoutRestart: false, selected: false });
    expect(subs.s5.delivery).toBeUndefined();
    expect(h.delivery.calls[0]).toMatchObject({ op: 'start', sessionId: S1 });
    expect(h.delivery.starts()[0]?.startPositionMs).toBe(3_723_000);
    const list = await h.call('listActiveSessions', 'GET', SESSIONS);
    expect(list.body).toEqual({ sessions: [{ sessionId: S1, profileId: P1, itemId: ITEM, itemTitle: 'Blade Runner 2049', mode: 'direct_stream', startedAt: 1_000_000, positionMs: 3_723_000 }] });
  });

  it('Direct Play of a single-track MKV: progressive, offset 0', async () => {
    const r = await start({ itemId: ITEM_HD, startPositionMs: 99_999_999 });
    expect(r.body.mode).toBe('direct_play');
    expect(r.body.stream).toMatchObject({ protocol: 'progressive', mediaTimestampOffsetMs: 0, startOffsetMs: 0 });
    expect(r.body.resumePositionMs).toBe(10_000_000);
  });

  it('the request beats the last choice, the last choice beats the prefs (doc 01 §7.2)', async () => {
    h.profiles.last.set(`${P1}/${ITEM}`, { fileId: F1, audioTrackId: 's1', subtitleTrackId: 's4' });
    let r = await start({ itemId: ITEM });
    expect(r.body.tracks.audio.find((t: any) => t.selected).id).toBe('s1');
    expect(r.body.tracks.subtitles.find((t: any) => t.selected).id).toBe('s4');
    await h.call('stopPlayback', 'POST', `${SESSIONS}/${r.body.sessionId}/stop`, { positionMs: 1000 });
    r = await start({ itemId: ITEM, audioTrackId: 's2', subtitleTrackId: null });
    expect(r.body.tracks.audio.find((t: any) => t.selected).id).toBe('s2');
    expect(r.body.tracks.subtitles.some((t: any) => t.selected)).toBe(false);
    await h.call('stopPlayback', 'POST', `${SESSIONS}/${r.body.sessionId}/stop`, { positionMs: 1000 });
    h.profiles.last.set(`${P1}/${ITEM}`, { fileId: F1, audioTrackId: 's9', subtitleTrackId: 's9' }); // gone: prefs again
    r = await start({ itemId: ITEM });
    expect(r.body.tracks.audio.find((t: any) => t.selected).id).toBe('s2');
  });

  it('404 for an unknown item, file or track; 404 for a series', async () => {
    expect((await start({ itemId: '01936f0e-0000-7000-8000-00000000ffff' })).body.code).toBe('NOT_FOUND');
    expect((await start({ itemId: ITEM, fileId: F2 })).status).toBe(404);
    expect((await start({ itemId: ITEM, audioTrackId: 's9' })).status).toBe(404);
    h.catalog.items.set(ITEM_HD, hd({ kind: 'series' }));
    expect((await start({ itemId: ITEM_HD })).status).toBe(404);
  });

  it('503 MEDIA_UNAVAILABLE when no file is available', async () => {
    h.catalog.items.set(ITEM_HD, hd({ files: [file(F2, hd().files[0]!.facts, false)] }));
    expect((await start({ itemId: ITEM_HD })).body).toMatchObject({ status: 503, code: 'MEDIA_UNAVAILABLE' });
  });

  it('422 NO_COMPATIBLE_PLAN with the reasons (4K without HEVC, P2)', async () => {
    const caps = { ...firefox(), video: firefox().video.filter((v) => v.codec !== 'hevc') };
    const r = await start({ itemId: ITEM, capabilities: caps });
    expect(r.status).toBe(422);
    expect(r.body.detail).toContain('above 1080p: a Transcode would be needed');
    expect(h.delivery.calls).toEqual([]);
  });

  it('a server-side override applies per device model (doc 03 I2)', async () => {
    await h.close();
    h = await playbackHarness({ overrides: [{ id: 'firefox-hdr10-sdr', match: { modelPattern: '^Firefox ' }, removeHdr: ['HDR10'] }] });
    h.catalog.items.set(ITEM, uhd());
    expect((await start({ itemId: ITEM, capabilities: firefox() })).status).toBe(422);
    expect((await start({ itemId: ITEM, capabilities: chrome() })).status).toBe(201);
  });
});

describe('limits (doc 04 §7, P4)', () => {
  it('session limit 1: 409 with the active sessions; terminating the other frees the slot', async () => {
    const a = await start({ itemId: ITEM }, 't2');
    const r = await start({ itemId: ITEM_HD });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'SESSION_LIMIT_REACHED', activeSessions: [{ sessionId: a.body.sessionId, profileId: P2 }] });
    expect((await h.call('terminateSession', 'DELETE', `${SESSIONS}/${a.body.sessionId}`)).status).toBe(204);
    expect(h.delivery.ops()).toEqual(['start direct_stream', 'stop st1 terminated']);
    expect(h.events).toEqual([{ type: 'playback.session_terminated', payload: { sessionId: a.body.sessionId, profileId: P2, itemId: ITEM, reason: 'terminated' } }]);
    expect((await start({ itemId: ITEM_HD })).status).toBe(201);
    expect((await h.call('terminateSession', 'DELETE', `${SESSIONS}/${a.body.sessionId}`)).status).toBe(204); // idempotent
  });

  it('MAX_TRANSCODES 1 with 2 sessions: the second Transcode is refused, Direct Stream still works', async () => {
    await h.close();
    h = await playbackHarness({ env: { MAX_SESSIONS: '2', MAX_TRANSCODES: '1' } });
    h.catalog.items.set(ITEM, uhd());
    h.catalog.items.set(ITEM_HD, hd());
    const burn = await start({ itemId: ITEM_HD, subtitleTrackId: 's2' });
    expect(burn.body.mode).toBe('transcode');
    expect(burn.body.tracks.subtitles[0]).toMatchObject({ id: 's2', selected: true, delivery: 'burned' });
    const second = await start({ itemId: ITEM_HD, subtitleTrackId: 's2' }, 't2');
    expect(second.status).toBe(201);
    expect(second.body.mode).toBe('direct_play'); // burn-in impossible: dropped, playback goes on
    expect(second.body.reasons.join(' ')).toContain('every transcode slot is taken');
  });

  it('MAX_TRANSCODES 0: a Transcode-only file gets 422 transcode_disabled', async () => {
    await h.close();
    h = await playbackHarness({ env: { MAX_TRANSCODES: '0' } });
    h.catalog.items.set(ITEM_HD, hd({ files: [file(F2, facts([sdr1080({ codec: 'vc1' }), aac(1, 'ita')]))] }));
    const r = await start({ itemId: ITEM_HD });
    expect(r.status).toBe(422);
    expect(r.body.detail).toContain('MAX_TRANSCODES = 0');
  });
});

describe('delivery outcomes at start (ADR 0003 D7, D8)', () => {
  it('STREAM_FAILED with a format exclusion: re-planned server-side, same sessionId, reason in the session', async () => {
    h.delivery.next.push({
      ok: false,
      code: 'STREAM_FAILED',
      failure: failure({ kind: 'aac_channel_config', class: 'format', suspect: 'audio', exclusion: { dimension: 'audio', action: 'convert', codec: 'flac', cause: 'server', error: 'aac_channel_config' } }),
    });
    const r = await start({ itemId: ITEM });
    expect(r.status).toBe(201);
    const [first, second] = h.delivery.calls;
    expect(first).toMatchObject({ op: 'start', sessionId: S1 });
    expect(second).toMatchObject({ op: 'start', sessionId: S1 });
    expect(h.delivery.starts()[1]?.audio?.action).toMatchObject({ codec: 'aac', channels: 6 });
    expect(r.body.reasons[0]).toBe('Re-planned after a playback failure: 1 format(s) excluded');
  });

  it('STREAM_FAILED without an exclusion: heavier mode for that file', async () => {
    h.delivery.next.push({ ok: false, code: 'STREAM_FAILED', failure: failure() });
    const r = await start({ itemId: ITEM_HD });
    expect(h.delivery.ops()).toEqual(['start direct_play', 'start direct_stream']);
    expect(r.body.mode).toBe('direct_stream');
  });

  it('after 3 automatic attempts: 422 NO_COMPATIBLE_PLAN, no session left', async () => {
    for (let i = 0; i < 4; i++) h.delivery.next.push({ ok: false, code: 'STREAM_FAILED', failure: failure({ suspect: 'audio' }) });
    const r = await start({ itemId: ITEM_HD });
    expect(r.status).toBe(422);
    expect(r.body.detail).toContain('the 3 automatic attempts are used up');
    expect(h.delivery.starts()).toHaveLength(4);
    expect((await h.call('listActiveSessions', 'GET', SESSIONS)).body.sessions).toEqual([]);
    expect((await start({ itemId: ITEM_HD })).status).toBe(201); // slot released
  });

  it('STREAM_PREPARING → 503 with Retry-After in seconds, through the error handler', async () => {
    h.delivery.next.push({ ok: false, code: 'STREAM_PREPARING', retryAfterMs: 2_500 });
    const r = await start({ itemId: ITEM });
    expect(r.status).toBe(503);
    expect(r.headers['retry-after']).toBe('3');
    expect(r.headers['content-type']).toContain('application/problem+json');
    expect(r.body.code).toBe('STREAM_PREPARING');
    expect((await start({ itemId: ITEM })).status).toBe(201);
  });

  it('MEDIA_UNAVAILABLE from delivery → 503 MEDIA_UNAVAILABLE without Retry-After', async () => {
    h.delivery.next.push({ ok: false, code: 'MEDIA_UNAVAILABLE', detail: 'root Film offline' });
    const r = await start({ itemId: ITEM });
    expect(r.body).toMatchObject({ status: 503, code: 'MEDIA_UNAVAILABLE', detail: 'root Film offline' });
    expect(r.headers['retry-after']).toBeUndefined();
  });
});

describe('progress, heartbeat, stop', () => {
  it('reportProgress records the sample with the tracks; the latest client timestamp wins', async () => {
    const id = (await start({ itemId: ITEM })).body.sessionId;
    const progress = (positionMs: number, clientTs: number) => h.call('reportProgress', 'POST', `${SESSIONS}/${id}/progress`, { positionMs, state: 'playing', clientTs });
    expect((await progress(60_000, 10)).status).toBe(204);
    await progress(30_000, 5); // out of order
    await progress(99_999_999, 11); // clamped to the duration
    expect(h.profiles.samples).toEqual([
      // No subtitle chosen and none shown: the field is left out (S5), so the stored choice stays.
      { profileId: P1, itemId: ITEM, fileId: F1, positionMs: 60_000, durationMs: 9_840_000, at: 1_000_000, ended: false, audioTrackId: 's2' },
      expect.objectContaining({ positionMs: 9_840_000, ended: true }),
    ]);
  });

  it('404 for an unknown session or another profile’s session', async () => {
    const id = (await start({ itemId: ITEM })).body.sessionId;
    const body = { positionMs: 1, state: 'playing', clientTs: 1 };
    expect((await h.call('reportProgress', 'POST', `${SESSIONS}/nope/progress`, body)).status).toBe(404);
    expect((await h.call('reportProgress', 'POST', `${SESSIONS}/${id}/progress`, body, 't2')).status).toBe(404);
  });

  it('heartbeat expiry stops the stream (expired), keeps the last position, publishes the event; then 410', async () => {
    const id = (await start({ itemId: ITEM })).body.sessionId;
    await h.call('reportProgress', 'POST', `${SESSIONS}/${id}/progress`, { positionMs: 42_000, state: 'paused', clientTs: 1 });
    h.clock.now += 59_000;
    await h.expire();
    expect(h.delivery.ops()).toEqual(['start direct_stream']);
    h.clock.now += 2_000;
    await h.expire();
    expect(h.delivery.ops()).toEqual(['start direct_stream', 'stop st1 expired']);
    expect(h.events.at(-1)).toEqual({ type: 'playback.session_terminated', payload: { sessionId: id, profileId: P1, itemId: ITEM, reason: 'expired' } });
    expect(h.profiles.samples.at(-1)).toMatchObject({ positionMs: 42_000, ended: false });
    const r = await h.call('reportProgress', 'POST', `${SESSIONS}/${id}/progress`, { positionMs: 43_000, state: 'playing', clientTs: 2 });
    expect(r).toMatchObject({ status: 410, body: { code: 'SESSION_EXPIRED' } });
    expect((await h.call('changeTracks', 'POST', `${SESSIONS}/${id}/tracks`, { subtitleTrackId: null })).status).toBe(410);
    // stopPlayback stays idempotent and still keeps the client's final position.
    expect((await h.call('stopPlayback', 'POST', `${SESSIONS}/${id}/stop`, { positionMs: 43_500 })).status).toBe(204);
    expect(h.profiles.samples.at(-1)).toMatchObject({ positionMs: 43_500 });
  });

  it('stopPlayback stops the stream, records the final position, frees the slot; idempotent', async () => {
    const id = (await start({ itemId: ITEM })).body.sessionId;
    expect((await h.call('stopPlayback', 'POST', `${SESSIONS}/${id}/stop`, { positionMs: 9_838_000 })).status).toBe(204);
    expect(h.delivery.ops()).toEqual(['start direct_stream', 'stop st1 stopped']);
    expect(h.profiles.samples.at(-1)).toMatchObject({ positionMs: 9_838_000, ended: true });
    expect(h.events).toEqual([]);
    expect((await h.call('stopPlayback', 'POST', `${SESSIONS}/${id}/stop`, { positionMs: 9_838_000 })).status).toBe(204);
    expect((await h.call('stopPlayback', 'POST', `${SESSIONS}/unknown/stop`, { positionMs: 0 })).status).toBe(204);
    expect((await start({ itemId: ITEM_HD })).status).toBe(201);
  });
});

describe('reportPlaybackFailure (doc 04 §8, ADR 0003 D7)', () => {
  const fail = (id: string, body: Record<string, unknown>) => h.call('reportPlaybackFailure', 'POST', `${SESSIONS}/${id}/failure`, { positionMs: 120_000, error: 'MEDIA_ERR_DECODE', ...body });

  it('audio suspect in Direct Play: stop(old, replanned) then start(Direct Stream, audio converted), same sessionId, new token', async () => {
    const first = (await start({ itemId: ITEM_HD })).body;
    const r = await fail(first.sessionId, { suspect: 'audio' });
    expect(r.status).toBe(200);
    expect(r.body.sessionId).toBe(first.sessionId);
    expect(r.body.stream.url).not.toBe(first.stream.url);
    expect(r.body.mode).toBe('direct_stream');
    expect(r.body.resumePositionMs).toBe(120_000);
    expect(h.delivery.ops()).toEqual(['start direct_play', 'stop st1 replanned', 'start direct_stream']);
    expect(h.delivery.starts()[1]?.audio?.action).toMatchObject({ kind: 'convert', codec: 'flac' });
    expect(h.delivery.starts()[1]?.exclusions).toEqual([{ dimension: 'audio', action: 'copy', codec: 'aac', profile: 'LC', cause: 'client', error: 'MEDIA_ERR_DECODE' }]);
    expect((await h.call('listActiveSessions', 'GET', SESSIONS)).body.sessions[0].mode).toBe('direct_stream');
  });

  it('delivery’s terminal record wins over the client’s unknown suspect', async () => {
    const id = (await start({ itemId: ITEM })).body.sessionId;
    h.delivery.statuses.set('st1', {
      state: 'failed',
      failure: failure({ kind: 'aac_channel_config', class: 'format', suspect: 'audio', exclusion: { dimension: 'audio', action: 'convert', codec: 'flac', cause: 'server', error: 'aac_channel_config' } }),
    });
    await fail(id, { suspect: 'unknown', error: 'STREAM_FAILED' });
    expect(h.delivery.starts()[1]?.exclusions).toEqual([{ dimension: 'audio', action: 'convert', codec: 'flac', cause: 'server', error: 'aac_channel_config' }]);
  });

  it('delivery’s record wins even over a named suspect when terminal; its suspect is used without an exclusion', async () => {
    const id = (await start({ itemId: ITEM_HD })).body.sessionId;
    h.delivery.statuses.set('st1', { failure: failure({ suspect: 'video', terminal: true }) });
    await fail(id, { suspect: 'audio' });
    expect(h.delivery.starts()[1]?.exclusions).toEqual([{ dimension: 'video', fileId: F2, mode: 'direct_play', cause: 'server', error: 'process_exit' }]);
  });

  it('a failure delivery recovered from does not override the dimension the client named', async () => {
    const id = (await start({ itemId: ITEM_HD })).body.sessionId;
    h.delivery.statuses.set('st1', { failure: failure({ suspect: 'video', terminal: false, kind: 'restart_mismatch' }) });
    await fail(id, { suspect: 'audio' });
    expect(h.delivery.starts()[1]?.exclusions).toEqual([{ dimension: 'audio', action: 'copy', codec: 'aac', profile: 'LC', cause: 'client', error: 'MEDIA_ERR_DECODE' }]);
  });

  it('subtitle suspect: next treatment of the selected track (4K: dropped, playback goes on)', async () => {
    const id = (await start({ itemId: ITEM, subtitleTrackId: 's3' })).body.sessionId;
    const r = await fail(id, { suspect: 'subtitle', error: 'PGS_LOAD_FAILED' });
    expect(r.body.tracks.subtitles.some((t: any) => t.selected)).toBe(false);
    expect(r.body.reasons.join(' ')).toContain('Subtitles PGS (ita) cannot be shown');
    expect(h.delivery.starts()[1]?.subtitles.served.map((s) => s.trackId)).toEqual(['s4']);
    // Track ids are per file: the exclusion is pinned to the file it failed on.
    expect(h.delivery.starts()[1]?.exclusions).toEqual([
      { dimension: 'subtitle', trackId: 's3', delivery: 'client_render', fileId: F1, cause: 'client', error: 'PGS_LOAD_FAILED' },
    ]);
  });

  it('subtitle suspect with no subtitle shown: nothing to change, no attempt used', async () => {
    const id = (await start({ itemId: ITEM })).body.sessionId;
    const r = await fail(id, { suspect: 'subtitle' });
    expect(r.status).toBe(200);
    expect(h.delivery.ops()).toEqual(['start direct_stream']);
  });

  it('video suspect on 4K Direct Stream: no heavier mode → 422, session ended', async () => {
    const id = (await start({ itemId: ITEM })).body.sessionId;
    const r = await fail(id, { suspect: 'video' });
    expect(r.status).toBe(422);
    expect(r.body.detail).toContain('above 1080p');
    expect(h.delivery.ops()).toEqual(['start direct_stream', 'stop st1 stopped']);
    expect(h.events.at(-1)?.payload.reason).toBe('failed');
    expect((await h.callProblem('POST', `${SESSIONS}/${id}/failure`, { positionMs: 0, error: 'x' })).status).toBe(410);
  });

  it('at most 3 automatic attempts per StartPlayback, start retries and re-plans counted together', async () => {
    h.delivery.next.push({ ok: false, code: 'STREAM_FAILED', failure: failure({ suspect: 'audio', exclusion: null }) }); // attempt 1, at start
    const id = (await start({ itemId: ITEM_HD, capabilities: edge() })).body.sessionId;
    expect((await fail(id, { suspect: 'audio' })).status).toBe(200); // attempt 2
    expect((await fail(id, { suspect: 'audio' })).status).toBe(200); // attempt 3
    const r = await fail(id, { suspect: 'audio' });
    expect(r.status).toBe(422);
    expect(r.body.detail).toContain('The 3 automatic attempts of this playback are used up');
    expect(h.delivery.starts()).toHaveLength(4);
    // The formats excluded so far, one per attempt: the copy at start, then FLAC, then AAC.
    expect(h.delivery.starts()[3]?.exclusions.map((e) => [e.dimension, 'action' in e ? `${e.action}:${e.codec}` : '', e.cause])).toEqual([
      ['audio', 'copy:aac', 'server'],
      ['audio', 'convert:flac', 'client'],
      ['audio', 'convert:aac', 'client'],
    ]);
    expect((await h.call('listActiveSessions', 'GET', SESSIONS)).body.sessions).toEqual([]);
  });

  it('file_unavailable from delivery: the session ends with MEDIA_UNAVAILABLE', async () => {
    const id = (await start({ itemId: ITEM })).body.sessionId;
    h.delivery.statuses.set('st1', { state: 'failed', failure: failure({ kind: 'file_unavailable' }) });
    const r = await h.callProblem('POST', `${SESSIONS}/${id}/failure`, { positionMs: 0, error: 'STREAM_FAILED', suspect: 'unknown' });
    expect(r.body).toMatchObject({ status: 503, code: 'MEDIA_UNAVAILABLE' });
  });

  it('STREAM_PREPARING during a re-plan: 503 + Retry-After, the session stays open without a stream (S3)', async () => {
    const id = (await start({ itemId: ITEM_HD })).body.sessionId;
    h.delivery.next.push({ ok: false, code: 'STREAM_PREPARING', retryAfterMs: 1_000 });
    const r = await fail(id, { positionMs: 60_000, suspect: 'audio' });
    expect(r.status).toBe(503);
    expect(r.headers['retry-after']).toBe('1');
    expect((await h.call('listActiveSessions', 'GET', SESSIONS)).body.sessions).toMatchObject([{ sessionId: id }]);
    // Heartbeats keep it alive; the retry runs the same re-plan again, with the attempt given back.
    expect((await h.call('reportProgress', 'POST', `${SESSIONS}/${id}/progress`, { positionMs: 60_000, state: 'paused', clientTs: 1 })).status).toBe(204);
    const again = await fail(id, { positionMs: 60_000 });
    expect(again.status).toBe(200);
    expect(again.body.mode).toBe('direct_stream');
    expect(h.delivery.ops()).toEqual(['start direct_play', 'stop st1 replanned', 'start direct_stream', 'start direct_stream']);
    expect(h.delivery.starts()[2]?.exclusions).toHaveLength(1);
    // Two more automatic attempts are left.
    expect((await fail(id, { suspect: 'audio' })).status).toBe(200);
    expect((await fail(id, { suspect: 'audio' })).status).toBe(200);
    expect((await fail(id, { suspect: 'audio' })).status).toBe(422);
  });

  it('a session waiting for its stream still expires and still stops', async () => {
    const id = (await start({ itemId: ITEM_HD })).body.sessionId;
    h.delivery.next.push({ ok: false, code: 'STREAM_PREPARING', retryAfterMs: 1_000 });
    expect((await fail(id, { suspect: 'audio' })).status).toBe(503);
    expect((await h.call('stopPlayback', 'POST', `${SESSIONS}/${id}/stop`, { positionMs: 77_000 })).status).toBe(204);
    expect(h.profiles.stored.get(`${P1}/${ITEM_HD}`)).toMatchObject({ positionMs: 77_000 });
    const other = (await start({ itemId: ITEM_HD })).body.sessionId;
    h.delivery.next.push({ ok: false, code: 'STREAM_PREPARING', retryAfterMs: 1_000 });
    expect((await fail(other, { suspect: 'audio' })).status).toBe(503);
    h.clock.now += 61_000;
    await h.expire();
    expect(h.events.at(-1)?.payload).toMatchObject({ sessionId: other, reason: 'expired' });
  });
});

describe('changeTracks and changeVersion (doc 04 §6.3)', () => {
  const tracks = (id: string, body: Record<string, unknown>) => h.call('changeTracks', 'POST', `${SESSIONS}/${id}/tracks`, body);

  it('a switch between served subtitle tracks is local: no restart, availability refreshed', async () => {
    const id = (await start({ itemId: ITEM })).body.sessionId;
    h.delivery.statuses.set('st1', { subtitles: [{ trackId: 's4', availability: 'complete' }] });
    const r = await tracks(id, { subtitleTrackId: 's4' });
    expect(r.status).toBe(200);
    expect(r.body.tracks.subtitles.find((t: any) => t.id === 's4')).toMatchObject({ selected: true, availability: 'complete' });
    expect(h.delivery.ops()).toEqual(['start direct_stream']);
    await h.call('reportProgress', 'POST', `${SESSIONS}/${id}/progress`, { positionMs: 1_000, state: 'playing', clientTs: 1 });
    expect(h.profiles.samples.at(-1)?.subtitleTrackId).toBe('s4');
    expect((await tracks(id, { subtitleTrackId: null })).body.tracks.subtitles.some((t: any) => t.selected)).toBe(false);
    expect(h.delivery.ops()).toEqual(['start direct_stream']);
  });

  it('an audio change always re-plans (audio is muxed), keeping the local subtitle choice', async () => {
    const first = (await start({ itemId: ITEM })).body;
    await tracks(first.sessionId, { subtitleTrackId: 's4' });
    const r = await tracks(first.sessionId, { audioTrackId: 's1', positionMs: 500_000 });
    expect(r.body.sessionId).toBe(first.sessionId);
    expect(r.body.tracks.audio.find((t: any) => t.selected).id).toBe('s1');
    expect(r.body.tracks.subtitles.find((t: any) => t.selected).id).toBe('s4');
    expect(r.body.resumePositionMs).toBe(500_000);
    expect(h.delivery.ops()).toEqual(['start direct_stream', 'stop st1 replanned', 'start direct_stream']);
  });

  it('a subtitle that would need burn-in on 4K: 422, the running stream is left alone', async () => {
    const id = (await start({ itemId: ITEM })).body.sessionId;
    const r = await tracks(id, { subtitleTrackId: 's5' });
    expect(r.status).toBe(422);
    expect(r.body.detail).toContain('Subtitles VobSub (fre) cannot be shown');
    expect(h.delivery.ops()).toEqual(['start direct_stream']);
  });

  it('burn-in on and off re-plan on 1080p', async () => {
    const id = (await start({ itemId: ITEM_HD })).body.sessionId;
    const on = await tracks(id, { subtitleTrackId: 's2' });
    expect(on.body.mode).toBe('transcode');
    const off = await tracks(id, { subtitleTrackId: null });
    expect(off.body.mode).toBe('direct_play');
    expect(h.delivery.ops()).toEqual(['start direct_play', 'stop st1 replanned', 'start transcode', 'stop st2 replanned', 'start direct_play']);
  });

  it('404 for an unknown track', async () => {
    const id = (await start({ itemId: ITEM })).body.sessionId;
    expect((await tracks(id, { audioTrackId: 's9' })).status).toBe(404);
  });

  it('changeVersion moves to the other file, user changes use no automatic attempt', async () => {
    const item: PlayableItem = { ...uhd(), files: [...uhd().files, file(F2, facts([sdr1080(), aac(1, 'ita')], { durationMs: 9_840_000 }))] };
    h.catalog.items.set(ITEM, item);
    const id = (await start({ itemId: ITEM })).body.sessionId;
    for (const f of [F2, F1, F2, F1]) {
      const r = await h.call('changeVersion', 'POST', `${SESSIONS}/${id}/version`, { fileId: f, positionMs: 1_000 });
      expect(r.body.fileId).toBe(f);
    }
    expect((await h.call('changeVersion', 'POST', `${SESSIONS}/${id}/version`, { fileId: '01936f0e-0000-7000-8000-00000000dead' })).status).toBe(404);
  });
});

describe('explainPlaybackDecision', () => {
  it('runs the engine without starting anything', async () => {
    const r = await h.call('explainPlaybackDecision', 'POST', '/video/api/v1/admin/explain', { itemId: ITEM, capabilities: edge(), subtitleTrackId: 's3' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mode: 'direct_stream', fileId: F1, actions: { container: 'remux', video: 'none', audio: 'convert:flac', subtitles: 'remux' } });
    expect(r.body.candidates).toEqual([{ fileId: F1, mode: 'direct_stream', reasons: r.body.reasons }]);
    expect(h.delivery.calls).toEqual([]);
  });

  it('404 for an unknown item', async () => {
    expect((await h.call('explainPlaybackDecision', 'POST', '/video/api/v1/admin/explain', { itemId: 'nope', capabilities: chrome() })).status).toBe(404);
  });
});

describe('explainPlaybackDecision without a plan (doc 03 §6)', () => {
  const explain = (body: Record<string, unknown>) => h.call('explainPlaybackDecision', 'POST', '/video/api/v1/admin/explain', { capabilities: chrome(), ...body });

  it('200 with mode and fileId null, the reasons and one candidate per file', async () => {
    const caps = { ...firefox(), video: firefox().video.filter((v) => v.codec !== 'hevc') };
    const r = await explain({ itemId: ITEM, capabilities: caps });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mode: null, fileId: null, actions: {} });
    expect(r.body.reasons.join(' ')).toContain('above 1080p');
    expect(r.body.candidates).toEqual([{ fileId: F1, mode: null, reasons: r.body.reasons }]);
  });

  it('200 when no file is available, the unavailable file listed', async () => {
    h.catalog.items.set(ITEM_HD, hd({ files: [file(F2, hd().files[0]!.facts, false)] }));
    const r = await explain({ itemId: ITEM_HD });
    expect(r.body).toMatchObject({ mode: null, fileId: null, reasons: ['No file of the item is available'] });
    expect(r.body.candidates).toEqual([{ fileId: F2, mode: null, reasons: ['The file is not available (missing, or its library root is offline)'] }]);
  });
});

describe('track choices across versions and what is recorded (E1, S5, m13)', () => {
  /** 4K: TrueHD eng s1, AC-3 ita s2; 1080p: AAC eng s1, AC-3 ita s2 (another codec for English). */
  const twoVersions = (): PlayableItem => ({
    ...uhd(),
    files: [
      file(F1, facts([video(), audio(1), ac3(2, 'ita'), sub(3)], { durationMs: 9_840_000 })),
      file(F2, facts([sdr1080(), aac(1, 'eng', { channels: 6, channelLayout: '5.1' }), ac3(2, 'ita')], { durationMs: 9_840_000 })),
    ],
  });

  it('the last choice is remembered by file: on another version the track is matched by descriptor', async () => {
    h.catalog.items.set(ITEM, twoVersions());
    h.profiles.last.set(`${P1}/${ITEM}`, { fileId: F1, audioTrackId: 's2', subtitleTrackId: null });
    const r = await start({ itemId: ITEM, fileId: F2 });
    expect(r.body.tracks.audio.find((t: any) => t.selected).id).toBe('s2'); // AC-3 ita on F2 too
  });

  it('changeVersion keeps the explicit audio language as a remembered choice (m13)', async () => {
    h.catalog.items.set(ITEM, twoVersions());
    const id = (await start({ itemId: ITEM, fileId: F1, audioTrackId: 's1' })).body.sessionId; // TrueHD eng, prefs say ita
    const r = await h.call('changeVersion', 'POST', `${SESSIONS}/${id}/version`, { fileId: F2, positionMs: 1_000 });
    expect(r.body.fileId).toBe(F2);
    expect(r.body.tracks.audio.find((t: any) => t.selected).id).toBe('s1'); // AAC eng: the language, not the prefs
  });

  it('a dropped subtitle is recorded as the selected track, never as off (S5)', async () => {
    const id = (await start({ itemId: ITEM, subtitleTrackId: 's5' })).body.sessionId; // VobSub on 4K: dropped
    await h.call('reportProgress', 'POST', `${SESSIONS}/${id}/progress`, { positionMs: 1_000, state: 'playing', clientTs: 1 });
    expect(h.profiles.samples.at(-1)?.subtitleTrackId).toBe('s5');
    await h.call('changeTracks', 'POST', `${SESSIONS}/${id}/tracks`, { subtitleTrackId: null });
    await h.call('reportProgress', 'POST', `${SESSIONS}/${id}/progress`, { positionMs: 2_000, state: 'playing', clientTs: 2 });
    expect(h.profiles.samples.at(-1)?.subtitleTrackId).toBeNull();
  });
});

describe('re-plan robustness (S1, S2, S4, S6, m1–m12)', () => {
  const fail = (id: string, body: Record<string, unknown> = {}) => h.call('reportPlaybackFailure', 'POST', `${SESSIONS}/${id}/failure`, { positionMs: 120_000, error: 'MEDIA_ERR_DECODE', suspect: 'audio', ...body });
  const tracks = (id: string, body: Record<string, unknown>, token = 't1') => h.call('changeTracks', 'POST', `${SESSIONS}/${id}/tracks`, body, token);

  it('S1: two failure reports of the same stream re-plan once', async () => {
    const id = (await start({ itemId: ITEM_HD })).body.sessionId;
    const gate = h.delivery.gateStart();
    const first = fail(id);
    await gate.reached;
    const queued = h.nextQueued();
    const second = fail(id); // queued behind the first, about the stream that is gone
    await queued;
    gate.release();
    const [a, b] = await Promise.all([first, second]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(b.body.stream.url).toBe(a.body.stream.url);
    expect(h.delivery.ops()).toEqual(['start direct_play', 'stop st1 replanned', 'start direct_stream']);
  });

  it('S1: the old player’s failure report after changeTracks replaced its stream changes nothing', async () => {
    const id = (await start({ itemId: ITEM })).body.sessionId;
    const gate = h.delivery.gateStart();
    const change = tracks(id, { audioTrackId: 's1' });
    await gate.reached;
    const queued = h.nextQueued();
    const stale = fail(id, { suspect: 'unknown', error: 'HTTP_410' });
    await queued;
    gate.release();
    const [c, f] = await Promise.all([change, stale]);
    expect(f.status).toBe(200);
    expect(f.body.stream.url).toBe(c.body.stream.url);
    expect(h.delivery.starts()).toHaveLength(2);
  });

  it('S2: a re-plan onto a Transcode holds the transcode slot while the old stream stops', async () => {
    await h.close();
    h = await playbackHarness({ env: { MAX_SESSIONS: '2', MAX_TRANSCODES: '1' } });
    h.catalog.items.set(ITEM_HD, hd());
    const a = (await start({ itemId: ITEM_HD })).body.sessionId; // Direct Play
    const stopping = h.delivery.gateStop();
    const burnOn = tracks(a, { subtitleTrackId: 's2' });
    await stopping.reached;
    const b = await start({ itemId: ITEM_HD, subtitleTrackId: 's2' }, 't2');
    expect(b.body.mode).toBe('direct_play'); // slot taken: burn-in dropped
    stopping.release();
    expect((await burnOn).body.mode).toBe('transcode');
  });

  it('the transcode slot is freed when the session ends and when it re-plans away', async () => {
    await h.close();
    h = await playbackHarness({ env: { MAX_SESSIONS: '2', MAX_TRANSCODES: '1' } });
    h.catalog.items.set(ITEM_HD, hd());
    const a = (await start({ itemId: ITEM_HD, subtitleTrackId: 's2' })).body;
    expect(a.mode).toBe('transcode');
    await tracks(a.sessionId, { subtitleTrackId: null }); // away from the Transcode
    const b = (await start({ itemId: ITEM_HD, subtitleTrackId: 's2' }, 't2')).body;
    expect(b.mode).toBe('transcode');
    await h.call('stopPlayback', 'POST', `${SESSIONS}/${b.sessionId}/stop`, { positionMs: 0 }, 't2');
    expect((await tracks(a.sessionId, { subtitleTrackId: 's2' })).body.mode).toBe('transcode');
  });

  it('S4: a stop after expiry records its sample dated at the close', async () => {
    const id = (await start({ itemId: ITEM })).body.sessionId;
    h.clock.now += 61_000;
    await h.expire();
    const closedAt = h.clock.now;
    h.clock.now += 3_600_000;
    await h.call('stopPlayback', 'POST', `${SESSIONS}/${id}/stop`, { positionMs: 50_000 });
    expect(h.profiles.samples.at(-1)).toMatchObject({ positionMs: 50_000, at: closedAt });
  });

  it('tombstones are pruned after their TTL: 410, then 404', async () => {
    const id = (await start({ itemId: ITEM })).body.sessionId;
    await h.call('stopPlayback', 'POST', `${SESSIONS}/${id}/stop`, { positionMs: 0 });
    const progress = () => h.call('reportProgress', 'POST', `${SESSIONS}/${id}/progress`, { positionMs: 0, state: 'playing', clientTs: 1 });
    expect((await progress()).status).toBe(410);
    h.clock.now += 6 * 3_600_000 + 1;
    await h.expire();
    expect((await progress()).status).toBe(404);
  });

  it('S6: a dead stream with nothing derivable from the suspect escalates, never returns the same stream', async () => {
    const id = (await start({ itemId: ITEM_HD })).body.sessionId;
    h.delivery.statuses.set('st1', { state: 'failed', failure: failure({ suspect: 'subtitle', terminal: true }) });
    const r = await fail(id, { suspect: 'subtitle' });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe('direct_stream');
    expect(h.delivery.starts()[1]?.exclusions).toMatchObject([{ dimension: 'video', fileId: F2, mode: 'direct_play', cause: 'server' }]);
  });

  it('m1: a start finishing after shutdown is stopped and refused; later starts are refused', async () => {
    const gate = h.delivery.gateStart();
    const pendingStart = start({ itemId: ITEM });
    await gate.reached;
    const down = h.shutdown();
    gate.release();
    expect((await pendingStart).body).toMatchObject({ status: 503, code: 'MEDIA_UNAVAILABLE' });
    await down;
    expect(h.delivery.ops()).toEqual(['start direct_stream', 'stop st1 shutdown']);
    expect((await start({ itemId: ITEM_HD })).status).toBe(503);
  });

  it('shutdown closes every session through its queue, after a re-plan in flight', async () => {
    const id = (await start({ itemId: ITEM_HD })).body.sessionId;
    const gate = h.delivery.gateStart();
    const replan = fail(id);
    await gate.reached;
    const down = h.shutdown();
    gate.release();
    await replan;
    await down;
    expect(h.delivery.ops()).toEqual(['start direct_play', 'stop st1 replanned', 'start direct_stream', 'stop st2 shutdown']);
    expect((await h.call('listActiveSessions', 'GET', SESSIONS)).body.sessions).toEqual([]);
  });

  it('terminate during a re-plan runs after it and stops the new stream', async () => {
    const id = (await start({ itemId: ITEM_HD })).body.sessionId;
    const gate = h.delivery.gateStart();
    const replan = fail(id);
    await gate.reached;
    const queued = h.nextQueued();
    const term = h.call('terminateSession', 'DELETE', `${SESSIONS}/${id}`);
    await queued;
    gate.release();
    expect((await replan).status).toBe(200);
    expect((await term).status).toBe(204);
    expect(h.delivery.ops()).toEqual(['start direct_play', 'stop st1 replanned', 'start direct_stream', 'stop st2 terminated']);
  });

  it('m2: a stop queued behind a failing re-plan still records the client’s position', async () => {
    const id = (await start({ itemId: ITEM_HD })).body.sessionId;
    const gate = h.delivery.gateStart();
    h.delivery.next.push({ ok: false, code: 'MEDIA_UNAVAILABLE', detail: 'root Film offline' });
    const replan = fail(id, { positionMs: 10_000 });
    await gate.reached;
    const queued = h.nextQueued();
    const stop = h.call('stopPlayback', 'POST', `${SESSIONS}/${id}/stop`, { positionMs: 33_000 });
    await queued;
    gate.release();
    expect((await replan).status).toBe(503);
    expect((await stop).status).toBe(204);
    expect(h.profiles.stored.get(`${P1}/${ITEM_HD}`)).toMatchObject({ positionMs: 33_000 });
  });

  it('m5: a second start of the same profile waits for the first, then gets 409 listing it', async () => {
    const gate = h.delivery.gateStart();
    const first = start({ itemId: ITEM });
    await gate.reached;
    const queued = h.nextQueued();
    const second = start({ itemId: ITEM_HD });
    await queued;
    gate.release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(409);
    expect(b.body.activeSessions).toMatchObject([{ sessionId: a.body.sessionId }]);
  });

  it('m6: a stop(old) that throws is retried once, then the re-plan goes on', async () => {
    const id = (await start({ itemId: ITEM_HD })).body.sessionId;
    h.delivery.stopFailures = 2; // tried twice, then left to delivery's idle kill
    const r = await fail(id);
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe('direct_stream');
    expect(h.delivery.ops()).toEqual(['start direct_play', 'stop st1 replanned', 'stop st1 replanned', 'start direct_stream']);
  });

  it('m7: an io_error is retried with the same plan and no exclusion; once the budget is used, 500 STREAM_FAILED', async () => {
    const io = () => ({ ok: false as const, code: 'STREAM_FAILED' as const, failure: failure({ kind: 'io_error', class: 'stream' }) });
    h.delivery.next.push(io());
    const ok = await start({ itemId: ITEM_HD });
    expect(ok.status).toBe(201);
    expect(h.delivery.ops()).toEqual(['start direct_play', 'start direct_play']);
    expect(h.delivery.starts()[1]?.exclusions).toEqual([]);
    await h.call('stopPlayback', 'POST', `${SESSIONS}/${ok.body.sessionId}/stop`, { positionMs: 0 });
    for (let i = 0; i < 4; i++) h.delivery.next.push(io());
    const r = await start({ itemId: ITEM_HD });
    expect(r).toMatchObject({ status: 500, body: { code: 'STREAM_FAILED' } });
  });

  it('m8: a required subtitle dropped by a server-side re-plan inside the start is refused (422)', async () => {
    const id = (await start({ itemId: ITEM_HD })).body.sessionId;
    h.delivery.next.push({
      ok: false,
      code: 'STREAM_FAILED',
      failure: failure({ kind: 'process_exit', class: 'format', suspect: 'subtitle', exclusion: { dimension: 'subtitle', trackId: 's2', delivery: 'burned', fileId: F2, cause: 'server', error: 'process_exit' } }),
    });
    const r = await tracks(id, { subtitleTrackId: 's2' });
    expect(r.status).toBe(422);
    expect(r.body.detail).toContain('cannot be shown');
  });

  it('m10: a failing event bus never replaces the outcome', async () => {
    const id = (await start({ itemId: ITEM })).body.sessionId;
    h.eventsFail.on = true;
    expect((await h.call('terminateSession', 'DELETE', `${SESSIONS}/${id}`)).status).toBe(204);
    expect(h.delivery.ops()).toEqual(['start direct_stream', 'stop st1 terminated']);
  });

  it('m11: an item removed mid-session answers 410 to a re-plan', async () => {
    const id = (await start({ itemId: ITEM })).body.sessionId;
    h.catalog.items.delete(ITEM);
    const r = await tracks(id, { audioTrackId: 's1' });
    expect(r).toMatchObject({ status: 410, body: { code: 'SESSION_EXPIRED', detail: 'The item was removed from the library' } });
  });

  it('m12: an override with an invalid pattern is ignored', async () => {
    await h.close();
    h = await playbackHarness({ overrides: [{ id: 'broken', match: { modelPattern: '([' }, removeHdr: ['HDR10'] }] });
    h.catalog.items.set(ITEM, uhd());
    expect((await start({ itemId: ITEM })).status).toBe(201);
  });

  it('a profile deleted before the start: 404', async () => {
    h.profiles.prefs.delete(P1);
    expect((await start({ itemId: ITEM })).body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});

describe('changeVersion details (m3, m4) and the fallback to another file', () => {
  const both = (): PlayableItem => ({ ...uhd(), files: [...uhd().files, file(F2, facts([sdr1080(), ac3(1, 'ita'), sub(2)], { durationMs: 9_840_000 }))] });
  const fail = (id: string, body: Record<string, unknown>) => h.call('reportPlaybackFailure', 'POST', `${SESSIONS}/${id}/failure`, { positionMs: 120_000, error: 'MEDIA_ERR_DECODE', ...body });

  it('a re-plan falls back to the other file when the pinned one has no plan', async () => {
    h.catalog.items.set(ITEM, both());
    const id = (await start({ itemId: ITEM })).body.sessionId;
    const r = await fail(id, { suspect: 'video' }); // 4K: Direct Stream excluded, no 4K Transcode
    expect(r.status).toBe(200);
    expect(r.body.fileId).toBe(F2);
  });

  it('changeVersion to the file already playing still pins it: no fallback afterwards (m4)', async () => {
    h.catalog.items.set(ITEM, both());
    const id = (await start({ itemId: ITEM })).body.sessionId;
    expect((await h.call('changeVersion', 'POST', `${SESSIONS}/${id}/version`, { fileId: F1 })).body.fileId).toBe(F1);
    expect((await fail(id, { suspect: 'video' })).status).toBe(422);
  });

  it('changeVersion keeps the exclusions, the subtitle ones pinned to their file (m3)', async () => {
    h.catalog.items.set(ITEM, both());
    const id = (await start({ itemId: ITEM, fileId: F1, subtitleTrackId: 's3' })).body.sessionId;
    await fail(id, { suspect: 'subtitle', error: 'PGS_LOAD_FAILED' });
    await h.call('changeVersion', 'POST', `${SESSIONS}/${id}/version`, { fileId: F2 });
    expect(h.delivery.starts().at(-1)?.exclusions).toMatchObject([{ dimension: 'subtitle', trackId: 's3', fileId: F1 }]);
  });

  it('503 + Retry-After on changeTracks and changeVersion; the session stays and the retry starts the stream', async () => {
    h.catalog.items.set(ITEM, both());
    const id = (await start({ itemId: ITEM })).body.sessionId;
    h.delivery.next.push({ ok: false, code: 'STREAM_PREPARING', retryAfterMs: 4_000 });
    const t = await h.call('changeTracks', 'POST', `${SESSIONS}/${id}/tracks`, { audioTrackId: 's1' });
    expect(t).toMatchObject({ status: 503, headers: { 'retry-after': '4' } });
    h.delivery.next.push({ ok: false, code: 'STREAM_PREPARING', retryAfterMs: 2_000 });
    const v = await h.call('changeVersion', 'POST', `${SESSIONS}/${id}/version`, { fileId: F2 });
    expect(v).toMatchObject({ status: 503, headers: { 'retry-after': '2' } });
    const again = await h.call('changeVersion', 'POST', `${SESSIONS}/${id}/version`, { fileId: F2 });
    expect(again.status).toBe(200);
    expect(again.body.fileId).toBe(F2);
  });
});

describe('track memory across versions (E-1, E-2, E-3)', () => {
  /** 4K: TrueHD eng s1, AC-3 ita s2, PGS ita s3. 1080p: AAC eng s1, AC-3 ita s2, PGS eng s3, PGS ita s4. */
  const twoVersions = (): PlayableItem => ({
    ...uhd(),
    files: [
      file(F1, facts([video(), audio(1), ac3(2, 'ita'), sub(3)], { durationMs: 9_840_000 })),
      file(F2, facts([sdr1080(), aac(1, 'eng'), ac3(2, 'ita'), sub(3, { language: 'eng' }), sub(4)], { durationMs: 9_840_000 })),
    ],
  });
  /** 1080p: AAC ita, PGS ita forced s2, PGS ita s3. */
  const withForced = (): PlayableItem =>
    hd({ files: [file(F2, facts([sdr1080(), aac(1, 'ita'), sub(2, { forced: true }), sub(3)], { durationMs: 10_000_000 }))] });
  const ALWAYS_ITA = { audioLanguages: ['ita', 'eng'], subtitleLanguages: ['ita'], subtitleMode: 'always' as const };
  const shownSub = (body: any): string | null => body.tracks.subtitles.find((t: any) => t.selected)?.id ?? null;
  const progress = (id: string, positionMs: number, clientTs: number) => h.call('reportProgress', 'POST', `${SESSIONS}/${id}/progress`, { positionMs, state: 'playing', clientTs });
  const stop = (id: string, positionMs: number) => h.call('stopPlayback', 'POST', `${SESSIONS}/${id}/stop`, { positionMs });

  /** The real profiles rules (profiles/watch.ts) behind the fake port, on the harness DB. */
  function useRealWatch(itemId: string): void {
    seedCatalog(h.db).item(itemId);
    h.db.$client.prepare(`INSERT INTO profile (id, name, prefs, created_at) VALUES (?, 'P1', '{}', 0)`).run(P1);
    const watch = createWatchState({ db: h.db, now: () => h.clock.now, catalog: () => fakeCatalogRead(h.db), profileExists: () => true, log: pino({ level: 'silent' }) });
    h.profiles.recordProgress = (s) => {
      h.profiles.samples.push(s);
      watch.recordProgress(s);
    };
    h.profiles.lastTrackChoice = (p, i) => watch.lastTrackChoice(p, i);
  }

  it('E-1: an unknown subtitle choice leaves the prefs to decide (real watch rules)', async () => {
    useRealWatch(ITEM);
    const a = (await start({ itemId: ITEM })).body.sessionId; // prefs off: nothing shown
    await progress(a, 600_000, 1);
    await stop(a, 600_000);
    expect(h.profiles.samples.at(-1)).not.toHaveProperty('subtitleTrackId');
    expect(h.profiles.lastTrackChoice(P1, ITEM)).toEqual({ fileId: F1, audioTrackId: 's2' });
    h.profiles.prefs.set(P1, ALWAYS_ITA);
    expect(shownSub((await start({ itemId: ITEM })).body)).toBe('s3'); // not read as off
  });

  it('E-1: an unknown subtitle in the fake last choice is not off either', async () => {
    h.profiles.prefs.set(P1, ALWAYS_ITA);
    h.profiles.last.set(`${P1}/${ITEM}`, { fileId: F1, audioTrackId: 's2' });
    expect(shownSub((await start({ itemId: ITEM })).body)).toBe('s3');
  });

  it('E-1: off shows the forced track in the audio language, is recorded as off and remembered as off', async () => {
    useRealWatch(ITEM_HD);
    h.catalog.items.set(ITEM_HD, withForced());
    const id = (await start({ itemId: ITEM_HD, subtitleTrackId: 's3' })).body.sessionId;
    const off = await h.call('changeTracks', 'POST', `${SESSIONS}/${id}/tracks`, { subtitleTrackId: null });
    expect(off.status).toBe(200);
    expect(shownSub(off.body)).toBe('s2'); // forced ita, switched locally
    expect(h.delivery.starts()).toHaveLength(1);
    await progress(id, 600_000, 1);
    expect(h.profiles.samples.at(-1)?.subtitleTrackId).toBeNull();
    await stop(id, 600_000);
    h.profiles.prefs.set(P1, ALWAYS_ITA);
    const again = await start({ itemId: ITEM_HD });
    expect(shownSub(again.body)).toBe('s2'); // remembered off beats the prefs, the forced track stays
  });

  it('E-2: a version change never stores one file’s subtitle under the other (real watch rules)', async () => {
    useRealWatch(ITEM);
    h.catalog.items.set(ITEM, twoVersions());
    const a = (await start({ itemId: ITEM, fileId: F1, subtitleTrackId: 's3' })).body.sessionId; // PGS ita on F1
    await progress(a, 600_000, 1);
    await stop(a, 600_000);
    expect(h.profiles.lastTrackChoice(P1, ITEM)).toEqual({ fileId: F1, audioTrackId: 's2', subtitleTrackId: 's3' });
    const b = await start({ itemId: ITEM, fileId: F2 });
    expect(shownSub(b.body)).toBe('s4'); // the ita PGS by descriptor, not F2's s3 (eng)
    await stop(b.body.sessionId, 610_000);
    expect(h.profiles.lastTrackChoice(P1, ITEM)).toEqual({ fileId: F2, audioTrackId: 's2', subtitleTrackId: 's4' });
  });

  it('E-2: a sample on another file with the subtitle unknown drops the old file’s subtitle (real watch rules)', async () => {
    useRealWatch(ITEM);
    h.catalog.items.set(ITEM, { ...twoVersions(), files: [twoVersions().files[0]!, file(F2, facts([sdr1080(), ac3(2, 'ita'), sub(3, { language: 'eng' })], { durationMs: 9_840_000 }))] });
    const a = (await start({ itemId: ITEM, fileId: F1, subtitleTrackId: 's3' })).body.sessionId;
    await stop(a, 600_000);
    const b = (await start({ itemId: ITEM, fileId: F2 })).body; // no ita subtitle on F2, prefs off: none
    expect(shownSub(b)).toBeNull();
    await stop(b.sessionId, 610_000);
    expect(h.profiles.samples.at(-1)).not.toHaveProperty('subtitleTrackId');
    expect(h.profiles.lastTrackChoice(P1, ITEM)).toEqual({ fileId: F2, audioTrackId: 's2' }); // not F1's s3
  });

  it('E-2: changeVersion carries the explicit subtitle by descriptor, and off as off', async () => {
    h.catalog.items.set(ITEM, twoVersions());
    h.profiles.prefs.set(P1, ALWAYS_ITA);
    const a = (await start({ itemId: ITEM, fileId: F1, subtitleTrackId: 's3' })).body.sessionId;
    expect(shownSub((await h.call('changeVersion', 'POST', `${SESSIONS}/${a}/version`, { fileId: F2 })).body)).toBe('s4');
    await stop(a, 0);
    const b = (await start({ itemId: ITEM, fileId: F1, subtitleTrackId: null })).body.sessionId;
    expect(shownSub((await h.call('changeVersion', 'POST', `${SESSIONS}/${b}/version`, { fileId: F2 })).body)).toBeNull(); // prefs would pick s4
  });

  it('E-3: track ids without fileId on an item with several versions: 400 on start and explain', async () => {
    h.catalog.items.set(ITEM, twoVersions());
    const detail = 'fileId is required with track ids when the item has several versions';
    expect((await start({ itemId: ITEM, audioTrackId: 's1' })).body).toMatchObject({ status: 400, code: 'VALIDATION_FAILED', detail });
    expect((await start({ itemId: ITEM, subtitleTrackId: 's3' })).status).toBe(400);
    const explain = await h.call('explainPlaybackDecision', 'POST', '/video/api/v1/admin/explain', { itemId: ITEM, capabilities: chrome(), audioTrackId: 's1' });
    expect(explain.body).toMatchObject({ status: 400, code: 'VALIDATION_FAILED', detail });
    expect(h.delivery.calls).toEqual([]);
    const off = await start({ itemId: ITEM, subtitleTrackId: null }); // off names no track
    expect(off.status).toBe(201);
    await stop(off.body.sessionId, 0);
    expect((await start({ itemId: ITEM_HD, audioTrackId: 's1' })).status).toBe(201); // one version: as before
  });
});

describe('sessions waiting without a stream (S3 follow-ups)', () => {
  const tracks = (id: string, body: Record<string, unknown>, token = 't1') => h.call('changeTracks', 'POST', `${SESSIONS}/${id}/tracks`, body, token);
  const io = () => ({ ok: false as const, code: 'STREAM_FAILED' as const, failure: failure({ kind: 'io_error', class: 'stream' }) });
  const preparing = () => ({ ok: false as const, code: 'STREAM_PREPARING' as const, retryAfterMs: 1_000 });
  /** 1080p with two audio tracks, so an audio change re-plans: AAC ita s1, AAC eng s3, VobSub s2. */
  const hd2 = () => hd({ files: [file(F2, facts([sdr1080(), aac(1, 'ita'), sub(2, { codec: 'dvd_subtitle' }), aac(3, 'eng')], { durationMs: 10_000_000 }))] });
  async function waiting(itemId = ITEM_HD, body: Record<string, unknown> = { audioTrackId: 's3' }): Promise<string> {
    if (itemId === ITEM_HD) h.catalog.items.set(ITEM_HD, hd2());
    const id = (await start({ itemId })).body.sessionId;
    h.delivery.next.push(preparing());
    expect((await tracks(id, body)).status).toBe(503);
    return id;
  }

  it('shutdown closes a waiting session without a stop call', async () => {
    const id = await waiting();
    await h.shutdown();
    expect(h.delivery.ops()).toEqual(['start direct_stream', 'stop st1 replanned', 'start direct_stream']); // the last start answered STREAM_PREPARING
    expect((await h.call('listActiveSessions', 'GET', SESSIONS)).body.sessions).toEqual([]);
    expect((await h.call('reportProgress', 'POST', `${SESSIONS}/${id}/progress`, { positionMs: 0, state: 'playing', clientTs: 1 })).status).toBe(410);
  });

  it('terminate closes a waiting session, publishes the event, no stop call', async () => {
    const id = await waiting();
    expect((await h.call('terminateSession', 'DELETE', `${SESSIONS}/${id}`)).status).toBe(204);
    expect(h.delivery.ops()).toEqual(['start direct_stream', 'stop st1 replanned', 'start direct_stream']); // the last start answered STREAM_PREPARING
    expect(h.events.at(-1)?.payload).toMatchObject({ sessionId: id, reason: 'terminated' });
    expect((await tracks(id, { audioTrackId: 's3' })).status).toBe(410);
  });

  it('refund: only the re-plan’s own attempt is given back, a server retry before the wait stays counted', async () => {
    h.catalog.items.set(ITEM_HD, hd2());
    const id = (await start({ itemId: ITEM_HD })).body.sessionId;
    h.delivery.next.push(io(), preparing()); // a user change: one server retry (attempt 1), then the wait
    expect((await tracks(id, { audioTrackId: 's3' })).status).toBe(503);
    h.delivery.next.push(io(), io(), io()); // attempts 2 and 3, then the budget is used up
    expect((await tracks(id, { audioTrackId: 's3' })).body).toMatchObject({ status: 500, code: 'STREAM_FAILED' });
  });

  it('a waiting session holds no transcode slot', async () => {
    await h.close();
    h = await playbackHarness({ env: { MAX_SESSIONS: '2', MAX_TRANSCODES: '1' } });
    h.catalog.items.set(ITEM_HD, hd2());
    const a = (await start({ itemId: ITEM_HD, subtitleTrackId: 's2' })).body;
    expect(a.mode).toBe('transcode');
    h.delivery.next.push(preparing());
    expect((await tracks(a.sessionId, { audioTrackId: 's3' })).status).toBe(503); // waiting, no stream
    const b = await start({ itemId: ITEM_HD, subtitleTrackId: 's2' }, 't2');
    expect(b.body.mode).toBe('transcode');
  });

  it('changeTracks while a changeVersion waits builds on the waiting change, on its file', async () => {
    const both = (): PlayableItem => ({ ...uhd(), files: [...uhd().files, file(F2, facts([sdr1080(), ac3(1, 'ita'), aac(2, 'eng'), sub(3)], { durationMs: 9_840_000 }))] });
    h.catalog.items.set(ITEM, both());
    const id = (await start({ itemId: ITEM, fileId: F1 })).body.sessionId;
    h.delivery.next.push(preparing());
    expect((await h.call('changeVersion', 'POST', `${SESSIONS}/${id}/version`, { fileId: F2 })).status).toBe(503);
    const r = await tracks(id, { audioTrackId: 's2' }); // s2 of F2 (AAC eng), not of F1
    expect(r.status).toBe(200);
    expect(r.body.fileId).toBe(F2);
    expect(r.body.tracks.audio.find((t: any) => t.selected)).toMatchObject({ id: 's2', codec: 'aac' });
  });

  it('a change refused while waiting: back to the last working tracks, 422 for the change', async () => {
    const id = await waiting(ITEM, { audioTrackId: 's1' }); // 4K: TrueHD eng instead of AC-3 ita
    const r = await tracks(id, { subtitleTrackId: 's5' }); // VobSub on 4K: cannot be shown
    expect(r).toMatchObject({ status: 422, body: { code: 'NO_COMPATIBLE_PLAN' } });
    expect(r.body.detail).not.toContain('closed');
    expect(h.delivery.ops()).toEqual(['start direct_stream', 'stop st1 replanned', 'start direct_stream', 'start direct_stream']);
    expect(h.delivery.starts()[2]?.audio?.source.trackId).toBe(h.delivery.starts()[0]?.audio?.source.trackId);
    expect((await h.call('listActiveSessions', 'GET', SESSIONS)).body.sessions).toMatchObject([{ sessionId: id }]);
    expect((await tracks(id, {})).status).toBe(200); // it has a stream again
  });

  it('a change refused while waiting, and the last working tracks fail too: the session is closed', async () => {
    const id = await waiting(ITEM, { audioTrackId: 's1' });
    h.delivery.next.push({ ok: false, code: 'STREAM_FAILED', failure: failure({ class: 'format', suspect: 'video' }) }); // 4K: no heavier mode
    const r = await tracks(id, { subtitleTrackId: 's5' });
    expect(r).toMatchObject({ status: 422, body: { code: 'NO_COMPATIBLE_PLAN' } });
    expect(r.body.detail).toContain('The session was closed');
    expect((await h.call('listActiveSessions', 'GET', SESSIONS)).body.sessions).toEqual([]);
    expect((await tracks(id, {})).status).toBe(410);
  });

});

describe('waiting without a stream is capped (PLAYBACK_PREPARING_MAX_S, M3)', () => {
  const preparing = () => ({ ok: false as const, code: 'STREAM_PREPARING' as const, retryAfterMs: 1_000 });
  beforeEach(async () => {
    await h.close();
    h = await playbackHarness({ env: { PLAYBACK_PREPARING_MAX_S: '30' } });
    h.catalog.items.set(ITEM, uhd());
    h.catalog.items.set(ITEM_HD, hd());
  });

  it('StartPlayback retried on STREAM_PREPARING: 500 STREAM_FAILED past the cap, then a fresh start works', async () => {
    for (let i = 0; i < 3; i++) {
      h.delivery.next.push(preparing());
      expect((await start({ itemId: ITEM })).status).toBe(503);
      h.clock.now += 10_000;
    }
    h.delivery.next.push(preparing());
    const r = await h.callProblem('POST', SESSIONS, { capabilities: chrome(), itemId: ITEM });
    expect(r.body).toMatchObject({ status: 500, code: 'STREAM_FAILED' });
    expect(r.body.detail).toContain('PLAYBACK_PREPARING_MAX_S');
    expect((await start({ itemId: ITEM })).status).toBe(201);
  });

  it('the wait is per profile and item, and a pause longer than the session timeout starts a new one', async () => {
    h.delivery.next.push(preparing());
    expect((await start({ itemId: ITEM })).status).toBe(503);
    h.clock.now += 20_000;
    h.delivery.next.push(preparing());
    expect((await start({ itemId: ITEM_HD })).status).toBe(503); // another item: its own wait
    h.clock.now += 61_000; // longer than the session timeout: the client gave up
    h.delivery.next.push(preparing());
    expect((await start({ itemId: ITEM })).status).toBe(503);
  });

  it('a session waiting for its stream (re-plan) ends with 500 STREAM_FAILED past the cap', async () => {
    const fail = (id: string) => h.callProblem('POST', `${SESSIONS}/${id}/failure`, { positionMs: 60_000, error: 'MEDIA_ERR_DECODE', suspect: 'audio' });
    const id = (await start({ itemId: ITEM_HD })).body.sessionId;
    h.delivery.next.push(preparing());
    expect((await fail(id)).body).toMatchObject({ status: 503, code: 'STREAM_PREPARING' });
    h.clock.now += 20_000;
    h.delivery.next.push(preparing());
    expect((await fail(id)).body).toMatchObject({ status: 503, code: 'STREAM_PREPARING' });
    h.clock.now += 10_000;
    h.delivery.next.push(preparing());
    const r = await fail(id);
    expect(r.body).toMatchObject({ status: 500, code: 'STREAM_FAILED' });
    expect(h.events.at(-1)).toMatchObject({ type: 'playback.session_terminated', payload: { sessionId: id, reason: 'failed' } });
    expect((await h.call('listActiveSessions', 'GET', SESSIONS)).body.sessions).toEqual([]);
    // The stream was stopped by the first re-plan: no second stop.
    expect(h.delivery.ops()).toEqual(['start direct_play', 'stop st1 replanned', 'start direct_stream', 'start direct_stream', 'start direct_stream']);
  });
});
