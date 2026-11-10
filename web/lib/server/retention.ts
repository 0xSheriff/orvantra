// Uploaded invoices are kept for a limited time: the newest 300 and nothing older than 21 days.
// Files per upload: <id>.<ext> (original), <id>.json (record), <id>.page1.png|jpg. The agent ledger is not touched.
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expiredUploadIds } from '../uploadLimits';

const FILE = /^([0-9]{13}-[0-9a-f]{8})\.[\w.]+$/;

/** Deletes every file of the expired uploads in `dir`; returns how many uploads were removed. Never throws. */
export function pruneUploads(dir: string, now = Date.now()): number {
  try {
    const files = readdirSync(dir);
    const ids = [...new Set(files.map((f) => FILE.exec(f)?.[1]).filter((x): x is string => !!x))];
    const doomed = new Set(expiredUploadIds(ids, now));
    for (const f of files) {
      const id = FILE.exec(f)?.[1];
      if (id && doomed.has(id)) rmSync(join(dir, f), { force: true });
    }
    return doomed.size;
  } catch {
    return 0;
  }
}
