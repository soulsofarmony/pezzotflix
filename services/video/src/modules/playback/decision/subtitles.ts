// Subtitles: track choice from the profile prefs (doc 04 §3.1 step 4) and the treatment ladder of
// doc 04 §4.4: rendered from the stream (Direct Play, native player) → served separately (WebVTT
// sidecar or .sup for a client renderer, P3) → burned in (Transcode, never above 1080p, P2) → dropped.
import { normalizeLanguageTag } from '../../../shared/languages.ts';
import { type MediaFacts, type SubtitleStreamFacts, streamTrackId } from '../../../shared/media-facts.ts';
import type { PlanExclusion, PlanReason, ServedSubtitle, SubtitleDelivery, SubtitleSource } from '../../../shared/playback-plan.ts';
import type { ClientCapabilities, ProfilePlaybackPrefs } from '../../../shared/ports.ts';
import { clientRendersEmbedded, clientRendersPgs, clientRendersWebVtt, TEXT_TO_WEBVTT } from './caps.ts';
import { exclusionMessage, reason, subtitleName } from './reasons.ts';

/** One subtitle track of the file, embedded or sidecar, as the engine sees it. */
export interface SubtitleTrack {
  trackId: string;
  source: SubtitleSource;
  codec: string;
  language: string | null;
  forced: boolean;
  sdh: boolean;
  /** Commentary track: ranked last. Sidecars and older facts: false. */
  commentary: boolean;
  default: boolean;
  /** null for a sidecar file. */
  embedded: SubtitleStreamFacts | null;
}

const SIDECAR_CODEC = { srt: 'subrip', ass: 'ass', ssa: 'ssa', vtt: 'webvtt', sup: 'hdmv_pgs_subtitle' } as const;

/** Embedded tracks in stream order, then sidecars in their facts order (the catalog's order too). */
export function subtitleTracks(facts: MediaFacts): SubtitleTrack[] {
  const embedded = facts.streams
    .filter((s): s is SubtitleStreamFacts => s.type === 'subtitle')
    .map<SubtitleTrack>((s) => ({
      trackId: streamTrackId(s.index),
      source: { kind: 'embedded', streamIndex: s.index },
      codec: s.codec,
      language: s.language,
      forced: s.forced,
      sdh: s.sdh,
      commentary: s.commentary === true,
      default: s.default,
      embedded: s,
    }));
  const sidecars = facts.sidecars.map<SubtitleTrack>((x) => ({
    trackId: x.id,
    source: { kind: 'sidecar', relPath: x.relPath, format: x.format },
    codec: SIDECAR_CODEC[x.format],
    language: x.language,
    forced: x.forced,
    sdh: x.sdh,
    commentary: false,
    default: false,
    embedded: null,
  }));
  return [...embedded, ...sidecars];
}

/** Track ids are per file: a subtitle exclusion pinned to another file does not apply (null fileId = any file). */
export const exclusionsForFile = (ex: readonly PlanExclusion[], fileId: string): PlanExclusion[] =>
  ex.filter((e) => e.dimension !== 'subtitle' || e.fileId === null || e.fileId === fileId);

const findExclusion = (ex: readonly PlanExclusion[], trackId: string, delivery: SubtitleDelivery): PlanExclusion | undefined =>
  ex.find((e) => e.dimension === 'subtitle' && e.trackId === trackId && e.delivery === delivery);

/**
 * How the track is served separately, or null: PGS (embedded or .sup sidecar) as .sup for a client
 * renderer, text as WebVTT. VobSub and DVB have no separate form: only burn-in shows them.
 */
export function servedFor(t: SubtitleTrack, caps: ClientCapabilities, ex: readonly PlanExclusion[], skipped: PlanReason[]): ServedSubtitle | null {
  let delivery: 'client_render' | 'sidecar' | null = null;
  if (t.codec === 'hdmv_pgs_subtitle' && clientRendersPgs(caps)) delivery = 'client_render';
  else if (TEXT_TO_WEBVTT.has(t.codec) && clientRendersWebVtt(caps)) delivery = 'sidecar';
  if (!delivery) return null;
  const excluded = findExclusion(ex, t.trackId, delivery);
  if (excluded) {
    skipped.push(reason('format_excluded', 'subtitle', exclusionMessage(excluded)));
    return null;
  }
  return {
    trackId: t.trackId,
    source: t.source,
    codec: t.codec,
    language: t.language,
    forced: t.forced,
    delivery,
    format: delivery === 'client_render' ? 'sup' : 'webvtt',
  };
}

