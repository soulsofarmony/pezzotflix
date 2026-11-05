// ffmpeg stderr: a bounded ring buffer for diagnostics, and a coarse classification for the failure
// record (doc 04 §8). Playback never parses stderr; it reads StreamFailure.stderrClass.
import type { StderrClass } from '../../shared/ports.ts';

export class StderrRing {
  private chunks: Buffer[] = [];
  private len = 0;
  private readonly max: number;

  constructor(maxBytes = 64 * 1024) {
    this.max = maxBytes;
  }

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.len += chunk.length;
    while (this.len > this.max && this.chunks.length > 1) this.len -= this.chunks.shift()!.length;
    if (this.len > this.max) {
      const only = this.chunks[0]!;
      this.chunks = [only.subarray(only.length - this.max)];
      this.len = this.max;
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }

  /** Last whole lines within maxBytes (StreamFailure.stderrTail: at most 4 KiB). */
  tail(maxBytes = 4096): string {
    const lines = this.text().split(/\r?\n/).filter(Boolean);
    const out: string[] = [];
    let size = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]!;
      if (size + l.length + 1 > maxBytes) {
        if (out.length === 0) out.push(l.slice(l.length - maxBytes));
        break;
      }
      out.unshift(l);
      size += l.length + 1;
    }
    return out.join('\n');
  }
}

// The fatal error is usually the last line: lines are read from the end, and on one line the classes
// are checked in this order.
const CLASSES: [StderrClass, RegExp][] = [
  ['io', /No such file or directory|Permission denied|Input\/output error|I\/O error|No space left|Broken pipe|Connection reset|Error writing (?!trailer)|could not open|Operation not permitted/i],
  ['mux', /Could not write header|Error writing trailer|muxer|Cannot write moov|incompatible with output codec|Tag \S+ incompatible|Error initializing output stream|Invalid argument.*output/i],
  ['encode', /Error while opening encoder|encoder|Error submitting .* to an encoder|Error encoding|Unsupported channel layout/i],
  ['filter', /Error (?:re)?initializing filter|Failed to configure|filtergraph|aformat|Error while filtering|Filter .* not found|No such filter/i],
  ['decode', /Error while decoding|decoder|Invalid NAL|non-existing PPS|corrupt decoded frame|Error submitting packet to decoder/i],
  ['demux', /Invalid data found when processing input|EBML|matroska|moov atom not found|Error during demuxing|Truncating packet|demux|Invalid stream specifier|Stream map .* matches no streams/i],
];

export function classifyStderr(text: string): StderrClass {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    for (const [cls, re] of CLASSES) if (re.test(lines[i]!)) return cls;
  }
  return 'unknown';
}
