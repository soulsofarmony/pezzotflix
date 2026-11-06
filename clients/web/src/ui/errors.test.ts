import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/problem.ts';
import { errorMessage, problemDetails } from './errors.ts';

const err = (status: number, code: string, extra: { detail?: string; problem?: object } = {}) => new ApiError({ status, code, ...extra });

describe('errorMessage (catalog, profile and admin pages)', () => {
  it.each([
    // The gateway's answer while the Video Service is down (deploy/Caddyfile): the service, not a disk.
    ['503 MEDIA_UNAVAILABLE', err(503, 'MEDIA_UNAVAILABLE'), 'Il servizio non risponde in questo momento.'],
    ['502 without a problem', err(502, 'UNEXPECTED'), 'Il servizio non risponde in questo momento.'],
    ['504 without a problem', err(504, 'UNEXPECTED'), 'Il servizio non risponde in questo momento.'],
    ['503 with an unknown code and a detail', err(503, 'SOMETHING_NEW', { detail: 'English text' }), 'Il servizio non risponde in questo momento.'],
    // A 503 that says what is down keeps its own message.
    ['503 PROVIDER_UNAVAILABLE', err(503, 'PROVIDER_UNAVAILABLE'), 'Il servizio dei metadati non è raggiungibile ora.'],
    ['no answer', err(0, 'NETWORK'), 'Il server non risponde. Controlla la connessione.'],
    ['404', err(404, 'NOT_FOUND'), 'Non trovato.'],
    ['409', err(409, 'CONFLICT'), 'Il dato è cambiato nel frattempo: ricarica e riprova.'],
    ['400', err(400, 'VALIDATION_FAILED'), 'Alcuni dati non sono validi.'],
    ['500', err(500, 'INTERNAL'), 'Qualcosa è andato storto.'],
    ['not an ApiError', new Error('boom'), 'Qualcosa è andato storto.'],
  ])('%s', (_name, e, message) => {
    expect(errorMessage(e)).toBe(message);
  });
});

describe('problemDetails', () => {
  it('lists the errors[] of a problem as "path: message"', () => {
    const e = err(400, 'VALIDATION_FAILED', { problem: { errors: [{ path: 'body/manual/title', message: 'must NOT have more than 200 characters' }, { path: '', message: 'bad' }] } });
    expect(problemDetails(e)).toEqual(['body/manual/title: must NOT have more than 200 characters', 'bad']);
  });

  it('is empty without errors[]', () => {
    expect(problemDetails(err(400, 'VALIDATION_FAILED'))).toEqual([]);
    expect(problemDetails(new Error('x'))).toEqual([]);
  });
});
