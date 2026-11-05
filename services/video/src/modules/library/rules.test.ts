import { describe, expect, it } from 'vitest';
import { associateSidecars, classifyFile, discDirKind, discKindOfPath, isIgnoredDir } from './rules.ts';
import { diffRoot, type KnownFile, SUSPECT_MIN_PRESENT, unmountedWarning } from './scan.ts';
import type { WalkEntry, WalkResult } from './walk.ts';

describe('library standard §7.3: what the scanner records', () => {
  it.each([
    ['Blade Runner 2049 (2017) - 2160p.mkv', 'video'],
    ['Film.MKV', 'video'], // case-insensitive extension (§7.4)
    ['clip.mp4', 'video'],
    ['clip.m4v', 'video'],
    ['clip.webm', 'video'],
    ['clip.avi', 'video'],
    ['00001.m2ts', 'video'],
    ['Film (2001)-sample.mkv', null], // "-sample" suffix
    ['Dark (2017) - S01E01 - Sample Rate.mkv', 'video'], // "sample" as a title word is kept
    ['Sample.mkv', 'video'],
    ['Film (2001).iso', 'iso'],
    ['Film (2001).it.forced.srt', 'subtitle'],
    ['Film.en.ass', 'subtitle'],
    ['Film.it.sup', 'subtitle'],
    ['._Film (2001).mkv', null], // macOS companion file
    ['.hidden.mkv', null],
    ['notes.txt', null],
    ['VTS_01_1.VOB', null],
    ['cover.jpg', null],
  ])('file %s → %s', (name, expected) => {
    expect(classifyFile(name)).toBe(expected);
  });

  it.each([
    ['$RECYCLE.BIN', true],
    ['@eaDir', true],
    ['#recycle', true],
    ['#snapshot', true], // Synology
    ['@Recycle', true], // QNAP
    ['@Recently-Snapshot', true],
    ['.@__thumb', true],
    ['.Trash-1000', true],
    ['.git', true],
    ['lost+found', true],
    ['System Volume Information', true],
    ['Sample', true],
    ['samples', true],
    ['Extras', false],
    ['Season 01', false],
    ['Sample Rate (2001)', false],
  ])('folder %s ignored=%s', (name, expected) => {
    expect(isIgnoredDir(name)).toBe(expected);
  });

  it('recognises disc structures', () => {
    expect(discDirKind('BDMV')).toBe('bdmv');
    expect(discDirKind('bdmv')).toBe('bdmv');
    expect(discDirKind('VIDEO_TS')).toBe('video_ts');
    expect(discDirKind('BDMV_DISC1')).toBeNull();
    expect(discKindOfPath('Film (2001)/BDMV')).toBe('bdmv');
    expect(discKindOfPath('Film (2001)/Film (2001).ISO')).toBe('iso');
    expect(discKindOfPath('misc/BDMV_DISC1_t00.mkv')).toBeNull();
  });
});

describe('sidecar association (§6)', () => {
  it('assigns each subtitle to the video with the longest matching stem', () => {
    const map = associateSidecars(
      ['Film (2001).mkv', 'Film (2001).extended.mkv', 'Other.mkv'],
      ['Film (2001).it.srt', 'Film (2001).extended.it.forced.srt', 'FILM (2001).EN.SRT', 'Orphan.it.srt', 'Film (2001)x.srt'],
    );
    expect(map.get('Film (2001).mkv')).toEqual(['FILM (2001).EN.SRT', 'Film (2001).it.srt']);
    expect(map.get('Film (2001).extended.mkv')).toEqual(['Film (2001).extended.it.forced.srt']);
    expect(map.get('Other.mkv')).toEqual([]);
  });

  it('compares names in NFC', () => {
    const map = associateSidecars(['Città (2001).mkv'], ['Città (2001).it.srt']);
    expect(map.get('Città (2001).mkv')).toEqual(['Città (2001).it.srt']);
  });
});

describe('diffRoot', () => {
  const known = (relPath: string, over: Partial<KnownFile> = {}): KnownFile => ({
    id: relPath,
    rootId: 'r',
    relPath,
    sizeBytes: 10,
    mtimeMs: 1,
    fingerprint: null,
    state: 'analyzed',
    hasFacts: true,
    createdAt: 0,
    ...over,
  });
  const entry = (relPath: string, over: Partial<WalkEntry> = {}): WalkEntry => ({
    relPath,
    disc: null,
    sizeBytes: 10,
    mtimeMs: 1,
    sidecars: [],
    ...over,
  });
  const walk = (entries: WalkEntry[], over: Partial<WalkResult> = {}): WalkResult => ({
    entries,
    unreadableDirs: [],
    skipped: [],
    unstable: 0,
    symlinks: [],
    unsafe: [],
    ...over,
  });

  it('classifies added, changed, unchanged and gone files', () => {
    const d = diffRoot(
      [known('a.mkv'), known('b.mkv'), known('c.mkv'), known('old.mkv', { state: 'missing' })],
      walk([entry('a.mkv'), entry('b.mkv', { mtimeMs: 2 }), entry('new.mkv')]),
    );
    expect(d.added.map((e) => e.relPath)).toEqual(['new.mkv']);
    expect(d.changed.map((c) => c.file.relPath)).toEqual(['b.mkv']);
    expect(d.unchanged.map((c) => c.file.relPath)).toEqual(['a.mkv']);
    expect(d.gone.map((f) => f.relPath)).toEqual(['c.mkv']); // already missing files are not gone again
  });

  it('never reports files below unreadable folders or skipped files as gone', () => {
    const d = diffRoot(
      [known('A/x.mkv'), known('B/y.mkv'), known('copying.mkv')],
      walk([], { unreadableDirs: ['A'], skipped: ['copying.mkv'] }),
    );
    expect(d.gone.map((f) => f.relPath)).toEqual(['B/y.mkv']);
  });

});

describe('unmounted-root guard', () => {
  const min = SUSPECT_MIN_PRESENT;
  it.each([
    ['nothing would go missing', 5, 0, true, null],
    ['empty mount point', 1, 1, true, 'empty_walk'],
    ['a few files deleted', 10, 9, false, null], // small roots: only the empty walk counts
    ['half of a large root', min * 2, min, false, null],
    ['most of a large root', min * 2, min + 1, false, 'mass_missing'],
    ['exactly the threshold', min, Math.floor(min / 2) + 1, false, 'mass_missing'],
    ['below the size threshold', min - 1, min - 1, false, null],
  ])('%s', (_label, present, wouldMiss, emptyWalk, expected) => {
    expect(unmountedWarning(present, wouldMiss, emptyWalk)).toBe(expected);
  });
});
