// Data-plane routes (contract paths/media.yaml), owned by delivery (C1). Every session resource answers
// with Cache-Control: no-store; the token is masked in the logs by the server's serializer. Bodies being
// sent are registered with the stream, so stop and shutdown can cut them.
import { ReadStream } from 'node:fs';
import { basename, dirname } from 'node:path';
import send from '@fastify/send';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../../app/config.ts';
import { type Handlers, typed } from '../../app/http.ts';
import { ProblemError } from '../../app/problem.ts';
import type { ServedSubtitle } from '../../shared/playback-plan.ts';
import { resolveMediaFile } from './media-file.ts';
import { INIT_SEGMENT, parseHlsResource } from './playlist.ts';
import type { Delivery, StreamRecord } from './service.ts';
import { findServedTrack, sidecarToWebVtt } from './subtitles.ts';

/** Seconds in Retry-After; advisory, hls.js ignores it (ADR 0003 D6). */
const SEGMENT_RETRY_S = 1;
const SUBTITLE_RETRY_S = 5;

const streamFailed = () => new ProblemError('STREAM_FAILED', 'The stream failed; report the playback failure to re-plan');

const notReady = (reply: FastifyReply, seconds: number, what: string): ProblemError => {
  void reply.header('Retry-After', String(seconds));
  return new ProblemError('STREAM_PREPARING', `${what} is not ready yet`);
};

type SendOutcome = 'sent' | 'missing';

/** Waits until a file stream has opened its file, so a vanished file is still a clean answer. */
function opened(stream: ReadStream): Promise<NodeJS.ErrnoException | null> {
  if (!stream.pending) return Promise.resolve(null);
  return new Promise((resolve) => {
    const onReady = () => {
      stream.off('error', onError);
      resolve(null);
    };
    const onError = (err: NodeJS.ErrnoException) => {
      stream.off('ready', onReady);
      resolve(err);
    };
    stream.once('ready', onReady);
    stream.once('error', onError);
  });
}

/**
 * Serves one file with Range, ETag and Last-Modified through @fastify/send. 'missing' when the file is
 * gone (between the readiness check and the open too): the caller produces it again or answers 503.
 */
async function sendFile(req: FastifyRequest, reply: FastifyReply, rec: StreamRecord, delivery: Delivery, absPath: string, contentType: string): Promise<SendOutcome> {
  const r = await send(req.raw, `/${encodeURIComponent(basename(absPath))}`, {
    root: dirname(absPath),
    dotfiles: 'allow',
    index: false,
    cacheControl: false,
    acceptRanges: true,
    etag: true,
    lastModified: true,
  });
  void reply.header('Cache-Control', 'no-store');
  if (r.type === 'error') {
    r.stream.destroy();
    if (r.statusCode === 404 || r.statusCode >= 500) return 'missing';
    if (r.statusCode === 403) throw new ProblemError('MEDIA_UNAVAILABLE', 'The file is not readable');
    if (r.statusCode === 412 || r.statusCode === 416) {
      // Conditional and range errors: the status and Content-Range tell it all, no HTML body.
      const range = r.headers['Content-Range'];
      if (typeof range === 'string') void reply.header('Content-Range', range);
      await reply.code(r.statusCode).send();
      return 'sent';
    }
    throw new ProblemError('VALIDATION_FAILED', `Bad request (${r.statusCode})`, {}, 400);
  }
  if (r.stream instanceof ReadStream) {
    const err = await opened(r.stream);
    if (err) {
      r.stream.destroy();
      if (err.code === 'ENOENT') return 'missing';
      throw new ProblemError('MEDIA_UNAVAILABLE', `The file is not readable (${err.code ?? 'error'})`);
    }
  }
  delivery.track(rec, reply.raw);
  void reply.code(r.statusCode);
  void reply.headers(r.headers);
  if (r.statusCode !== 304) void reply.header('Content-Type', contentType);
  void reply.header('Cache-Control', 'no-store');
  await reply.send(r.stream);
  return 'sent';
}

/** The sidecar as WebVTT: converted once per stream (one ffmpeg at a time), the failure cached too. */
function sidecarVtt(config: Config, rec: StreamRecord, track: ServedSubtitle, absPath: string, format: 'srt' | 'ass' | 'ssa'): Promise<Buffer> {
  const hit = rec.sidecars.get(track.trackId);
  if (hit) return hit.promise;
  const promise = rec.sidecarQueue.then(() => {
    if (rec.abort.signal.aborted) throw new Error('stream stopped');
    return sidecarToWebVtt(config.FFMPEG_PATH, absPath, format, rec.abort.signal);
  });
  // The queue continues after a failure; the cached promise is observed so it never rejects unhandled.
  rec.sidecarQueue = promise.catch(() => {});
  promise.catch(() => {});
  rec.sidecars.set(track.trackId, { promise });
  return promise;
}

