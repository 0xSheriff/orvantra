// Remembers what the notifier has already announced, so restarts never repeat or flood messages.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Payment } from '../near.ts';
import type { Ledger } from '../ledger.ts';

export interface NotifierState {
  treasury: string;
  /** payment id -> last announced (or silently recorded) status */
  payments: Record<string, string>;
  /** invoice hashes whose agent-stop was announced or recorded */
  stopped: string[];
  initialized: boolean;
}

export const emptyState = (treasury: string): NotifierState => ({ treasury, payments: {}, stopped: [], initialized: false });

export function loadState(path: string, treasury: string): NotifierState {
  if (!existsSync(path)) return emptyState(treasury);
  try {
    const s = JSON.parse(readFileSync(path, 'utf8')) as NotifierState;
    // A different treasury starts fresh (and silent) rather than replaying another treasury's history.
    return s.treasury === treasury ? { ...emptyState(treasury), ...s } : emptyState(treasury);
  } catch {
    return emptyState(treasury);
  }
}

export function saveState(path: string, s: NotifierState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, path);
}

/** Agent-stopped invoices for this treasury: rejected by the agent, never proposed on-chain. */
export function agentStopped(ledger: Ledger, treasury: string): string[] {
  return Object.values(ledger)
    .filter((e) => e.treasury === treasury && e.decision === 'reject' && e.payment_id == null)
    .map((e) => e.invoice_hash);
}

export interface Diff {
  payments: Payment[];
  stopped: string[];
}

/** What changed since `s`. On the first run everything is "already known" (returned empty). */
export function diff(s: NotifierState, payments: Payment[], stoppedHashes: string[]): Diff {
  if (!s.initialized) return { payments: [], stopped: [] };
  return {
    payments: payments.filter((p) => s.payments[String(p.id)] !== p.status),
    stopped: stoppedHashes.filter((h) => !s.stopped.includes(h)),
  };
}

/** Marks a payment status / stopped hash as handled. */
export function remember(s: NotifierState, payments: Payment[], stoppedHashes: string[]): NotifierState {
  const next = { ...s, payments: { ...s.payments }, stopped: [...s.stopped], initialized: true };
  for (const p of payments) next.payments[String(p.id)] = p.status;
  for (const h of stoppedHashes) if (!next.stopped.includes(h)) next.stopped.push(h);
  return next;
}
