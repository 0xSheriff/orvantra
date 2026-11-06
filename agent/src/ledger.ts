// Local audit ledger of everything the agent did per invoice: agent/data/ledger.json (gitignored).
// invoice_hash -> { file, payment id, quote summary, statuses[] }. The chain is the source of truth; this is the
// agent's own memory (what it sent, and why), useful for the UI and for not re-sending.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface LedgerStatus {
  at: string;
  /** e.g. analyzed:hold, quote:ok, dry-run, proposed, Pending, Paid, 1click:SUCCESS */
  status: string;
  detail?: string;
}

export interface LedgerEntry {
  invoice_hash: string;
  file: string;
  network: string;
  treasury: string;
  vendor: string | null;
  amount: string | null;
  invoice_number: string | null;
  decision: string;
  path?: string;
  agent_flags?: string[];
  quote?: Record<string, unknown> & { quote_hash: string | null; simulated: boolean };
  deposit_address?: string | null;
  payment_id?: number | null;
  tx_hash?: string | null;
  statuses: LedgerStatus[];
}

export type Ledger = Record<string, LedgerEntry>;

const here = dirname(fileURLToPath(import.meta.url));
export const defaultLedgerPath = (env: NodeJS.ProcessEnv = process.env) => env.ORVANTRA_LEDGER ?? resolve(here, '../data/ledger.json');

export function readLedger(path: string): Ledger {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path} is not a ledger object`);
  return parsed as Ledger;
}

/** Atomic write (tmp + rename). */
export function writeLedger(path: string, ledger: Ledger): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Pure: merge `patch` into the entry (creating it), append `status` if given. Returns a new ledger. */
export function upsert(ledger: Ledger, hash: string, patch: Partial<LedgerEntry> & Pick<LedgerEntry, 'file'>, status?: Omit<LedgerStatus, 'at'>, now = new Date()): Ledger {
  const prev = ledger[hash];
  const base: LedgerEntry = prev ?? {
    invoice_hash: hash, file: patch.file, network: '', treasury: '', vendor: null, amount: null, invoice_number: null, decision: '', statuses: [],
  };
  const next: LedgerEntry = { ...base, ...patch, invoice_hash: hash, statuses: [...base.statuses] };
  if (status) next.statuses.push({ at: now.toISOString(), ...status });
  return { ...ledger, [hash]: next };
}

/** Already sent on-chain for this network + treasury? (then the agent must not send again) */
export function alreadyProposed(ledger: Ledger, hash: string, network: string, treasury: string): LedgerEntry | null {
  const e = ledger[hash];
  return e && e.network === network && e.treasury === treasury && e.tx_hash ? e : null;
}
