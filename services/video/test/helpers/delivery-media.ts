// Helpers for the delivery integration tests: tool and sample discovery (skip with a message when
// missing), generated fixtures in a temp dir, plans built from real ffprobe facts, segment inspection.
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { createFfprobeRunner } from '../../src/modules/analyzer/ffprobe.ts';
import { mapFacts } from '../../src/modules/analyzer/facts.ts';
import { boxes, type InitInfo, isSyncSample, parseInit, parseMoof } from '../../src/modules/delivery/bmff.ts';
import type { AudioStreamFacts, MediaFacts, VideoStreamFacts } from '../../src/shared/media-facts.ts';
import type { AudioAction, DirectPlayPlan, DirectStreamPlan } from '../../src/shared/playback-plan.ts';

export const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';
export const SAMPLES =
  process.env.PZF_MEDIA_SAMPLES ?? resolve(fileURLToPath(new URL('../../../..', import.meta.url)), 'media-samples', 'library');

const runs = async (bin: string) => (await execa(bin, ['-version'], { reject: false })).exitCode === 0;
export const HAVE_FFMPEG = (await runs(FFMPEG)) && (await runs(FFPROBE));
export const HAVE_SAMPLES = existsSync(join(SAMPLES, 'movies'));
export const HAVE_X265 =
  HAVE_FFMPEG && (await execa(FFMPEG, ['-hide_banner', '-h', 'encoder=libx265'], { reject: false })).stdout.includes('libx265');

export function skipNotice(tag: string, needSamples: boolean): string | null {
  const why = !HAVE_FFMPEG
    ? `ffmpeg/ffprobe not runnable as "${FFMPEG}"/"${FFPROBE}" (set FFMPEG_PATH and FFPROBE_PATH)`
    : needSamples && !HAVE_SAMPLES
      ? `sample library not found at ${SAMPLES} (set PZF_MEDIA_SAMPLES)`
      : null;
  // Straight to stderr: the default reporter drops console output of skipped files.
  if (why) process.stderr.write(`[${tag}] skipped: ${why}\n`);
  return why;
}

export const MOVIES = () => join(SAMPLES, 'movies');
export const SAMPLE = {
  longTest: 'Long Test (2024)/Long Test (2024) - 2160p.mkv',
  br2049: 'Blade Runner 2049 (2017)/Blade Runner 2049 (2017) - 2160p Remux.mkv',
  oppenheimer: 'Oppenheimer (2023)/Oppenheimer (2023).mkv',
  buono: 'Il Buono, il Brutto, il Cattivo (1966)/Il.Buono.il.Brutto.il.Cattivo.1966.1080p.BluRay.REMUX.mkv',
  dune: 'Dune (2021)/Dune.2021.2160p.UHD.BluRay.REMUX.DV.HDR.mkv',
  trailer: 'Blade Runner 2049 (2017)/extras/Trailer.mkv',
} as const;

export const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

export async function ffmpeg(args: string[]): Promise<void> {
  await execa(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { timeout: 300_000 });
}

/** The reviewer's t4/t8 recipe: 23.976 fps HEVC, open GOPs (CRA), keyint 29, B-pyramid, AC-3 5.1. */
export async function makeOpenGopFixture(path: string, seconds = 30): Promise<void> {
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24000/1001',
    '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000',
    '-t', String(seconds),
    '-c:v', 'libx265', '-preset', 'ultrafast',
    '-x265-params', 'open-gop=1:keyint=29:min-keyint=29:scenecut=0:bframes=4:b-pyramid=1:log-level=error',
    '-c:a', 'ac3', '-b:a', '384k', '-ac', '6',
    path,
  ]);
}

/** H.264 with B-frames and keyframes off the grid (every 2.52 s), starting at 3.5 s, AAC stereo. */
export async function makeStartTimeFixture(path: string): Promise<void> {
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25',
    '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000',
    '-t', '20',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '63', '-keyint_min', '63', '-sc_threshold', '0', '-bf', '2',
    '-c:a', 'aac', '-b:a', '128k',
    '-output_ts_offset', '3.5',
    path,
  ]);
}

