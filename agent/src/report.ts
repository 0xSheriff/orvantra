import type { Analysis } from './analyze.ts';
import { formatAmount } from './normalize.ts';

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

/** Human-readable report for one analysed invoice. */
export function formatReport(a: Analysis): string {
  const out: string[] = [];
  const [ra, rb] = a.reading.readers;
  const [na, nb] = a.normalized;
  out.push(`Invoice: ${a.reading.file} (${a.reading.pages} page${a.reading.pages === 1 ? '' : 's'}, ${a.reading.total_ms} ms)`);
  out.push('');
  out.push(`${pad('field', 26)}${pad(`A: ${ra.model}`, 40)}B: ${rb.model}`);
  const rows: [string, (n: NonNullable<typeof na>) => string][] = [
    ['vendor_name', (n) => n.vendor_name],
    ['vendor_near_account *', (n) => n.vendor_account ?? 'null'],
    ['invoice_number *', (n) => n.invoice_number],
    ['issue_date', (n) => n.issue_date ?? 'null'],
    ['due_date *', (n) => n.due_date ?? 'null'],
    ['currency *', (n) => n.currency],
    ['total *', (n) => formatAmount(n.amount_base_units)],
    ['line_items', (n) => n.line_items.map((l) => formatAmount(l.amount_base_units)).join(' + ') || '(none)'],
    ['payment_instructions', (n) => (n.payment_instructions_text ?? 'null').replace(/\s+/g, ' ')],
  ];
  for (const [label, f] of rows) {
    out.push(`${pad(label, 26)}${pad(na ? f(na) : `(${ra.error ?? 'no reading'})`, 40)}${nb ? f(nb) : `(${rb.error ?? 'no reading'})`}`);
  }
  out.push('  (* = critical field, compared after normalization)');
  out.push('');
  out.push(`Agreement: ${a.comparison.agree ? 'readers AGREE on all critical fields' : 'readers DISAGREE'}`);
  for (const r of a.comparison.reasons) out.push(`  - ${r}`);
  out.push('');
  out.push('Verification (NEAR AI Cloud):');
  for (const r of a.reading.readers) {
    const v = r.receipt;
    out.push(
      `  ${r.reader} ${r.model}: ${v.verified ? `VERIFIED (${v.signature_kind})` : `UNVERIFIED (${v.error})`}, e2ee=${v.e2ee ? 'on' : 'off'}` +
        `${v.e2ee_fallback_reason ? ` [e2ee fallback: ${v.e2ee_fallback_reason}]` : ''}, id=${v.completion_id ?? '-'}, ` +
        `${r.timings_ms.inference} ms + verify ${r.timings_ms.verification} ms` +
        (r.usage ? `, tokens ${r.usage.prompt_tokens}/${r.usage.completion_tokens}` : ''),
    );
  }
  out.push('');
  const c = a.chain;
  out.push(`On-chain (${c.network}, read-only): registry ${c.registry_id}, treasury ${c.treasury_id}${c.error ? ` — ERROR ${c.error}` : ''}`);
  out.push(`  registry entry: ${c.registry ? `${c.registry.display_name} v${c.registry.version} -> ${c.registry.payout.address} on ${c.registry.payout.chain}` : 'none'}`);
  out.push(`  vendor policy:  ${c.vendor_policy ? `max_per_invoice ${formatAmount(BigInt(c.vendor_policy.max_per_invoice))}, monthly_cap ${formatAmount(BigInt(c.vendor_policy.monthly_cap))}` : 'none'}`);
  out.push(`  paid history:   ${c.vendor_paid_amounts.length ? c.vendor_paid_amounts.map((x) => formatAmount(BigInt(x))).join(', ') : 'none'}`);
  out.push(`  invoice used:   ${c.invoice_used}`);
  out.push('');
  const d = a.decision;
  out.push(`DECISION: ${d.action.toUpperCase()}`);
  out.push(`  invoice_hash: ${d.invoice_hash ?? '-'}`);
  out.push(`  amount:       ${d.amount_base_units ? `${formatAmount(BigInt(d.amount_base_units))} USDC (${d.amount_base_units} base units)` : '-'}`);
  out.push(`  payout:       ${d.payout ? `${d.payout.address} on ${d.payout.chain} (${d.payout.asset_id}), registry v${d.payout.version} — from the REGISTRY, not the invoice` : '-'}`);
  for (const f of d.findings) out.push(`  [${f.level}] ${f.message}`);
  for (const n of d.notes) out.push(`  [note] ${n}`);
  for (const p of d.contract_predictions) out.push(`  [contract] ${p}`);
  return out.join('\n');
}
