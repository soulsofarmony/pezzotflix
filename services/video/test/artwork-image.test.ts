// GetImage (contract media.yaml, ADR 0004 point 8, ADR 0007 point 6) through the HTTP server:
// TMDB sizes served as downloaded (nearest size, 30-day cache), other images as WebP variants
// made once (immutable), 404 for unknown keys or missing files.
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app/server.ts';
import { defaultVariant, pickSize } from '../src/modules/metadata/artwork.ts';
import { imageKeyOf } from '../src/shared/metadata.ts';
import type { ArtworkRecord } from '../src/shared/ports.ts';
import { type Setup, setup } from './helpers/enrich-setup.ts';
import { MOVIE } from './helpers/tmdb-synthetic.ts';

let s: Setup;
let app: FastifyInstance;
let poster: ArtworkRecord;
let backdropWd: ArtworkRecord;

beforeAll(async () => {
  s = await setup();
  const { itemId } = s.comp.ports.catalogWrite.upsertWork({
    kind: 'movie',
    editionLabel: null,
    externalIds: { wikidata: 'Q99000001', tmdb: String(MOVIE.id) },
    fields: [{ source: 'filename', fetchedAt: 0, values: { title: 'faro' } }],
  });
  await s.runner.drain();
  const arts = s.comp.ports.catalogWrite.listArtwork(itemId);
  const find = (type: string, source: string) => {
    const a = arts.find((x) => x.type === type && x.source === source);
    if (!a) throw new Error(`no ${source} ${type}`);
    return a;
  };
  poster = find('poster', 'tmdb');
  backdropWd = find('backdrop', 'wikidata');
  app = await buildServer({ handlers: s.comp.handlers, profileTokens: { verify: () => null }, logger: false });
});
afterAll(async () => {
  await app?.close();
  s?.close();
});

const url = (a: ArtworkRecord, w?: number) => `/video/media/images/${imageKeyOf(a.localPath) ?? 'x'}${w ? `?w=${w}` : ''}`;
const file = (a: ArtworkRecord, name: string) => readFileSync(join(s.config.artworkDir, a.localPath.replace(/[^/]+$/, name)));

describe('pure helpers', () => {
  const sizes = [
    { name: 'w342.jpg', width: 342 },
    { name: 'w780.jpg', width: 780 },
  ];
  it.each([
    [160, 'w342.jpg'],
    [320, 'w342.jpg'],
    [342, 'w342.jpg'],
    [640, 'w780.jpg'],
    [1920, 'w780.jpg'],
    [undefined, 'w780.jpg'],
  ])('TMDB w=%j → %s', (w, name) => {
    expect(pickSize(sizes, w)).toBe(name);
  });
  it.each([
    [null, 1280],
    [5000, 1280],
    [800, 640],
    [100, 160],
  ])('default variant for an original %j px wide: %i', (orig, w) => {
    expect(defaultVariant(orig)).toBe(w);
  });
});

describe('TMDB images', () => {
  it('serves the downloaded CDN size nearest to w, as it is, with the 30-day policy', async () => {
    const small = await app.inject({ method: 'GET', url: url(poster, 160) });
    expect(small.statusCode).toBe(200);
    expect(small.headers['content-type']).toBe('image/jpeg');
    expect(small.headers['cache-control']).toBe('public, max-age=2592000');
    expect(small.rawPayload.equals(file(poster, 'w342.jpg'))).toBe(true);
    const big = await app.inject({ method: 'GET', url: url(poster, 1280) });
    expect(big.rawPayload.equals(file(poster, 'w780.jpg'))).toBe(true);
    const none = await app.inject({ method: 'GET', url: url(poster) });
    expect(none.rawPayload.equals(file(poster, 'w780.jpg'))).toBe(true);
  });

  it('HEAD answers like GET without a body', async () => {
    const r = await app.inject({ method: 'HEAD', url: url(poster, 320) });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=2592000');
  });
});

describe('other images', () => {
  it('WebP variants of the asked width, immutable, made once into the cache volume', async () => {
    const r = await app.inject({ method: 'GET', url: url(backdropWd, 320) });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/webp');
    expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const meta = await sharp(r.rawPayload).metadata();
    expect([meta.format, meta.width]).toEqual(['webp', 320]);
    const key = imageKeyOf(backdropWd.localPath) ?? '';
    const variant = join(s.config.cacheDir, 'images', key.slice(0, 2), key, 'w320.webp');
    expect(readFileSync(variant).equals(r.rawPayload)).toBe(true);
    const again = await app.inject({ method: 'GET', url: url(backdropWd, 320) });
    expect(again.rawPayload.equals(r.rawPayload)).toBe(true);
  });

  it('no enlargement: w=1920 of an 800 px original stays 800 px; no w gives the default variant', async () => {
    const big = await app.inject({ method: 'GET', url: url(backdropWd, 1920) });
    expect((await sharp(big.rawPayload).metadata()).width).toBe(800);
    const none = await app.inject({ method: 'GET', url: url(backdropWd) });
    expect((await sharp(none.rawPayload).metadata()).width).toBe(640);
  });
});

describe('errors', () => {
  it('404 for an unknown key, 400 for a malformed key or a width outside the contract', async () => {
    const unknown = await app.inject({ method: 'GET', url: '/video/media/images/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: 'NOT_FOUND' });
    expect((await app.inject({ method: 'GET', url: '/video/media/images/short' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `${url(poster)}?w=500` })).statusCode).toBe(400);
  });

  it('404 when the row is there but the files are gone', async () => {
    rmSync(join(s.config.artworkDir, poster.localPath.replace(/\/[^/]+$/, '')), { recursive: true, force: true });
    expect((await app.inject({ method: 'GET', url: url(poster, 320) })).statusCode).toBe(404);
  });
});
