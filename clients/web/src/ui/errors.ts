// Generic error messages by problem code and status (ADR 0004: errors are handled by code, never by text).
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
      return t('error.mediaUnavailable');
    default:
      if (e.status === 404) return t('error.notFound');
      if (e.status === 409) return t('error.conflict');
      if (e.status >= 500 && e.status !== 503) return t('error.generic');
      return e.detail ?? t('error.generic');
  }
}
