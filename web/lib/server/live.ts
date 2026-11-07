// Reads the homepage live line from the treasury (get_payments) + the agent ledger. Read-only, cached for 30 s per
// server process. When the chain cannot be read the result is null and the page shows no numbers.
import 'server-only';
import { readLedger, type LedgerEntry } from 'orvantra-agent/ledger';
import { getPayments } from 'orvantra-agent/near';
import { liveCounts, liveEvents, type LiveCounts } from '../live';
import { near, serverConfig } from './config';

const TTL_MS = 30_000;
let cached: { at: number; value: Promise<LiveCounts | null> } | null = null;

async function read(): Promise<LiveCounts | null> {
  const cfg = serverConfig();
  let payments;
  try {
    payments = await getPayments(near());
  } catch {
    return null;
  }
  let ledger: LedgerEntry[] = [];
  try {
    ledger = Object.values(readLedger(cfg.ledgerPath));
  } catch {
    ledger = [];
  }
  return liveCounts(liveEvents(payments, ledger, cfg.treasuryId), Date.now());
}

export function getLiveCounts(): Promise<LiveCounts | null> {
  const now = Date.now();
  if (!cached || now - cached.at > TTL_MS) cached = { at: now, value: read() };
  return cached.value;
}
