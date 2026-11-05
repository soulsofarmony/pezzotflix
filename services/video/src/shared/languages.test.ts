import { describe, expect, it } from 'vitest';
import { languageFromToken, normalizeLanguageTag } from './languages.ts';

describe('normalizeLanguageTag (container tags → ISO 639-2/B)', () => {
  it.each([
    ['ita', 'ita'],
    ['ENG', 'eng'],
    ['deu', 'ger'], // 639-2/T → /B
    ['fra', 'fre'],
    ['zho', 'chi'],
    ['ger', 'ger'],
    ['en', 'eng'], // 639-1
    ['pt-BR', 'por'], // BCP 47
    ['und', null],
    ['', null],
    [undefined, null],
    ['xx', null],
    ['tlh', 'tlh'], // unknown 3-letter codes are kept as tagged
  ])('%s → %s', (tag, expected) => {
    expect(normalizeLanguageTag(tag)).toBe(expected);
  });
});

describe('languageFromToken (sidecar name tokens)', () => {
  it.each([
    ['it', 'ita'],
    ['ita', 'ita'],
    ['IT', 'ita'],
    ['en', 'eng'],
    ['deu', 'ger'],
    ['no', 'nor'],
    ['italiano', 'ita'],
    ['English', 'eng'],
    ['pt-br', 'por'],
    ['forced', null],
    ['sdh', null],
    ['cc', null],
    ['default', null],
    ['non', null],
    ['abc', null], // not a language code
  ])('%s → %s', (token, expected) => {
    expect(languageFromToken(token)).toBe(expected);
  });
});
