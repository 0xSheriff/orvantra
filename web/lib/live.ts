// The homepage "Live on testnet · N scam stopped, M invoices paid today" line. Pure: inputs are the treasury's
// payments and the agent ledger; the server module (lib/server/live.ts) reads them and caches the result.
import type { LedgerEntry } from 'orvantra-agent/ledger';
import type { Payment } from 'orvantra-agent/near';

/** The server's time zone for "today" (viewer-independent). WAT, UTC+1. */
export const LIVE_TZ = 'Africa/Lagos';

export type LivePeriod = 'today' | 'this week' | 'so far';

export interface LiveCounts {
  stopped: number;
  paid: number;
  period: LivePeriod;
}

interface LiveEvent {
  kind: 'stopped' | 'paid';
  /** epoch milliseconds */
  at: number;
}

const nsToMs = (ns: string | undefined | null): number | null => {
  if (!ns) return null;
  try {
    return Number(BigInt(ns) / 1_000_000n);
  } catch {
    return null;
  }
};

/**
 * Events that count: on-chain Paid (stamped when it settled, else when proposed), on-chain Rejected, and invoices
 * the agent itself rejected before anything reached the chain (ledger decision "reject", no payment id). Ledger
 * entries for another treasury are ignored.
 */
export function liveEvents(payments: Payment[], ledger: LedgerEntry[], treasuryId: string): LiveEvent[] {
  const out: LiveEvent[] = [];
  for (const p of payments) {
    if (p.status !== 'Paid' && p.status !== 'Rejected') continue;
    const at = nsToMs(p.updated_at) ?? nsToMs(p.created_at);
    if (at == null) continue;
    out.push({ kind: p.status === 'Paid' ? 'paid' : 'stopped', at });
  }
  for (const e of ledger) {
    if (e.decision !== 'reject' || e.payment_id != null) continue;
    if (e.treasury && e.treasury !== treasuryId) continue;
    const iso = e.created_at ?? e.statuses[0]?.at;
    const at = iso ? Date.parse(iso) : NaN;
    if (Number.isNaN(at)) continue;
    out.push({ kind: 'stopped', at });
  }
  return out;
}

/** Calendar day number (days since 1970-01-01) of an instant, in `tz`. */
export function dayNumber(ms: number, tz: string = LIVE_TZ): number {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ms));
  const n = (t: string) => Number(parts.find((x) => x.type === t)?.value);
  return Date.UTC(n('year'), n('month') - 1, n('day')) / 86_400_000;
}

/**
 * Counts for today; if nothing happened today, for this week (Monday to today); else all time. Null when nothing
 * has ever been stopped or paid, so the page shows no numbers at all.
 */
export function liveCounts(events: LiveEvent[], nowMs: number, tz: string = LIVE_TZ): LiveCounts | null {
  const today = dayNumber(nowMs, tz);
  const monday = today - ((new Date(today * 86_400_000).getUTCDay() + 6) % 7);
  const days = events.map((e) => ({ kind: e.kind, day: dayNumber(e.at, tz) }));
  const windows: [LivePeriod, (d: number) => boolean][] = [
    ['today', (d) => d === today],
    ['this week', (d) => d >= monday && d <= today],
    ['so far', () => true],
  ];
  for (const [period, inWindow] of windows) {
    const hits = days.filter((e) => inWindow(e.day));
    if (hits.length > 0) {
      return { period, stopped: hits.filter((e) => e.kind === 'stopped').length, paid: hits.filter((e) => e.kind === 'paid').length };
    }
  }
  return null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "1 scam stopped" / "2 invoices paid". */
export function liveParts(c: Pick<LiveCounts, 'stopped' | 'paid'>): { stopped: string; paid: string } {
  return { stopped: plural(c.stopped, 'scam stopped', 'scams stopped'), paid: plural(c.paid, 'invoice paid', 'invoices paid') };
}
