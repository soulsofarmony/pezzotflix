// Language codes for MediaFacts: everything is normalised to ISO 639-2/B, lower case
// (MediaFacts.language). Embedded tags are 639-2 (B in Matroska, often T in MP4); sidecar
// names use 639-1 or 639-2 (library standard §6). Shared so that profile preferences can be
// normalised the same way ('de' / 'deu' → 'ger').

/** ISO 639-1 → ISO 639-2/B. */
const ISO1_TO_B: Readonly<Record<string, string>> = {
  aa: 'aar', ab: 'abk', ae: 'ave', af: 'afr', ak: 'aka', am: 'amh', an: 'arg', ar: 'ara', as: 'asm', av: 'ava',
  ay: 'aym', az: 'aze', ba: 'bak', be: 'bel', bg: 'bul', bh: 'bih', bi: 'bis', bm: 'bam', bn: 'ben', bo: 'tib',
  br: 'bre', bs: 'bos', ca: 'cat', ce: 'che', ch: 'cha', co: 'cos', cr: 'cre', cs: 'cze', cu: 'chu', cv: 'chv',
  cy: 'wel', da: 'dan', de: 'ger', dv: 'div', dz: 'dzo', ee: 'ewe', el: 'gre', en: 'eng', eo: 'epo', es: 'spa',
  et: 'est', eu: 'baq', fa: 'per', ff: 'ful', fi: 'fin', fj: 'fij', fo: 'fao', fr: 'fre', fy: 'fry', ga: 'gle',
  gd: 'gla', gl: 'glg', gn: 'grn', gu: 'guj', gv: 'glv', ha: 'hau', he: 'heb', hi: 'hin', ho: 'hmo', hr: 'hrv',
  ht: 'hat', hu: 'hun', hy: 'arm', hz: 'her', ia: 'ina', id: 'ind', ie: 'ile', ig: 'ibo', ii: 'iii', ik: 'ipk',
  io: 'ido', is: 'ice', it: 'ita', iu: 'iku', ja: 'jpn', jv: 'jav', ka: 'geo', kg: 'kon', ki: 'kik', kj: 'kua',
  kk: 'kaz', kl: 'kal', km: 'khm', kn: 'kan', ko: 'kor', kr: 'kau', ks: 'kas', ku: 'kur', kv: 'kom', kw: 'cor',
  ky: 'kir', la: 'lat', lb: 'ltz', lg: 'lug', li: 'lim', ln: 'lin', lo: 'lao', lt: 'lit', lu: 'lub', lv: 'lav',
  mg: 'mlg', mh: 'mah', mi: 'mao', mk: 'mac', ml: 'mal', mn: 'mon', mr: 'mar', ms: 'may', mt: 'mlt', my: 'bur',
  na: 'nau', nb: 'nob', nd: 'nde', ne: 'nep', ng: 'ndo', nl: 'dut', nn: 'nno', no: 'nor', nr: 'nbl', nv: 'nav',
  ny: 'nya', oc: 'oci', oj: 'oji', om: 'orm', or: 'ori', os: 'oss', pa: 'pan', pi: 'pli', pl: 'pol', ps: 'pus',
  pt: 'por', qu: 'que', rm: 'roh', rn: 'run', ro: 'rum', ru: 'rus', rw: 'kin', sa: 'san', sc: 'srd', sd: 'snd',
  se: 'sme', sg: 'sag', si: 'sin', sk: 'slo', sl: 'slv', sm: 'smo', sn: 'sna', so: 'som', sq: 'alb', sr: 'srp',
  ss: 'ssw', st: 'sot', su: 'sun', sv: 'swe', sw: 'swa', ta: 'tam', te: 'tel', tg: 'tgk', th: 'tha', ti: 'tir',
  tk: 'tuk', tl: 'tgl', tn: 'tsn', to: 'ton', tr: 'tur', ts: 'tso', tt: 'tat', tw: 'twi', ty: 'tah', ug: 'uig',
  uk: 'ukr', ur: 'urd', uz: 'uzb', ve: 'ven', vi: 'vie', vo: 'vol', wa: 'wln', wo: 'wol', xh: 'xho', yi: 'yid',
  yo: 'yor', za: 'zha', zh: 'chi', zu: 'zul',
};

/** ISO 639-2/T codes that differ from their /B form. */
const T_TO_B: Readonly<Record<string, string>> = {
  bod: 'tib', ces: 'cze', cym: 'wel', deu: 'ger', ell: 'gre', eus: 'baq', fas: 'per', fra: 'fre', hye: 'arm',
  isl: 'ice', kat: 'geo', mkd: 'mac', mri: 'mao', msa: 'may', mya: 'bur', nld: 'dut', ron: 'rum', slk: 'slo',
  sqi: 'alb', zho: 'chi',
};

/** 639-2 codes without a 639-1 form that show up on discs. */
const EXTRA_B = ['fil', 'haw', 'nap', 'scn', 'yue', 'cmn', 'gsw'] as const;

const KNOWN_B: ReadonlySet<string> = new Set([...Object.values(ISO1_TO_B), ...EXTRA_B]);

/** Language names accepted in sidecar names (tolerant reading), English and Italian. */
const NAMES: Readonly<Record<string, string>> = {
  italian: 'ita', italiano: 'ita', english: 'eng', inglese: 'eng', german: 'ger', deutsch: 'ger', tedesco: 'ger',
  french: 'fre', francais: 'fre', 'français': 'fre', francese: 'fre', spanish: 'spa', espanol: 'spa',
  'español': 'spa', spagnolo: 'spa', japanese: 'jpn', giapponese: 'jpn', portuguese: 'por', portoghese: 'por',
  russian: 'rus', russo: 'rus', chinese: 'chi', cinese: 'chi', korean: 'kor', coreano: 'kor', dutch: 'dut',
  olandese: 'dut', swedish: 'swe', svedese: 'swe', danish: 'dan', danese: 'dan', norwegian: 'nor',
  norvegese: 'nor', finnish: 'fin', finlandese: 'fin', polish: 'pol', polacco: 'pol', czech: 'cze', ceco: 'cze',
  hungarian: 'hun', ungherese: 'hun', turkish: 'tur', turco: 'tur', greek: 'gre', greco: 'gre', hebrew: 'heb',
  ebraico: 'heb', arabic: 'ara', arabo: 'ara', hindi: 'hin',
};

/**
 * Normalises a language tag as found in a container (ffprobe `language` tag) to ISO 639-2/B.
 * Returns null for missing, empty or undetermined values. Unknown 3-letter codes are kept as tagged.
 */
export function normalizeLanguageTag(tag: string | null | undefined): string | null {
  if (!tag) return null;
  // BCP 47 tags (en-US, pt-BR) keep only the primary subtag.
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  if (primary === '' || primary === 'und' || primary === 'xx') return null;
  if (primary.length === 2) return ISO1_TO_B[primary] ?? null;
  if (primary.length === 3) return T_TO_B[primary] ?? primary;
  return null;
}

/**
 * Recognises a language token in a sidecar name ("it", "ita", "deu", "italian", "pt-br").
 * Stricter than normalizeLanguageTag: unknown tokens are not languages (they may be flags).
 */
export function languageFromToken(token: string): string | null {
  const t = token.toLowerCase();
  const named = NAMES[t];
  if (named) return named;
  const primary = t.split(/[-_]/)[0] ?? '';
  if (primary.length === 2) return ISO1_TO_B[primary] ?? null;
  if (primary.length === 3) {
    const b = T_TO_B[primary] ?? primary;
    return KNOWN_B.has(b) ? b : null;
  }
  return null;
}
