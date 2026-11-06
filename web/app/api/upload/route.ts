// POST multipart `file` -> store under agent/data/files/<id>.<ext> -> run analyze + pay in the agent process,
// streaming NDJSON progress. The browser never sees secrets; the agent signs only propose_payment (function-call key).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newRecordId } from 'orvantra-agent/records';
import { serverConfig } from '@/lib/server/config';
import { runAgent, uploadMode } from '@/lib/server/run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 15 * 1024 * 1024;

function sniff(buf: Buffer): 'png' | 'jpg' | 'pdf' | null {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  return null;
}

const bad = (message: string, status = 400) => Response.json({ type: 'error', message }, { status });

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad('Send the invoice as a multipart form field named "file".');
  }
  const file = form.get('file');
  if (!(file instanceof File)) return bad('Choose a PNG, JPEG or PDF invoice to upload.');
  if (file.size === 0) return bad('That file is empty.');
  if (file.size > MAX_BYTES) return bad('That file is larger than 15 MB.');
  const buf = Buffer.from(await file.arrayBuffer());
  const ext = sniff(buf);
  if (!ext) return bad('Orvantra reads PNG, JPEG and PDF invoices. This file is none of those.');

  const cfg = serverConfig();
  mkdirSync(cfg.filesDir, { recursive: true });
  const id = newRecordId();
  const stored = join(cfg.filesDir, `${id}.${ext}`);
  writeFileSync(stored, buf);
  const name = (file.name || `invoice.${ext}`).replace(/[^\w.\- ]+/g, '_').slice(0, 120);

  const mode = uploadMode();
  const stream = runAgent(stored, id, name, mode);
  return new Response(stream, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-orvantra-record': id, 'x-orvantra-mode': mode },
  });
}
