// npm run eval — every fixture through the REAL readers (NEAR AI Cloud) + live testnet views + checks.
// Files run in order and share a seen-hash set, so 05 (same invoice as 01) is caught as a batch duplicate.
import './env.ts';
import { readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeInvoice, toJson, type Analysis } from './analyze.ts';
import type { Action } from './checks.ts';
import { formatAmount } from './normalize.ts';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');

interface Expectation {
  action: Action;
  /** A reason that must appear (substring), so PASS means "right decision for the right reason". */
  reason?: string;
  /** This file must produce the same invoice_hash as that file. */
  sameHashAs?: string;
}

// Keep in sync with fixtures/EXPECTED.md.
export const EXPECTED: Record<string, Expectation> = {
  '01-acme-normal.png': { action: 'propose' },
  '02-bob-normal.pdf': { action: 'hold', reason: "more than 3x this vendor's median" },
  '03-bob-small.png': { action: 'propose' },
  '04-acme-changed-bank.png': { action: 'hold', reason: 'invoice asks to pay a different address' },
  '05-acme-duplicate.png': { action: 'reject', reason: 'duplicate of 01-acme-normal.png', sameHashAs: '01-acme-normal.png' },
  '06-acme-inflated.png': { action: 'hold', reason: 'line items sum to 30.00 USDC but the total is 300.00 USDC' },
  '07-unknown-vendor.png': { action: 'reject', reason: 'not in the vendor registry' },
  '08-acme-credit-note.png': { action: 'reject', reason: 'a credit note' },
  '09-acme-over-max.png': { action: 'reject', reason: 'max_per_invoice' },
  '10-unapproved-vendor.png': { action: 'reject', reason: 'not approved in the treasury policy' },
  '11-acme-name-mismatch.png': { action: 'hold', reason: 'registered as' },
  '12-bob-possible-duplicate.png': { action: 'hold', reason: 'possible duplicate of B-0008' },
  '13-acme-bank-details.png': { action: 'hold', reason: 'bank/payment details' },
  '14-acme-implicit-redirect.png': { action: 'hold', reason: 'invoice asks to pay a different address' },
  '15-near-less-invoice.png': { action: 'reject', reason: 'no vendor NEAR account' },
};
// Once a fixture has been proposed on the target treasury (the demo runs do that), its hash is burnt there and the
// duplicate guard rejects it whatever the table says: that is then the expected outcome (see fixtures/EXPECTED.md).
const USED: Expectation = { action: 'reject', reason: 'invoice_hash already used in the treasury' };

const files = (await readdir(FIXTURES)).filter((f) => /^\d\d-.*\.(png|jpe?g|pdf)$/i.test(f)).sort();
const seen = new Map<string, string>();
const results: { file: string; a: Analysis }[] = [];
const t0 = performance.now();
for (const file of files) {
  process.stderr.write(`reading ${file} ...\n`);
  results.push({ file, a: await analyzeInvoice(resolve(FIXTURES, file), { seenHashes: seen }) });
}
const wall = Math.round(performance.now() - t0);

const hashOf = (f: string) => results.find((r) => r.file === f)?.a.decision.invoice_hash ?? null;
const rows: string[][] = [['file', 'A total', 'B total', 'agree', 'verified', 'decision', 'expected', 'result']];
let pass = 0;
for (const { file, a } of results) {
  const table = EXPECTED[file];
  const used = !!table && table.action !== 'reject' && a.chain.invoice_used;
  const exp = used ? { ...USED, sameHashAs: table.sameHashAs } : table;
  const [na, nb] = a.normalized;
  const verified = a.reading.readers.map((r) => (r.receipt.verified ? r.receipt.signature_kind : 'NO')).join('/');
  const problems: string[] = [];
  if (!exp) problems.push('no expectation');
  else {
    if (a.decision.action !== exp.action) problems.push(`action ${a.decision.action}`);
    if (exp.reason && !a.decision.reasons.some((r) => r.includes(exp.reason!))) problems.push(`missing reason "${exp.reason}"`);
    if (exp.sameHashAs && hashOf(exp.sameHashAs) !== a.decision.invoice_hash) problems.push(`hash differs from ${exp.sameHashAs}`);
  }
  if (!problems.length) pass++;
  rows.push([
    file,
    na ? formatAmount(na.amount_base_units) : 'ERR',
    nb ? formatAmount(nb.amount_base_units) : 'ERR',
    a.comparison.agree ? 'yes' : 'NO',
    verified,
    a.decision.action,
    used ? 'reject (hash used)' : exp?.action ?? '?',
    problems.length ? `FAIL (${problems.join('; ')})` : 'PASS',
  ]);
}

const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
const line = (r: string[]) => `| ${r.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;
console.log(line(rows[0]));
console.log(`|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`);
for (const r of rows.slice(1)) console.log(line(r));
console.log(`\n${pass}/${results.length} PASS`);

// Reasons per file, and per-reader timings / tokens / e2ee mode.
console.log('\nDecisions:');
for (const { file, a } of results) {
  console.log(`  ${file}: ${a.decision.action.toUpperCase()} hash=${a.decision.invoice_hash?.slice(0, 16) ?? '-'}…`);
  for (const f of a.decision.findings) console.log(`      [${f.level}] ${f.message}`);
  for (const p of a.decision.contract_predictions) console.log(`      [contract] ${p}`);
}
console.log('\nReaders:');
const tok = { A: [0, 0], B: [0, 0] } as Record<string, number[]>;
const ms = { A: [] as number[], B: [] as number[] } as Record<string, number[]>;
const modes = new Set<string>();
for (const { a } of results) {
  for (const r of a.reading.readers) {
    if (r.usage) { tok[r.reader][0] += r.usage.prompt_tokens; tok[r.reader][1] += r.usage.completion_tokens; }
    ms[r.reader].push(r.timings_ms.inference);
    modes.add(`${r.reader} ${r.model}: e2ee=${r.receipt.e2ee ? 'on' : 'off'}${r.receipt.e2ee_fallback_reason ? ` (fallback: ${r.receipt.e2ee_fallback_reason})` : ''}, signature=${r.receipt.signature_kind ?? 'unverified'}`);
  }
}
for (const m of modes) console.log(`  ${m}`);
for (const id of ['A', 'B']) {
  const s = [...ms[id]].sort((x, y) => x - y);
  console.log(`  ${id}: inference ms median ${s[Math.floor(s.length / 2)]}, max ${s[s.length - 1]}; tokens in/out ${tok[id][0]}/${tok[id][1]}`);
}
console.log(`  wall time ${wall} ms for ${results.length} invoices`);

const outFile = resolve(FIXTURES, '../eval-results.json');
await writeFile(outFile, toJson(results.map(({ file, a }) => ({ file, ...a }))));
console.log(`\nfull results: ${outFile}`);
process.exitCode = pass === results.length ? 0 : 1;
