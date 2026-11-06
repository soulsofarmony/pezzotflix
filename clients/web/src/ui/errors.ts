// Generic error messages by problem code and status (ADR 0004: errors are handled by code, never by text).
// For the catalog, profile and admin pages. The player picks its own messages by code (StatusOverlay).
import { ApiError } from '../api/problem.ts';
import { t } from '../i18n/t.ts';

export function errorMessage(e: unknown): string {
  if (!(e instanceof ApiError)) return t('error.generic');
  switch (e.code) {
    case 'NETWORK':
      return t('error.network');
    case 'NOT_FOUND':
      return t('error.notFound');
    case 'UNAUTHORIZED':
      return t('error.unauthorized');
    case 'CONFLICT':
      return t('error.conflict');
    case 'VALIDATION_FAILED':
      return t('error.validation');
    case 'PROVIDER_UNAVAILABLE':
      return t('error.providerUnavailable');
    case 'MEDIA_UNAVAILABLE':
      // No catalog, profile or admin operation the UI calls answers MEDIA_UNAVAILABLE itself: here it is the
      // gateway's answer while the Video Service is down (deploy/Caddyfile), not a disconnected disk.
      return t('error.serviceUnavailable');
    default:
      if (e.transient) return t('error.serviceUnavailable');
      if (e.status === 404) return t('error.notFound');
      if (e.status === 409) return t('error.conflict');
      if (e.status >= 500) return t('error.generic');
      return e.detail ?? t('error.generic');
  }
}

/** The `errors[]` of a Problem (validation details), as "path: message" lines; empty without them. */
export function problemDetails(e: unknown): string[] {
  if (!(e instanceof ApiError) || !Array.isArray(e.problem?.errors)) return [];
  return e.problem.errors.flatMap((x) => (x && typeof x.message === 'string' ? [x.path ? `${x.path}: ${x.message}` : x.message] : []));
}
