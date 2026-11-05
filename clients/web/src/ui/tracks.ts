// Track labels: language, codec and channels, plus forced/SDH/commentary (doc 03 §3.4, requirements §6).
import { channelLabel, codecName, languageName } from '../i18n/format.ts';
import { t } from '../i18n/t.ts';

export interface TrackLike {
  type: string;
  codec?: string | null;
  language?: string | null;
  title?: string | null;
  channels?: number | null;
  channelLayout?: string | null;
  objectAudio?: string | null;
  forced?: boolean;
  sdh?: boolean;
  commentary?: boolean;
  subtitleKind?: string | null;
}

const OBJECT_AUDIO: Record<string, string> = { atmos: 'Atmos', dtsx: 'DTS:X' };

/** "Italiano · TrueHD 7.1 Atmos" / "Inglese · PGS · forzati". */
export function trackLabel(track: TrackLike): string {
  const parts: string[] = [languageName(track.language) ?? t('track.unknownLanguage')];
  const codec = codecName(track.codec);
  if (track.type === 'audio') {
    const ch = channelLabel(track.channels, track.channelLayout);
    const obj = track.objectAudio ? (OBJECT_AUDIO[track.objectAudio.toLowerCase()] ?? track.objectAudio) : null;
    const tech = [codec, ch, obj].filter(Boolean).join(' ');
    if (tech) parts.push(tech);
  } else if (codec) parts.push(codec);
  const flags: string[] = [];
  if (track.forced) flags.push(t('track.forced'));
  if (track.sdh) flags.push(t('track.sdh'));
  if (track.commentary) flags.push(t('track.commentary'));
  if (flags.length) parts.push(flags.join(', '));
  if (track.title && !parts.some((p) => p.toLowerCase() === track.title?.toLowerCase())) parts.push(`«${track.title}»`);
  return parts.join(' · ');
}
