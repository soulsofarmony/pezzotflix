// What the scanner records (library standard §6, §7.3, §7.4). Names are compared case-insensitively
// after NFC normalisation; stored paths stay byte-exact as on disk.

export const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(['mkv', 'mp4', 'm4v', 'avi', 'webm', 'm2ts']);
export const SUBTITLE_EXTENSIONS: ReadonlySet<string> = new Set(['srt', 'ass', 'ssa', 'vtt', 'sup']);

/** Disc structures are recorded but never probed: they go to the queue as disc_structure (§7.1). */
export type DiscKind = 'bdmv' | 'video_ts' | 'iso';

export type FileClass = 'video' | 'subtitle' | 'iso';

// System folders of Windows, Linux and NAS systems (Synology: #recycle, #snapshot, @eaDir; QNAP:
// @Recycle, @Recently-Snapshot, .@__thumb), compared folded. Any other folder starting with a dot
// (".Trash-1000") is hidden and ignored too.
const IGNORED_DIRS: ReadonlySet<string> = new Set([
  '$recycle.bin', 'lost+found', 'system volume information',
  '#recycle', '#snapshot', '@eadir', '@recycle', '@recently-snapshot', '.@__thumb',
  'sample', 'samples',
]);

export const fold = (s: string): string => s.normalize('NFC').toLowerCase();

export const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? fold(name.slice(dot + 1)) : '';
};

export const stemOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
};

export function isIgnoredDir(name: string): boolean {
  return name.startsWith('.') || IGNORED_DIRS.has(fold(name));
}

export function discDirKind(name: string): DiscKind | null {
  const n = fold(name);
  return n === 'bdmv' ? 'bdmv' : n === 'video_ts' ? 'video_ts' : null;
}

/** "Sample" only as a "-sample" suffix, never as a word of the title (§7.3). */
export const isSampleName = (name: string): boolean => fold(stemOf(name)).endsWith('-sample');

export function classifyFile(name: string): FileClass | null {
  if (name.startsWith('.')) return null; // hidden, including macOS "._" companions
  const ext = extensionOf(name);
  if (VIDEO_EXTENSIONS.has(ext)) return isSampleName(name) ? null : 'video';
  if (ext === 'iso') return 'iso';
  if (SUBTITLE_EXTENSIONS.has(ext)) return 'subtitle';
  return null;
}

/**
 * Sidecars of the videos of one folder (§6): same folder, name = video stem + "." + tokens.
 * A subtitle goes to the video with the longest matching stem ("Film.extended.it.srt" belongs to
 * "Film.extended.mkv", not "Film.mkv"); unmatched subtitles are left out. Lists are sorted.
 */
export function associateSidecars(videos: readonly string[], subtitles: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>(videos.map((v) => [v, []]));
  const keys = videos
    .map((v) => ({ video: v, prefix: `${fold(stemOf(v))}.` }))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  for (const sub of subtitles) {
    const name = fold(sub);
    const hit = keys.find((k) => name.startsWith(k.prefix));
    if (hit) out.get(hit.video)?.push(sub);
  }
  for (const list of out.values()) list.sort();
  return out;
}

export const joinRel = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

/** Kind of disc structure a stored path points to, if any. */
export function discKindOfPath(relPath: string): DiscKind | null {
  const name = relPath.slice(relPath.lastIndexOf('/') + 1);
  return discDirKind(name) ?? (extensionOf(name) === 'iso' ? 'iso' : null);
}
