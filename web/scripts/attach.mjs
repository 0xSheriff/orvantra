// npm run attach -- <invoice.png|jpg|pdf> [...more]
//
// Reads an invoice the agent already handled from the command line (e.g. a payment proposed with `npm run pay`) and
// stores it the way the web app stores uploads: original file, page image, readings, findings and region boxes.
// READ-ONLY: runs `web-run.ts --analyze-only` (two NEAR AI readers + NEAR views). Nothing is proposed or signed and
// the ledger is not touched. The review screen then shows the real image with overlays for that payment.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import dotenv from 'dotenv';

const root = resolve(import.meta.dirname, '../..');
const agentDir = join(root, 'agent');
if (existsSync(join(root, '.env'))) dotenv.config({ path: join(root, '.env'), quiet: true });

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: npm run attach -- <invoice.png|jpg|pdf> [...]');
  process.exit(2);
}

const env = {
  ...process.env,
  NEAR_NETWORK: process.env.NEAR_NETWORK ?? 'testnet',
  TREASURY_ID: process.env.TREASURY_ID ?? 'orvantra-treasury-v4.testnet',
  REGISTRY_ID: process.env.REGISTRY_ID ?? 'orvantra-registry.testnet',
};
const filesDir = process.env.ORVANTRA_FILES_DIR ?? join(agentDir, 'data/files');
mkdirSync(filesDir, { recursive: true });

let failed = 0;
for (const f of files) {
  const src = resolve(process.cwd(), f);
  const head = readFileSync(src).subarray(0, 5);
  const ext = head[0] === 0x89 ? 'png' : head[0] === 0xff ? 'jpg' : head.toString('latin1') === '%PDF-' ? 'pdf' : null;
  if (!ext) {
    console.error(`${f}: not a PNG, JPEG or PDF`);
    failed++;
    continue;
  }
  const id = `${String(Date.now()).padStart(13, '0')}-${Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0')}`;
  const stored = join(filesDir, `${id}.${ext}`);
  copyFileSync(src, stored);
  console.log(`${basename(f)} -> ${id} (read-only analysis, ${env.TREASURY_ID})`);
  const r = spawnSync(join(agentDir, 'node_modules/.bin/tsx'), [join(agentDir, 'src/web-run.ts'), stored, '--id', id, '--name', basename(f, extname(f)) + extname(f), '--analyze-only'], {
    cwd: agentDir, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const last = (r.stdout ?? '').trim().split('\n').filter(Boolean).at(-1) ?? '';
  try {
    const ev = JSON.parse(last);
    if (ev.type === 'result') {
      const rec = ev.record;
      const boxes = rec.boxes ? Object.keys(rec.boxes).join(', ') : 'none';
      console.log(`  ${rec.decision?.action ?? '?'} · hash ${rec.invoice_hash?.slice(0, 12) ?? '-'}… · boxes: ${boxes}`);
    } else {
      console.log(`  error: ${ev.message}`);
      failed++;
    }
  } catch {
    console.log(`  error: ${(r.stderr ?? '').trim().split('\n').at(-1) || `exit ${r.status}`}`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
