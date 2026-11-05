// Sidecar subtitle names (library standard §6): `<video stem>.<lang>[.forced][.sdh].<ext>`.
// The library owns sidecars: it associates them to their video during the walk, parses them here and
// stores them (external_subtitle and MediaFacts.sidecars) in the same write as the file row.
import { languageFromToken } from '../../shared/languages.ts';
import { type SidecarSubtitleFacts, sidecarTrackId } from '../../shared/media-facts.ts';

export const SIDECAR_FORMATS = ['srt', 'ass', 'ssa', 'vtt', 'sup'] as const;
type SidecarFormat = (typeof SIDECAR_FORMATS)[number];

const FORCED = new Set(['forced', 'forzati', 'forzato']);
// Not 'no': in a sidecar name it is Norwegian ("Film.no.forced.srt").
const NEGATION = new Set(['non', 'not', 'senza']);
// 'hi' is SDH only after a language code: alone it is Hindi (standard §6).
const SDH = new Set(['sdh', 'cc', 'hoh']);

const baseName = (relPath: string): string => relPath.slice(relPath.lastIndexOf('/') + 1);

const isFormat = (ext: string): ext is SidecarFormat => (SIDECAR_FORMATS as readonly string[]).includes(ext);

/**
 * Parses one sidecar of a video. Returns null if the extension is not a supported subtitle format.
 * Tokens are compared case-insensitively after NFC normalisation (standard §7.4).
 */
export function parseSidecar(videoRelPath: string, sidecarRelPath: string): SidecarSubtitleFacts | null {
  const name = baseName(sidecarRelPath).normalize('NFC');
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const format = name.slice(dot + 1).toLowerCase();
  if (!isFormat(format)) return null;

  const video = baseName(videoRelPath).normalize('NFC');
  const videoDot = video.lastIndexOf('.');
  const stem = (videoDot > 0 ? video.slice(0, videoDot) : video).toLowerCase();
  const body = name.slice(0, dot).toLowerCase();
  const middle = body.startsWith(`${stem}.`) ? body.slice(stem.length + 1) : '';
  const tokens = middle.split('.').map((t) => t.trim()).filter(Boolean);

  let language: string | null = null;
  let forced = false;
  let sdh = false;
  tokens.forEach((t, i) => {
    if (FORCED.has(t)) forced ||= !NEGATION.has(tokens[i - 1] ?? ''); // "Film.it.non.forced.srt" is a full track
    else if (NEGATION.has(t) && FORCED.has(tokens[i + 1] ?? '')) return;
    else if (SDH.has(t)) sdh = true;
    else if (t === 'hi') {
      if (language) sdh = true;
      else language = 'hin';
    } else if (!language) language = languageFromToken(t);
  });
  return { id: sidecarTrackId(sidecarRelPath), relPath: sidecarRelPath, format, language, forced, sdh };
}