/** A native player renders this embedded track from the file in Direct Play. */
export function rendersFromStream(t: SubtitleTrack, caps: ClientCapabilities, ex: readonly PlanExclusion[], skipped: PlanReason[]): boolean {
  if (!t.embedded || !clientRendersEmbedded(caps, t.embedded)) return false;
  const excluded = findExclusion(ex, t.trackId, 'embedded');
  if (excluded) {
    skipped.push(reason('format_excluded', 'subtitle', exclusionMessage(excluded)));
    return false;
  }
  return true;
}

export const burnExcluded = (t: SubtitleTrack, ex: readonly PlanExclusion[]): PlanExclusion | undefined => findExclusion(ex, t.trackId, 'burned');

/** The subtitle a selection asks for on a file (resolve.ts); track null: off. */
export interface SubtitleIntent {
  track: SubtitleTrack | null;
  hard: boolean;
}

export interface SubtitleChoice {
  track: SubtitleTrack;
  /** A hard (explicit) choice: a plan that cannot show it reports the track as dropped. */
  explicit: boolean;
}

/**
 * The selected track, or null when none is shown.
 * - hard choice: always honoured;
 * - remembered choice: kept unless it is a commentary or the client cannot show it without a
 *   burn-in, then the prefs decide;
 * - a selection of off (explicit or remembered): no full subtitles, but the forced track in the
 *   language of the selected audio is still shown, as in the prefs mode forced (doc 04 §3.1);
 * - prefs off: none;
 * - prefs forced: the forced track in the language of the selected audio, if any;
 * - prefs always: the first preferred language with a track; commentary last, a full (not forced)
 *   track first, one the client can show without a burn-in first, then not SDH; with no preferred
 *   language set, the track flagged default.
 */
export function chooseSubtitle(
  tracks: readonly SubtitleTrack[],
  caps: ClientCapabilities,
  prefs: ProfilePlaybackPrefs,
  intent: SubtitleIntent | null,
  audioLanguage: string | null,
): SubtitleChoice | null {
  const showable = (t: SubtitleTrack): boolean => servedFor(t, caps, [], []) !== null || rendersFromStream(t, caps, [], []);
  const order = (a: SubtitleTrack, b: SubtitleTrack): number =>
    Number(a.commentary) - Number(b.commentary) ||
    Number(a.forced) - Number(b.forced) ||
    Number(showable(b)) - Number(showable(a)) ||
    Number(a.sdh) - Number(b.sdh) ||
    Number(b.default) - Number(a.default) ||
    tracks.indexOf(a) - tracks.indexOf(b);
  const forcedOnly = (): SubtitleChoice | null => {
    if (audioLanguage === null) return null;
    const forced = tracks.filter((t) => t.forced && !t.commentary && t.language === audioLanguage);
    const pick = [...forced].sort((a, b) => Number(showable(b)) - Number(showable(a)) || order(a, b))[0];
    return pick ? { track: pick, explicit: false } : null;
  };

  if (intent) {
    if (intent.track === null) return forcedOnly();
    if (intent.hard) return { track: intent.track, explicit: true };
    if (!intent.track.commentary && showable(intent.track)) return { track: intent.track, explicit: false };
  }
  if (prefs.subtitleMode === 'off') return null;
  if (prefs.subtitleMode === 'forced') return forcedOnly();
  const langs = [...new Set(prefs.subtitleLanguages.map((l) => normalizeLanguageTag(l)).filter((l): l is string => l !== null))];
  for (const lang of langs) {
    const pick = tracks.filter((t) => t.language === lang).sort(order)[0];
    if (pick) return { track: pick, explicit: false };
  }
  if (langs.length === 0) {
    const pick = tracks.filter((t) => t.default && !t.forced && !t.commentary).sort(order)[0];
    if (pick) return { track: pick, explicit: false };
  }
  return null;
}

/** What a selection of off shows on a file: the forced track in the audio language, or nothing. */
export const subtitleWhenOff = (tracks: readonly SubtitleTrack[], caps: ClientCapabilities, audioLanguage: string | null): SubtitleTrack | null =>
  chooseSubtitle(tracks, caps, { audioLanguages: [], subtitleLanguages: [], subtitleMode: 'off' }, { track: null, hard: false }, audioLanguage)?.track ?? null;

export function servedReason(s: ServedSubtitle): PlanReason {
  const name = subtitleName(s.codec, s.language);
  if (s.delivery === 'client_render') return reason('subtitle_client_render', 'subtitle', `Subtitles ${name} rendered by the client`);
  const styleLost = s.codec === 'ass' || s.codec === 'ssa' ? ' (style lost)' : '';
  return reason('subtitle_sidecar', 'subtitle', `Subtitles ${name} served as WebVTT${styleLost}`);
}
