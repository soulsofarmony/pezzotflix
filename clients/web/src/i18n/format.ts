// Dates, numbers, durations and languages with Intl in it-IT (ADR 0005 point 5).
const LOCALE = 'it-IT';

const num = new Intl.NumberFormat(LOCALE);
const dateFmt = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const relFmt = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });

export const formatNumber = (n: number) => num.format(n);
export const formatDate = (ms: number) => dateFmt.format(new Date(ms));
export const formatDateTime = (ms: number) => dateTimeFmt.format(new Date(ms));

/** "1 h 47 min", "47 min", "35 s". */
export function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 1) return `${Math.max(0, Math.round(ms / 1000))} s`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Player clock: "1:47:23" or "47:23". */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** "3 giorni fa", "ieri", "tra 2 ore". */
export function formatRelative(ms: number, now: number = Date.now()): string {
  const diffS = (ms - now) / 1000;
  const abs = Math.abs(diffS);
  if (abs < 60) return relFmt.format(Math.round(diffS), 'second');
  if (abs < 3600) return relFmt.format(Math.round(diffS / 60), 'minute');
  if (abs < 86_400) return relFmt.format(Math.round(diffS / 3600), 'hour');
  if (abs < 30 * 86_400) return relFmt.format(Math.round(diffS / 86_400), 'day');
  if (abs < 365 * 86_400) return relFmt.format(Math.round(diffS / (30 * 86_400)), 'month');
  return relFmt.format(Math.round(diffS / (365 * 86_400)), 'year');
}

const UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;

export function formatBytes(bytes: number): string {
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1000;
    i += 1;
  }
  return new Intl.NumberFormat(LOCALE, { style: 'unit', unit: UNITS[i], unitDisplay: 'short', maximumFractionDigits: i >= 3 ? 1 : 0 }).format(v);
}

/** ISO 639-2/B codes that differ from the /T codes Intl.DisplayNames knows. */
const B_TO_T: Record<string, string> = {
  alb: 'sqi', arm: 'hye', baq: 'eus', bur: 'mya', chi: 'zho', cze: 'ces', dut: 'nld', fre: 'fra', geo: 'kat', ger: 'deu',
  gre: 'ell', ice: 'isl', mac: 'mkd', mao: 'mri', may: 'msa', per: 'fas', rum: 'ron', slo: 'slk', tib: 'bod', wel: 'cym',
};

let languages: Intl.DisplayNames | null = null;

/** "ita" → "Italiano"; unknown codes come back as they are, "und"/null as null. */
export function languageName(code: string | null | undefined): string | null {
  if (!code || code === 'und' || code === 'zxx' || code === 'mis') return null;
  const c = code.toLowerCase();
  try {
    languages ??= new Intl.DisplayNames(LOCALE, { type: 'language' });
    const name = languages.of(B_TO_T[c] ?? c);
    if (!name || name.toLowerCase() === c) return code;
    return name.charAt(0).toLocaleUpperCase(LOCALE) + name.slice(1);
  } catch {
    return code;
  }
}

const CODEC_NAMES: Record<string, string> = {
  truehd: 'TrueHD', dts: 'DTS', dtshd: 'DTS-HD', 'dts-hd': 'DTS-HD', eac3: 'E-AC-3', ac3: 'AC-3', aac: 'AAC', flac: 'FLAC', opus: 'Opus',
  pcm: 'PCM', mp3: 'MP3', h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', hdmv_pgs_subtitle: 'PGS', pgs: 'PGS', subrip: 'SRT', srt: 'SRT',
  ass: 'ASS', ssa: 'SSA', webvtt: 'WebVTT', mov_text: 'Timed Text', dvd_subtitle: 'VobSub', dvb_subtitle: 'DVB',
};

export const codecName = (codec: string | null | undefined): string | null => (codec ? (CODEC_NAMES[codec.toLowerCase()] ?? codec.toUpperCase()) : null);

/** "5.1", "7.1", "2.0" from the channel count when the layout is not given. */
export function channelLabel(channels: number | null | undefined, layout: string | null | undefined): string | null {
  if (layout && /^\d\.\d/.test(layout)) return layout.replace(/\(.*\)$/, '');
  if (!channels) return null;
  if (channels === 1) return '1.0';
  if (channels === 2) return '2.0';
  if (channels === 6) return '5.1';
  if (channels === 8) return '7.1';
  return `${channels} ch`;
}
