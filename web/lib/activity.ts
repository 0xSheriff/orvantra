// Chronological events from invoice rows (chain payments + ledger + upload records). Pure.
import { fmtAmount, nsToIso } from './format';
import type { Row } from './rows';
import { rankIssues, shortPhrase } from './verdict';

export interface ActivityEvent {
  at: string;
  rowKey: string;
  tone: 'held' | 'paid' | 'rej' | 'plain';
  text: string;
  amount: string | null;
}

export function buildActivity(rows: Row[], unit: string, threshold: string | null = null): ActivityEvent[] {
  const out: Omit<ActivityEvent, 'amount'>[] = [];
  const amounts = new Map<string, string | null>();
  for (const r of rows) {
    amounts.set(r.key, r.amount);
    const what = `${r.invoiceNumber ?? 'an invoice'} from ${r.vendorName}`;
    const received = r.record?.received_at ?? r.ledger?.statuses[0]?.at ?? null;
    if (received) out.push({ at: received, rowKey: r.key, tone: 'plain', text: `Read ${what}` });

    const p = r.payment;
    if (p) {
      const created = nsToIso(p.created_at);
      const updated = p.updated_at && p.updated_at !== p.created_at ? nsToIso(p.updated_at) : null;
      const holds = rankIssues(p.reasons.filter((x) => !x.startsWith('owner:')));
      const heldAtFirst = holds.length > 0 && (p.status !== 'Paid' || !!p.approved_by_owner);
      if (created) {
        out.push({
          at: created, rowKey: r.key, tone: heldAtFirst ? 'held' : 'plain',
          text: heldAtFirst ? `Payment #${p.id} held for you: ${shortPhrase(holds[0], { threshold })}` : `Payment #${p.id} proposed`,
        });
      }
      const at = updated ?? (p.status === 'Paid' && !heldAtFirst ? created : null);
      if (at && p.status !== 'Pending') {
        const text = p.status === 'Paid' ? `Payment #${p.id} paid ${p.approved_by_owner ? 'after your approval' : 'automatically'}`
          : p.status === 'Rejected' ? `Payment #${p.id} rejected${p.reasons.some((x) => x.startsWith('owner:')) ? ' by you' : `: ${p.reasons.at(-1) ?? 'no reason given'}`}`
            : p.status === 'Failed' ? `Payment #${p.id} failed: ${p.reasons.at(-1) ?? 'transfer failed'}`
              : `Payment #${p.id} is being paid`;
        out.push({ at, rowKey: r.key, tone: p.status === 'Paid' ? 'paid' : p.status === 'Rejected' || p.status === 'Failed' ? 'rej' : 'plain', text });
      }
    } else if (r.category === 'stopped' && received) {
      out.push({ at: received, rowKey: r.key, tone: 'rej', text: `${r.invoiceNumber ?? 'Invoice'} ${r.outcome.replace(/^Stopped — /, 'stopped: ').replace(/^Not sent — /, 'not sent: ')}` });
    }
  }
  return out
    .map((e, i) => ({ e, i }))
    .sort((a, b) => b.e.at.localeCompare(a.e.at) || b.i - a.i) // same moment: later step first
    .map(({ e }) => {
      const amt = amounts.get(e.rowKey);
      return { ...e, amount: amt ? `${fmtAmount(amt)} ${unit}` : null };
    });
}
