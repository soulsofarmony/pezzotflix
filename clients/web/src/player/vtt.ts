// Minimal incremental WebVTT parser for the fallback of a growing sidecar track (doc 05 §7.8.6): fetch in
// streaming plus VTTCue, used when <track> does not add cues while the response grows. Cue settings and
// styles are ignored; the text keeps its tags, which VTTCue renders.

export interface ParsedCue {
  startS: number;
  endS: number;
  text: string;
}

const TIMING = /^\s*((?:\d+:)?\d{1,2}:\d{2}\.\d{3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}\.\d{3})/;

export function parseTimestamp(s: string): number {
  const parts = s.split(':');
  let total = 0;
  for (const p of parts) total = total * 60 + Number(p);
  return total;
}

/** Feeds text chunks; returns the cues whose block is complete (a blank line after it, or end of stream). */
export class VttStreamParser {
  private buffer = '';
  /** A CR at the end of a chunk may be the first half of a CRLF split across chunks. */
  private pendingCr = false;

  push(chunk: string): ParsedCue[] {
    let raw = (this.pendingCr ? '\r' : '') + chunk;
    this.pendingCr = raw.endsWith('\r');
    if (this.pendingCr) raw = raw.slice(0, -1);
    this.buffer += raw.replace(/\r\n?/g, '\n');
    const blocks = this.buffer.split(/\n{2,}/);
    this.buffer = blocks.pop() ?? '';
    return blocks.flatMap((b) => parseBlock(b));
  }

  end(): ParsedCue[] {
    const rest = this.buffer + (this.pendingCr ? '\n' : '');
    this.buffer = '';
    this.pendingCr = false;
    return parseBlock(rest);
  }
}

function parseBlock(block: string): ParsedCue[] {
  const lines = block.split('\n').filter((l, i) => i > 0 || l.trim() !== '');
  const i = lines.findIndex((l) => TIMING.test(l));
  if (i < 0) return [];
  const m = TIMING.exec(lines[i] ?? '');
  if (!m?.[1] || !m[2]) return [];
  const text = lines.slice(i + 1).join('\n').trim();
  if (!text) return [];
  return [{ startS: parseTimestamp(m[1]), endS: parseTimestamp(m[2]), text }];
}
