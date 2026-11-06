import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { alreadyProposed, ledgerCreatedAt, readLedger, upsert, writeLedger } from '../src/ledger.ts';

const T0 = new Date('2026-11-06T10:00:00Z');
const T1 = new Date('2026-11-06T10:01:00Z');

describe('ledger', () => {
  it('upsert creates, merges and appends statuses without mutating the input', () => {
    const l0 = {};
    const l1 = upsert(l0, 'h1', { file: 'a.png', network: 'testnet', treasury: 't.testnet', decision: 'propose' }, { status: 'analyzed:propose' }, T0);
    const l2 = upsert(l1, 'h1', { file: 'a.png', payment_id: 3, tx_hash: 'TX' }, { status: 'Paid', detail: 'ok' }, T1);
    expect(l0).toEqual({});
    expect(l1.h1.statuses).toHaveLength(1);
    expect(l2.h1).toMatchObject({ invoice_hash: 'h1', file: 'a.png', network: 'testnet', decision: 'propose', payment_id: 3, tx_hash: 'TX' });
    expect(l2.h1.statuses).toEqual([
      { at: T0.toISOString(), status: 'analyzed:propose' },
      { at: T1.toISOString(), status: 'Paid', detail: 'ok' },
    ]);
  });

  it('created_at is set once on creation and kept; legacy entries fall back to the first status', () => {
    const l1 = upsert({}, 'h', { file: 'f' }, { status: 'dry-run' }, T0);
    const l2 = upsert(l1, 'h', { file: 'f', created_at: 'ignored' }, { status: 'proposed' }, T1);
    expect(l2.h.created_at).toBe(T0.toISOString());
    expect(ledgerCreatedAt(l2.h)).toBe(T0.toISOString());
    const legacy = { ...l2.h, created_at: undefined, statuses: [{ at: T1.toISOString(), status: 'x' }] };
    expect(ledgerCreatedAt(legacy)).toBe(T1.toISOString());
    expect(ledgerCreatedAt({ ...legacy, statuses: [] })).toBeNull();
  });

  it('alreadyProposed only for the same network + treasury and only once a tx was sent', () => {
    let l = upsert({}, 'h', { file: 'f', network: 'testnet', treasury: 't1' }, { status: 'dry-run' });
    expect(alreadyProposed(l, 'h', 'testnet', 't1')).toBeNull();
    l = upsert(l, 'h', { file: 'f', tx_hash: 'TX' }, { status: 'proposed' });
    expect(alreadyProposed(l, 'h', 'testnet', 't1')?.tx_hash).toBe('TX');
    expect(alreadyProposed(l, 'h', 'testnet', 't2')).toBeNull();
    expect(alreadyProposed(l, 'h', 'mainnet', 't1')).toBeNull();
    expect(alreadyProposed(l, 'other', 'testnet', 't1')).toBeNull();
  });

  it('read/write round trip; missing file = empty ledger; rejects non-objects', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orv-ledger-'));
    const p = join(dir, 'sub', 'ledger.json');
    expect(readLedger(p)).toEqual({});
    const l = upsert({}, 'h', { file: 'f' }, { status: 'x' }, T0);
    writeLedger(p, l);
    expect(readLedger(p)).toEqual(l);
    writeLedger(p, [] as never);
    expect(() => readLedger(p)).toThrow(/not a ledger/);
    expect(readFileSync(p, 'utf8').endsWith('\n')).toBe(true);
  });
});
