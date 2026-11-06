// Entry point the web app spawns for an uploaded invoice (keeps NEAR AI / PDF rendering / signing out of the
// Next.js bundle). Prints NDJSON events on stdout and writes agent/data/files/<id>.json.
//
//   tsx src/web-run.ts <stored-file> --id <record id> [--name <original name>] [--execute | --analyze-only]
//
//   {"type":"step","step":"read","state":"start"}           progress (read, check, quote, propose, result)
//   {"type":"log","line":"..."}                             the same lines `npm run pay` prints
//   {"type":"result","record":{...}}                        last line on success
//   {"type":"error","message":"..."}                        last line on failure
//
// --execute signs treasury.propose_payment with the agent's FUNCTION-CALL key (same as `npm run pay -- --execute`).
// --analyze-only reads + checks only (no quote, no ledger write, nothing sent). Default: dry run.
// Mainnet --execute is refused unless ORVANTRA_ALLOW_MAINNET=1.
import './env.ts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { analyzeInvoice, type Analysis } from './analyze.ts';
import type { PageImage } from './extract.ts';
import * as near from './near.ts';
import { payInvoice, type PayResult } from './payflow.ts';
import { defaultFilesDir, imageSize, RECORD_ID, writeRecord, type InvoiceRecord, type RecordMode } from './records.ts';

const emit = (o: unknown) => process.stdout.write(`${JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}\n`);

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const file = argv[0];
const id = flag('--id') ?? '';
const originalName = flag('--name') ?? (file ? basename(file) : '');
const mode: RecordMode = argv.includes('--execute') ? 'execute' : argv.includes('--analyze-only') ? 'analyze' : 'dry-run';

if (!file || !RECORD_ID.test(id)) {
  emit({ type: 'error', message: 'usage: web-run.ts <file> --id <record id> [--name <name>] [--execute | --analyze-only]' });
  process.exit(2);
}

const cfg = near.nearConfig();
const dir = defaultFilesDir();
mkdirSync(dir, { recursive: true });
const receivedAt = new Date().toISOString();
let pageImage: string | null = null;
let pageSize: InvoiceRecord['page_size'] = null;
let pageCount = 0;

function onPages(pages: PageImage[]) {
  pageCount = pages.length;
  const first = pages[0];
  if (!first) return;
  pageImage = `${id}.page1.${first.mime === 'image/png' ? 'png' : 'jpg'}`;
  writeFileSync(join(dir, pageImage), first.data);
  pageSize = imageSize(first.data);
}

function buildRecord(a: Analysis | null, pay: PayResult | null, outcome: string, message: string): InvoiceRecord {
  const inv = a?.comparison.agreed ?? null;
  const readerA = a?.reading.readers.find((r) => r.reader === 'A');
  return {
    version: 1,
    id,
    received_at: receivedAt,
    original_name: originalName,
    file: basename(file),
    page_image: pageImage,
    page_size: pageSize,
    pages: pageCount,
    network: cfg.network,
    treasury: cfg.treasuryId,
    registry: cfg.registryId,
    mode,
    outcome,
    message,
    invoice_hash: a?.decision.invoice_hash ?? null,
    decision: a?.decision ?? null,
    invoice: inv
      ? {
        ...inv,
        amount_base_units: inv.amount_base_units?.toString() ?? null,
        line_items: inv.line_items.map((li) => ({ description: li.description, amount_base_units: li.amount_base_units?.toString() ?? null })),
      }
      : null,
    boxes: readerA?.extraction?.boxes ?? null,
    readers: (a?.reading.readers ?? []).map((r) => ({
      reader: r.reader, model: r.model, ok: !!r.extraction, verified: r.receipt.verified,
      signature_kind: r.receipt.signature_kind, e2ee: r.receipt.e2ee, error: r.error ?? r.receipt.error,
    })),
    agree: a ? a.comparison.agree : null,
    disagreements: a?.comparison.reasons ?? [],
    chain_error: a?.chain.error ?? null,
    registry_entry: a?.chain.registry ?? null,
    vendor_policy: a?.chain.vendor_policy ?? null,
    config: a?.chain.config ?? null,
    vendor_paid_count: a?.chain.vendor_paid_amounts.length ?? 0,
    path: pay?.path ?? null,
    quote: pay?.quote ?? null,
    deposit_address: pay?.deposit_address ?? null,
    agent_flags: pay?.agent_flags ?? [],
    tx_hash: pay?.tx_hash ?? null,
    explorer_url: pay?.explorer_url ?? null,
    payment_id: pay?.payment_id ?? null,
    payment: pay?.payment ?? null,
  };
}

let analysis: Analysis | null = null;
try {
  if (mode === 'execute' && cfg.network === 'mainnet' && process.env.ORVANTRA_ALLOW_MAINNET !== '1') {
    throw new Error('refusing to sign on mainnet from the web app (set ORVANTRA_ALLOW_MAINNET=1 to allow)');
  }
  readFileSync(file); // fail early if the stored file is missing
  let record: InvoiceRecord;
  if (mode === 'analyze') {
    emit({ type: 'step', step: 'read', state: 'start' });
    analysis = await analyzeInvoice(file, {
      onPages,
      onRead: () => {
        emit({ type: 'step', step: 'read', state: 'done' });
        emit({ type: 'step', step: 'check', state: 'start' });
      },
    });
    emit({ type: 'step', step: 'check', state: 'done', detail: analysis.decision.action });
    record = buildRecord(analysis, null, 'analyzed', `analyzed: ${analysis.decision.action} (nothing sent)`);
  } else {
    const pay = await payInvoice(
      file,
      { execute: mode === 'execute', fileName: originalName, ledgerExtra: { upload_id: id } },
      {
        log: (line) => emit({ type: 'log', line }),
        step: (step, state, detail) => emit({ type: 'step', step, state, ...(detail ? { detail } : {}) }),
        onPages,
      },
    );
    analysis = pay.analysis;
    record = buildRecord(pay.analysis, pay, pay.outcome, pay.message.trim());
  }
  writeRecord(dir, record);
  emit({ type: 'step', step: 'result', state: 'done', detail: record.outcome });
  emit({ type: 'result', record });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  try {
    writeRecord(dir, buildRecord(analysis, null, 'error', message));
  } catch {
    /* nothing else to do */
  }
  emit({ type: 'error', message });
  process.exitCode = 1;
}
