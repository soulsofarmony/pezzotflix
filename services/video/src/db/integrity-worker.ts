// Worker thread of checkBackup (backup.ts): integrity_check reads the whole copy, so it runs off the
// main event loop (ADR 0001 rule 5). The copy leaves WAL mode first, so it is one self-contained file.
import Database from 'better-sqlite3';
import { parentPort, workerData } from 'node:worker_threads';

const { path } = workerData as { path: string };
let problems: string[];
try {
  const copy = new Database(path, { fileMustExist: true });
  try {
    copy.pragma('journal_mode = DELETE');
    const rows = copy.pragma('integrity_check') as { integrity_check: string }[];
    problems = rows.map((r) => r.integrity_check).filter((m) => m !== 'ok');
  } finally {
    copy.close();
  }
} catch (err) {
  problems = [err instanceof Error ? err.message : String(err)];
}
parentPort?.postMessage(problems);
