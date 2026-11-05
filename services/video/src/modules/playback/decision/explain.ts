// PlaybackPlanExplanation.actions: one word per dimension in the contract vocabulary (none | remux |
// convert:<codec> | transcode | burn_in), derived from the plan only. The details (output size,
// tone-mapping, remove_dovi, how a subtitle is served) are in the plan reasons.
import type { PlaybackPlan } from '../../../shared/playback-plan.ts';

export function explainActions(plan: PlaybackPlan): Record<string, string> {
  const container = plan.mode === 'direct_play' ? 'none' : 'remux';
  const video = plan.video.kind === 'transcode' ? 'transcode' : 'none';
  const audio = !plan.audio || plan.audio.action.kind === 'copy' ? 'none' : `convert:${plan.audio.action.codec}`;
  const s = plan.subtitles.selected;
  let subtitles = 'none';
  if (s?.delivery === 'burned') subtitles = 'burn_in';
  else if (s && s.delivery !== 'embedded') {
    // Served separately: a sidecar already in the served format goes as is, an embedded track is
    // extracted unchanged (remux), anything else is converted to WebVTT.
    const asIs = s.source.kind === 'sidecar' && (s.source.format === 'vtt' || s.source.format === 'sup');
    const unchanged = s.codec === 'hdmv_pgs_subtitle' || s.codec === 'webvtt';
    subtitles = asIs ? 'none' : unchanged ? 'remux' : 'convert:webvtt';
  }
  return { container, video, audio, subtitles };
}
