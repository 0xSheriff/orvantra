// POST multipart `file` -> store under agent/data/files/<id>.<ext> -> run analyze + pay in the agent process,
// streaming NDJSON progress. The browser never sees secrets; the agent signs only propose_payment (function-call key).
// Public demo, so every upload is limited (lib/uploadLimits.ts): 10 MB, 5 per IP per hour, 40 per day, one running and
// one waiting job, a daily cap on on-chain proposals. The body is size-checked before it is parsed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLedger } from 'orvantra-agent/ledger';
import { newRecordId } from 'orvantra-agent/records';
import { clientIp } from '@/lib/limiter';
import { serverConfig } from '@/lib/server/config';
import { pruneUploads } from '@/lib/server/retention';
import { reserveSlot, runAgent, uploadMode } from '@/lib/server/run';
import { MAX_BODY_BYTES, MAX_UPLOAD_BYTES, MESSAGES, TooLargeError, UploadLimits, declaredTooLarge, maxProposalsPerDay, proposalsToday, readCapped } from '@/lib/uploadLimits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const limits = new UploadLimits();

function sniff(buf: Buffer): 'png' | 'jpg' | 'pdf' | null {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  return null;
}

const bad = (message: string, status = 400) => Response.json({ type: 'error', message }, { status, headers: { 'cache-control': 'no-store' } });

export async function POST(req: Request) {
  // 1. Size first: refuse by content-length before anything is read; the byte cap below covers a missing or lying header.
  if (declaredTooLarge(req.headers.get('content-length'))) return bad(MESSAGES.tooLarge, 413);

  // 2. Limits per visitor and per day.
  const refused = limits.take(clientIp(req.headers), Date.now());
  if (refused) return bad(refused, 429);

  const cfg = serverConfig();
  const mode = uploadMode();
  if (mode === 'execute') {
    const max = maxProposalsPerDay();
    let sent = 0;
    try {
      sent = proposalsToday(readLedger(cfg.ledgerPath), cfg.network, cfg.treasuryId, Date.now());
    } catch (e) {
      console.error(`[upload] could not read the ledger: ${e instanceof Error ? e.message : String(e)}`);
      return bad('Uploads are unavailable right now. Try again later.', 503);
    }
    if (sent >= max) return bad(MESSAGES.proposals(max), 429);
  }

  // 3. Read the body with a byte cap, then parse it.
  let form: FormData;
  try {
    const body = await readCapped(req.body, MAX_BODY_BYTES);
    form = await new Response(new Uint8Array(body), { headers: { 'content-type': req.headers.get('content-type') ?? '' } }).formData();
  } catch (e) {
    if (e instanceof TooLargeError) return bad(MESSAGES.tooLarge, 413);
    return bad('Send the invoice as a multipart form field named "file".');
  }
  const file = form.get('file');
  if (!(file instanceof File)) return bad('Choose a PNG, JPEG or PDF invoice to upload.');
  if (file.size === 0) return bad('That file is empty.');
  if (file.size > MAX_UPLOAD_BYTES) return bad(MESSAGES.tooLarge, 413);
  const buf = Buffer.from(await file.arrayBuffer());
  const ext = sniff(buf);
  if (!ext) return bad('Orvantra reads PNG, JPEG and PDF invoices. This file is none of those.');

  // 4. One running and one waiting job at most.
  const release = reserveSlot();
  if (!release) return bad(MESSAGES.busy, 429);

  let stream: ReadableStream<Uint8Array>;
  try {
    mkdirSync(cfg.filesDir, { recursive: true });
    const id = newRecordId();
    const stored = join(cfg.filesDir, `${id}.${ext}`);
    writeFileSync(stored, buf);
    pruneUploads(cfg.filesDir);
    const name = (file.name || `invoice.${ext}`).replace(/[^\w.\- ]+/g, '_').slice(0, 120);
    stream = runAgent(stored, id, name, mode, release);
    return new Response(stream, {
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-orvantra-record': id, 'x-orvantra-mode': mode },
    });
  } catch (e) {
    release();
    console.error(`[upload] ${e instanceof Error ? e.message : String(e)}`);
    return bad('The invoice could not be stored. Try again later.', 500);
  }
}