/** AAC 5.1(side) encoded without aformat: the encoder writes a PCE (channelConfiguration 0, E3b). */
export async function makePceFixture(path: string): Promise<void> {
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25',
    '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000',
    '-t', '6',
    '-filter_complex', '[1:a]pan=5.1(side)|FL=c0|FR=c0|FC=c0|LFE=c0|SL=c0|SR=c0[a]',
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25',
    '-c:a', 'aac', '-b:a', '384k',
    path,
  ]);
}

/** H.264 10 s at 25 fps with 2 s GOPs, AAC stereo: the base of the hostile-header fixtures. */
export async function makeShortFixture(path: string, extra: string[] = []): Promise<void> {
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25',
    '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000',
    '-t', '10',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '128k',
    ...extra,
    path,
  ]);
}

/** MPEG-TS in BD mode (192-byte packets) whose timestamps start at ~600 s, as a Blu-ray .m2ts does. */
export const makeTsStartFixture = (path: string): Promise<void> => makeShortFixture(path, ['-output_ts_offset', '600', '-f', 'mpegts', '-mpegts_m2ts_mode', '1']);

/** Rewrites the Info Duration (8-byte float, as ffmpeg writes it) of an MKV: hostile headers without a hex editor. */
export function patchMkvDuration(mkv: Buffer, ticks: number): Buffer {
  const out = Buffer.from(mkv);
  const at = out.subarray(0, 64 * 1024).indexOf(Buffer.from([0x44, 0x89, 0x88]));
  if (at < 0) throw new Error('no 8-byte Duration in the first 64 KiB');
  out.writeDoubleBE(ticks, at + 3);
  return out;
}

/** Renames the Cues element to an unknown id: neither delivery nor ffmpeg finds the index any more. */
export function hideMkvCues(mkv: Buffer): Buffer {
  const out = Buffer.from(mkv);
  const id = Buffer.from([0x1c, 0x53, 0xbb, 0x6b]);
  // The element, not the SeekHead's SeekID (preceded by its size byte 0x84).
  let at = out.lastIndexOf(id);
  while (at > 0 && out[at - 1] === 0x84) at = out.lastIndexOf(id, at - 1);
  if (at <= 0) throw new Error('no Cues element');
  out[at + 3] = 0x6c;
  return out;
}

export async function factsOf(absPath: string, location: { rootName: string; relPath: string }): Promise<MediaFacts> {
  const st = statSync(absPath);
  const probe = await createFfprobeRunner(FFPROBE).probe(absPath, new AbortController().signal);
  return mapFacts({ probe, location, sizeBytes: st.size, mtimeMs: Math.floor(st.mtimeMs) }).facts;
}

const videoOf = (f: MediaFacts) => f.streams.find((s): s is VideoStreamFacts => s.type === 'video' && !s.attachedPic)!;

function videoSource(v: VideoStreamFacts) {
  return {
    streamIndex: v.index,
    codec: v.codec,
    profile: v.profile,
    width: v.width,
    height: v.height,
    frameRate: v.frameRate,
    bitDepth: v.bitDepth,
    hdr: v.hdr,
    hdrFallback: [...v.hdrFallback],
    dolbyVisionProfile: v.dolbyVision?.profile ?? null,
    bitRate: v.bitRate,
    level: v.level ?? null,
  };
}

function audioSource(a: AudioStreamFacts) {
  return {
    streamIndex: a.index,
    trackId: `s${a.index}`,
    codec: a.codec,
    profile: a.profile,
    language: a.language,
    channels: a.channels,
    channelLayout: a.channelLayout,
    sampleRate: a.sampleRate,
    bitRate: a.bitRate,
  };
}

const fileOf = (fileId: string, f: MediaFacts) => ({
  fileId,
  location: f.location,
  sizeBytes: f.sizeBytes,
  mtimeMs: f.mtimeMs,
  container: f.container,
  durationMs: f.durationMs,
});

export function directStreamPlan(
  fileId: string,
  facts: MediaFacts,
  opts: { audioIndex?: number | null; action?: AudioAction; startPositionMs?: number } = {},
): DirectStreamPlan {
  const v = videoOf(facts);
  const audios = facts.streams.filter((s): s is AudioStreamFacts => s.type === 'audio');
  const a = opts.audioIndex === null ? undefined : opts.audioIndex === undefined ? audios[0] : audios.find((s) => s.index === opts.audioIndex);
  return {
    planVersion: 1,
    mode: 'direct_stream',
    protocol: 'hls-fmp4',
    file: fileOf(fileId, facts),
    video: { kind: 'copy', source: videoSource(v), tag: v.codec === 'hevc' ? 'hvc1' : null, dolbyVision: 'none' },
    audio: a ? { source: audioSource(a), action: opts.action ?? { kind: 'copy' } } : null,
    subtitles: { selected: null, served: [] },
    startPositionMs: opts.startPositionMs ?? 0,
    reasons: [],
    exclusions: [],
  };
}

