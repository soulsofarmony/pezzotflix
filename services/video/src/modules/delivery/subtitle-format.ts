// Files of the embedded subtitle extraction (ADR 0003 D12), pure: PGS .sup segments, WebVTT cues, and the
// merge of the two passes. Pass 2 covers [0, P₁) and goes in front of pass 1; anything of pass 2 at or after
// the first timestamp of pass 1 is a duplicate and is dropped (PTS dedupe). With -copyts both passes are on
// the same timeline, so the merge is byte-identical to a full extraction (spike t3).

/** Output formats: PGS copied as .sup (client_render), text as WebVTT (sidecar) or as ASS (burn-in only). */
export type SubtitleFormat = 'sup' | 'vtt' | 'ass';

/** Image codecs: copied as .sup when PGS, burned with overlay otherwise. */
export const BITMAP_SUBTITLE_CODECS: ReadonlySet<string> = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);

// ---------------------------------------------------------------- PGS (.sup)

/** "PG", PTS (u32, 90 kHz), DTS (u32), segment type (u8), payload size (u16). */
export const SUP_HEADER_BYTES = 13;
const SUP_MAGIC = 0x5047;

export class SupError extends Error {}

export interface SupSegment {
  /** 90 kHz ticks on the zero-based timeline (-copyts -start_at_zero). */
  pts: number;
  bytes: Buffer;
}

/** Splits a .sup byte stream into whole segments, across chunk boundaries. Memory: one segment (≤ 64 KiB + 13). */
export class SupSplitter {
  private carry: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): SupSegment[] {
    const buf = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const out: SupSegment[] = [];
    let at = 0;
    while (buf.length - at >= SUP_HEADER_BYTES) {
      if (buf.readUInt16BE(at) !== SUP_MAGIC) throw new SupError(`not a PGS segment at byte ${at}`);
      const end = at + SUP_HEADER_BYTES + buf.readUInt16BE(at + 11);
      if (end > buf.length) break;
      out.push({ pts: buf.readUInt32BE(at + 2), bytes: buf.subarray(at, end) });
      at = end;
    }
    this.carry = Buffer.from(buf.subarray(at));
    return out;
  }

  /** Bytes of an incomplete segment left at the end. */
  get pending(): number {
    return this.carry.length;
  }
}

/** PTS of the first segment, null for an empty file; throws on bytes that are not PGS. */
export function supFirstPts(head: Buffer): number | null {
  if (head.length < SUP_HEADER_BYTES) {
    if (head.length === 0) return null;
    throw new SupError('truncated PGS segment');
  }
  if (head.readUInt16BE(0) !== SUP_MAGIC) throw new SupError('not a PGS file');
  return head.readUInt32BE(2);
}

/** Pass 2 of a .sup, kept: the segments before the first PTS of pass 1 (null: pass 1 is empty, keep all). */
export function keepSupSegment(seg: SupSegment, pass1FirstPts: number | null): boolean {
  return pass1FirstPts === null || seg.pts < pass1FirstPts;
}

// ---------------------------------------------------------------- WebVTT

const CUE_TIME = /^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})\s+-->/;

/** Start of a cue block (an optional id line, then the timing line), ms; null when it has no timing line. */
export function vttCueStartMs(block: string): number | null {
  for (const line of block.split('\n')) {
    const m = CUE_TIME.exec(line.trim());
    if (m) return Number(m[1] ?? 0) * 3_600_000 + Number(m[2]) * 60_000 + Number(m[3]) * 1000 + Number(m[4]);
  }
  return null;
}

export interface VttDocument {
  /** "WEBVTT" and anything before the first blank line. */
  header: string;
  /** Cue blocks without their separating blank lines. */
  cues: string[];
}

/**
 * ffmpeg's webvtt muxer writes "WEBVTT\n", then "\n<cue>\n" per cue: the blocks are separated by one blank
 * line. Cue payloads never contain a blank line (WebVTT forbids it), so splitting on it is exact.
 */
export function parseVtt(text: string): VttDocument {
  const body = text.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const parts = body.split('\n\n');
  return { header: parts[0] ?? 'WEBVTT', cues: parts.slice(1).filter((c) => c.trim() !== '') };
}

/** The bytes ffmpeg writes for this document. */
export function formatVtt(doc: VttDocument): string {
  return doc.cues.length ? `${doc.header}\n\n${doc.cues.join('\n\n')}\n` : `${doc.header}\n`;
}

/** Start of the first cue, ms; null when there is none. */
export function vttFirstCueMs(text: string): number | null {
  for (const cue of parseVtt(text).cues) {
    const t = vttCueStartMs(cue);
    if (t !== null) return t;
  }
  return null;
}

/** Pass 2 in front of pass 1, without the cues of pass 2 that pass 1 already has. */
export function mergeVtt(pass2: string, pass1: string): string {
  const p1 = parseVtt(pass1);
  const p2 = parseVtt(pass2);
  const first = vttFirstCueMs(pass1);
  const kept = p2.cues.filter((c) => {
    const t = vttCueStartMs(c);
    return first === null || (t !== null && t < first);
  });
  return formatVtt({ header: p1.header || p2.header, cues: [...kept, ...p1.cues] });
}
