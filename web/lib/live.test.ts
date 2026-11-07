import { describe, expect, it } from 'vitest';
import type { LedgerEntry } from 'orvantra-agent/ledger';
import type { Payment } from 'orvantra-agent/near';
import { dayNumber, liveCounts, liveEvents, liveParts } from './live';

const T = 'orvantra-treasury-v3.testnet';
const ns = (iso: string) => (BigInt(Date.parse(iso)) * 1_000_000n).toString();

const pay = (status: Payment['status'], iso: string, o: Partial<Payment> = {}): Payment => ({
  id: 0, invoice_hash: 'h', vendor: 'v.testnet', amount: '1', payout_version: 1, status, reasons: [], direct: true,
  destination: null, created_at: ns(iso), ...o,
});

const led = (decision: string, iso: string, o: Partial<LedgerEntry> = {}): LedgerEntry => ({
  invoice_hash: 'x', file: 'f.png', network: 'testnet', treasury: T, vendor: null, amount: null, invoice_number: null,
  decision, created_at: iso, statuses: [], ...o,
});

// Wednesday 2026-11-11, 12:00 WAT
const NOW = Date.parse('2026-11-11T11:00:00Z');

describe('liveEvents', () => {
  it('counts Paid and Rejected payments and agent-only rejects; ignores the rest', () => {
    const ev = liveEvents(
      [pay('Paid', '2026-11-11T08:00:00Z'), pay('Rejected', '2026-11-11T08:00:00Z'), pay('Pending', '2026-11-11T08:00:00Z'), pay('Failed', '2026-11-11T08:00:00Z')],
      [
        led('reject', '2026-11-11T09:00:00Z'),
        led('reject', '2026-11-11T09:00:00Z', { payment_id: 4 }), // already counted on-chain
        led('hold', '2026-11-11T09:00:00Z'),
        led('reject', '2026-11-11T09:00:00Z', { treasury: 'other.testnet' }),
      ],
      T,
    );
    expect(ev.map((e) => e.kind).sort()).toEqual(['paid', 'stopped', 'stopped']);
  });

  it('uses updated_at for when a payment settled, falling back to created_at', () => {
    const [e] = liveEvents([pay('Paid', '2026-11-01T00:00:00Z', { updated_at: ns('2026-11-11T10:00:00Z') })], [], T);
    expect(e.at).toBe(Date.parse('2026-11-11T10:00:00Z'));
  });

  it('falls back to the first ledger status time when created_at is missing', () => {
    const [e] = liveEvents([], [led('reject', '', { created_at: undefined, statuses: [{ at: '2026-11-10T10:00:00Z', status: 'analyzed:reject' }] })], T);
    expect(e.at).toBe(Date.parse('2026-11-10T10:00:00Z'));
  });
});

describe('liveCounts', () => {
  it('counts today when anything happened today', () => {
    const ev = liveEvents([pay('Paid', '2026-11-11T08:00:00Z'), pay('Paid', '2026-11-11T09:00:00Z'), pay('Paid', '2026-11-09T09:00:00Z')], [led('reject', '2026-11-11T10:00:00Z')], T);
    expect(liveCounts(ev, NOW)).toEqual({ period: 'today', stopped: 1, paid: 2 });
  });

  it('uses the Lagos day, not UTC: 23:30 UTC the night before is already today in WAT', () => {
    const ev = liveEvents([pay('Paid', '2026-11-10T23:30:00Z')], [], T);
    expect(liveCounts(ev, NOW)?.period).toBe('today');
    expect(liveCounts(ev, NOW, 'UTC')?.period).toBe('this week');
  });

  it('falls back to this week (Monday to today) when today is empty', () => {
    const ev = liveEvents([pay('Rejected', '2026-11-09T08:00:00Z'), pay('Paid', '2026-11-08T08:00:00Z')], [], T); // Mon, Sun before
    expect(liveCounts(ev, NOW)).toEqual({ period: 'this week', stopped: 1, paid: 0 });
  });

  it('falls back to all time when this week is empty', () => {
    const ev = liveEvents([pay('Paid', '2026-11-02T08:00:00Z')], [led('reject', '2026-10-30T08:00:00Z')], T);
    expect(liveCounts(ev, NOW)).toEqual({ period: 'so far', stopped: 1, paid: 1 });
  });

  it('returns null when nothing was ever stopped or paid', () => {
    expect(liveCounts([], NOW)).toBeNull();
  });

  it('a Monday is its own week start', () => {
    const monNow = Date.parse('2026-11-09T12:00:00Z');
    const ev = liveEvents([pay('Paid', '2026-11-08T12:00:00Z')], [], T); // Sunday
    expect(liveCounts(ev, monNow)?.period).toBe('so far');
  });
});

describe('dayNumber / liveParts', () => {
  it('computes calendar days in the zone', () => {
    expect(dayNumber(Date.parse('2026-11-10T23:30:00Z'), 'Africa/Lagos') - dayNumber(Date.parse('2026-11-10T23:30:00Z'), 'UTC')).toBe(1);
  });

  it('pluralises', () => {
    expect(liveParts({ stopped: 1, paid: 2 })).toEqual({ stopped: '1 scam stopped', paid: '2 invoices paid' });
    expect(liveParts({ stopped: 0, paid: 1 })).toEqual({ stopped: '0 scams stopped', paid: '1 invoice paid' });
  });
});