export function directPlayPlan(fileId: string, facts: MediaFacts): DirectPlayPlan {
  const v = videoOf(facts);
  const a = facts.streams.find((s): s is AudioStreamFacts => s.type === 'audio');
  return {
    planVersion: 1,
    mode: 'direct_play',
    protocol: 'progressive',
    file: fileOf(fileId, facts),
    video: { kind: 'original', source: videoSource(v) },
    audio: a ? { source: audioSource(a), action: { kind: 'copy' } } : null,
    subtitles: { selected: null, served: [] },
    startPositionMs: 0,
    reasons: [],
    exclusions: [],
  };
}

// ---------------------------------------------------------------- segment inspection

export interface Sample {
  track: number;
  dts: number;
  pts: number;
  duration: number;
  size: number;
  sync: boolean;
}

/** Every sample of a segment, times in ms on the original timeline (minus the 10 s offset). */
export function samplesOf(segment: Buffer, init: InitInfo): Sample[] {
  const out: Sample[] = [];
  for (const top of boxes(segment)) {
    if (top.type !== 'moof') continue;
    for (const traf of parseMoof(segment.subarray(top.start, top.end), init)) {
      const ts = init.tracks.find((t) => t.id === traf.trackId)!.timescale;
      let dts = traf.baseDecodeTime;
      for (const s of traf.samples) {
        out.push({
          track: traf.trackId,
          dts: (dts * 1000) / ts - 10_000,
          pts: ((dts + s.cts) * 1000) / ts - 10_000,
          duration: (s.duration * 1000) / ts,
          size: s.size,
          sync: isSyncSample(s.flags),
        });
        dts += s.duration;
      }
    }
  }
  return out;
}

/** Concatenated sample data of one track in a segment (moof data offsets, default-base-is-moof). */
export function trackBytes(segment: Buffer, init: InitInfo, trackId: number): Buffer {
  const parts: Buffer[] = [];
  for (const top of boxes(segment)) {
    if (top.type !== 'moof') continue;
    for (const traf of parseMoof(segment.subarray(top.start, top.end), init)) {
      if (traf.trackId !== trackId || traf.dataOffset === null) continue;
      let size = 0;
      for (const s of traf.samples) size += s.size;
      parts.push(segment.subarray(top.start + traf.dataOffset, top.start + traf.dataOffset + size));
    }
  }
  return Buffer.concat(parts);
}

/**
 * The restart rule (ADR 0003 D4): a segment produced by a restart against the same segment of the run from
 * 0. Video: sample bytes identical, timestamps equal. Audio: sample bytes identical and every PTS within
 * 1 ms: ffmpeg re-times copied audio from the first packet after the seek, so a Matroska ms rounding can
 * move it by a fraction of a ms. Returns what differs, empty if nothing.
 */
export function restartDiff(restart: Buffer, ref: Buffer, init: InitInfo): string[] {
  const problems: string[] = [];
  for (const t of init.tracks) {
    const a = samplesOf(restart, init).filter((s) => s.track === t.id);
    const b = samplesOf(ref, init).filter((s) => s.track === t.id);
    const tolerance = t.handler === 'vide' ? 0.001 : 1;
    if (a.length !== b.length) {
      problems.push(`${t.handler}: ${a.length} samples, reference ${b.length}`);
      continue;
    }
    let worst = 0;
    for (const [i, s] of a.entries()) worst = Math.max(worst, Math.abs(s.pts - b[i]!.pts), Math.abs(s.duration - b[i]!.duration));
    if (worst > tolerance) problems.push(`${t.handler}: timestamps off by ${worst.toFixed(3)} ms`);
    if (!trackBytes(restart, init, t.id).equals(trackBytes(ref, init, t.id))) problems.push(`${t.handler}: sample bytes differ`);
  }
  return problems;
}

export { parseInit };
