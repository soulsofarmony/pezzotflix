// File fingerprint for move/rename detection (doc 01 §4.2): size + SHA-256 of the first and last MiB.
// Reads at most 2 MiB per file, so it stays cheap on a slow bind mount or a NAS.
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

export const FINGERPRINT_CHUNK = 1024 * 1024;

export async function fingerprintFile(absPath: string, sizeBytes: number): Promise<string> {
  const hash = createHash('sha256');
  const fh = await open(absPath, 'r');
  try {
    const readRange = async (position: number, length: number) => {
      const buf = Buffer.alloc(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await fh.read(buf, filled, length - filled, position + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      hash.update(buf.subarray(0, filled));
    };
    if (sizeBytes <= 2 * FINGERPRINT_CHUNK) {
      await readRange(0, sizeBytes);
    } else {
      await readRange(0, FINGERPRINT_CHUNK);
      await readRange(sizeBytes - FINGERPRINT_CHUNK, FINGERPRINT_CHUNK);
    }
  } finally {
    await fh.close();
  }
  return `v1:${sizeBytes}:${hash.digest('hex')}`;
}