export function deliveryHandlers(delivery: Delivery, config: Config, now: () => number): Handlers {
  const lookup = (reply: FastifyReply, token: string): StreamRecord => {
    void reply.header('Cache-Control', 'no-store');
    return delivery.resolveToken(token);
  };

  return {
    async getMediaFile(req, reply) {
      const { params } = typed<'getMediaFile'>(req);
      const rec = lookup(reply, params.sessionToken);
      if (rec.plan.protocol !== 'progressive') throw new ProblemError('NOT_FOUND', 'Not a progressive stream');
      rec.lastRequestAt = now();
      const type = rec.plan.file.container === 'matroska' ? 'video/x-matroska' : rec.plan.file.container === 'webm' ? 'video/webm' : 'video/mp4';
      if ((await sendFile(req, reply, rec, delivery, rec.absPath, type)) === 'missing') throw new ProblemError('MEDIA_UNAVAILABLE', 'The file is no longer reachable');
      return reply;
    },

    async getHlsResource(req, reply) {
      const { params } = typed<'getHlsResource'>(req);
      const rec = lookup(reply, params.sessionToken);
      const hls = rec.hls;
      if (!hls || !rec.playlists) throw new ProblemError('NOT_FOUND', 'Not an HLS stream');
      const res = parseHlsResource(params.resource, hls.segmentCount);
      if (!res) throw new ProblemError('NOT_FOUND', 'No such resource in the playlist');
      // STREAM_FAILED is terminal for the stream: answer at once, no new attempt (ADR 0003 D7).
      if (hls.terminal) throw streamFailed();
      switch (res.kind) {
        case 'main':
        case 'media':
          hls.touchOther();
          // Every body sent for the stream is registered, so stop and expiry cut it (m2).
          delivery.track(rec, reply.raw);
          return reply.code(200).type('application/vnd.apple.mpegurl').send(res.kind === 'main' ? rec.playlists.main : rec.playlists.media);
        case 'init':
          hls.touchOther();
          if ((await sendFile(req, reply, rec, delivery, hls.initPath(), 'video/mp4')) === 'missing') throw notReady(reply, SEGMENT_RETRY_S, INIT_SEGMENT);
          return reply;
        case 'segment': {
          for (let attempt = 0; attempt < 2; attempt++) {
            const o = await hls.request(res.index);
            if (o === 'failed') throw streamFailed();
            if (o === 'gone') throw new ProblemError('SESSION_EXPIRED', 'Playback session closed or re-planned');
            if (o === 'timeout') throw notReady(reply, SEGMENT_RETRY_S, 'The segment');
            const path = hls.segmentPath(res.index);
            if (path && (await sendFile(req, reply, rec, delivery, path, 'video/mp4')) === 'sent') return reply;
            // Evicted or replaced between the check and the read: produce it again, never 404 (ADR 0003 D2).
            hls.forget(res.index);
          }
          throw notReady(reply, SEGMENT_RETRY_S, 'The segment');
        }
      }
    },

    async getSubtitle(req, reply) {
      const { params } = typed<'getSubtitle'>(req);
      const rec = lookup(reply, params.sessionToken);
      if (rec.hls?.terminal) throw streamFailed();
      const track = findServedTrack(rec.served, params.track);
      if (!track) throw new ProblemError('NOT_FOUND', 'No such subtitle track in this session');
      rec.hls?.touchOther();
      if (track.source.kind === 'embedded') {
        // F1b.4 serves the extraction while it grows; until then the client retries.
        throw notReady(reply, SUBTITLE_RETRY_S, 'The subtitle track');
      }
      const file = await resolveMediaFile(config.LIBRARY_ROOTS, { rootName: rec.plan.file.location.rootName, relPath: track.source.relPath });
      if (!file.ok) throw new ProblemError('MEDIA_UNAVAILABLE', file.detail);
      if (track.format === 'sup' || track.source.format === 'vtt') {
        const type = track.format === 'sup' ? 'application/octet-stream' : 'text/vtt; charset=utf-8';
        if ((await sendFile(req, reply, rec, delivery, file.absPath, type)) === 'missing') throw new ProblemError('MEDIA_UNAVAILABLE', 'The subtitle file is no longer reachable');
        return reply;
      }
      if (track.source.format === 'sup') throw new ProblemError('NOT_FOUND', 'No such subtitle track in this session');
      let vtt: Buffer;
      try {
        vtt = await sidecarVtt(config, rec, track, file.absPath, track.source.format);
      } catch (err) {
        if (rec.abort.signal.aborted) throw new ProblemError('SESSION_EXPIRED', 'Playback session closed or re-planned');
        throw new ProblemError('MEDIA_UNAVAILABLE', `The subtitle could not be converted: ${err instanceof Error ? err.message : String(err)}`);
      }
      // The stream may have stopped during the conversion.
      if (rec.abort.signal.aborted) throw new ProblemError('SESSION_EXPIRED', 'Playback session closed or re-planned');
      delivery.track(rec, reply.raw);
      return reply.code(200).type('text/vtt; charset=utf-8').send(vtt);
    },
  };
}
