// Timeline of the original media (doc 04 §6.1, doc 05 §7.8.7, ADR 0003).
// hls.js maps fMP4 fragments onto the playlist timeline: currentTime = PTS − initPTS/timescale. The server shifts
// media PTS by a constant mediaTimestampOffsetMs (10000 for hls-fmp4), so at every INIT_PTS_FOUND (main):
//   timelineOffsetMs = initPTS · 1000 / timescale − mediaTimestampOffsetMs
// and original time = currentTime + timelineOffsetMs. Direct Play: the offset is 0.

export function timelineOffsetFromInitPts(initPts: number, timescale: number, mediaTimestampOffsetMs: number): number {
  if (!(timescale > 0)) return 0;
  return (initPts * 1000) / timescale - mediaTimestampOffsetMs;
}

/** Position on the original timeline, for progress, resume, chapters and subtitles. */
export function toOriginalMs(currentTimeS: number, timelineOffsetMs: number): number {
  return Math.max(0, Math.round(currentTimeS * 1000 + timelineOffsetMs));
}

/** Player time (seconds) of an original time X: currentTime = (X − timelineOffsetMs) / 1000. */
export function toPlayerTimeS(originalMs: number, timelineOffsetMs: number): number {
  return Math.max(0, (originalMs - timelineOffsetMs) / 1000);
}
