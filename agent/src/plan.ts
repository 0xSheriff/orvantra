// Pure planning for a payment proposal: which path, what quote to expect, exact propose_payment args. No I/O.
import type { Decision } from './checks.ts';
import type { Payout, TreasuryConfig } from './near.ts';
import { MAINNET_USDC_NEAR, type QuoteExpectation } from './oneclick.ts';

export type PayPath = 'direct' | 'oneclick' | 'oneclick-simulated';

export const SIMULATED_LABEL = 'SIMULATED 1Click deposit — testnet has no NEAR Intents';
export const DEFAULT_SIM_DEPOSIT_ACCOUNT = 'orvantra-1click-sim.testnet';
/** ORIGIN_CHAIN dry quotes need an existing mainnet refundTo; the testnet treasury does not exist on mainnet. */
export const DEFAULT_SIM_QUOTE_REFUND_TO = 'intents.near';

// Same limits as the treasury contract (contracts/treasury/src/policy.rs).
export const MAX_AGENT_FLAGS = 8;
export const MAX_AGENT_FLAG_CHARS = 200;
export const MAX_MEMO_BYTES = 256;
export const DEFAULT_PROPOSE_GAS_TGAS = 150;

/** Same rule as the contract's select_destination: our token on NEAR = pay the vendor directly. */
export function selectPath(network: string, payout: Payout, treasuryToken: string): PayPath {
  if (payout.chain === 'near' && payout.asset_id === `nep141:${treasuryToken}`) return 'direct';
  return network === 'mainnet' ? 'oneclick' : 'oneclick-simulated';
}

/**
 * What the 1Click quote must say. On mainnet the origin is the treasury's own token and refunds go to the treasury.
 * On testnet (simulated) we price the same payout with MAINNET USDC and a mainnet stand-in refundTo; the quote is
 * dry and only proves price + signature, it never moves money.
 */
export function quoteExpectation(o: {
  path: PayPath;
  payout: Payout;
  amount: string;
  treasuryId: string;
  treasuryToken: string;
  dry: boolean;
  simRefundTo?: string;
}): QuoteExpectation | null {
  if (o.path === 'direct') return null;
  if (o.path === 'oneclick') {
    return { dry: o.dry, originAsset: `nep141:${o.treasuryToken}`, destinationAsset: o.payout.asset_id, recipient: o.payout.address, amount: o.amount, refundTo: o.treasuryId };
  }
  return { dry: true, originAsset: MAINNET_USDC_NEAR, destinationAsset: o.payout.asset_id, recipient: o.payout.address, amount: o.amount, refundTo: o.simRefundTo ?? DEFAULT_SIM_QUOTE_REFUND_TO };
}

/** Day-4 hold reasons -> agent_flags, within the contract's bounds (<= 8, each 1..=200 chars). */
export function agentFlags(decision: Pick<Decision, 'action' | 'findings'>): string[] {
  if (decision.action !== 'hold') return [];
  const holds = decision.findings.filter((f) => f.level === 'hold').map((f) => f.message.trim()).filter(Boolean);
  const truncate = (s: string) => ([...s].length > MAX_AGENT_FLAG_CHARS ? `${[...s].slice(0, MAX_AGENT_FLAG_CHARS - 1).join('')}…` : s);
  const out = holds.map(truncate);
  if (out.length > MAX_AGENT_FLAGS) {
    const extra = out.length - (MAX_AGENT_FLAGS - 1);
    return [...out.slice(0, MAX_AGENT_FLAGS - 1), `+${extra} more hold reasons (see agent ledger)`];
  }
  return out;
}

export function memoFor(invoiceNumber: string | null | undefined): string | null {
  if (!invoiceNumber) return null;
  const buf = Buffer.from(invoiceNumber, 'utf8');
  if (buf.length <= MAX_MEMO_BYTES) return invoiceNumber;
  let s = invoiceNumber;
  while (Buffer.byteLength(s, 'utf8') > MAX_MEMO_BYTES) s = [...s].slice(0, -1).join('');
  return s;
}

export interface ProposeArgs {
  invoice_hash: string;
  vendor: string;
  amount: string;
  payout_version: number;
  deposit_address: string | null;
  quote_hash: string | null;
  memo: string | null;
  agent_flags: string[] | null;
}

export function buildProposeArgs(o: {
  invoiceHash: string;
  vendor: string;
  amount: string;
  payoutVersion: number;
  path: PayPath;
  depositAddress: string | null;
  quoteHash: string | null;
  invoiceNumber: string | null;
  flags: string[];
}): ProposeArgs {
  if (o.path !== 'direct' && !o.depositAddress) throw new Error('cross-chain payment needs a deposit address');
  if (!/^\d+$/.test(o.amount) || BigInt(o.amount) <= 0n) throw new Error(`bad amount ${o.amount}`);
  return {
    invoice_hash: o.invoiceHash,
    vendor: o.vendor,
    amount: o.amount,
    payout_version: o.payoutVersion,
    // Direct payouts go to the registry address; the contract ignores any deposit address, so send none.
    deposit_address: o.path === 'direct' ? null : o.depositAddress,
    quote_hash: o.path === 'direct' ? null : o.quoteHash,
    memo: memoFor(o.invoiceNumber),
    agent_flags: o.flags.length ? o.flags : null,
  };
}

/** Things that make the agent refuse to send at all (the contract would reject, or the setup is wrong). */
export function preflightProblems(o: { config: TreasuryConfig; signerId: string; storageMin: string | null }): string[] {
  const p: string[] = [];
  if (o.config.paused) p.push('treasury is paused');
  if (o.config.agent !== o.signerId) p.push(`treasury agent is ${o.config.agent}, but the key belongs to ${o.signerId}`);
  if (o.config.storage_deposit === undefined) {
    p.push('treasury has no storage_deposit setting (pre-Day-5 contract): payouts to unregistered accounts would fail — deploy the new treasury');
  } else if (o.storageMin != null && BigInt(o.config.storage_deposit) < BigInt(o.storageMin)) {
    p.push(`treasury storage_deposit ${o.config.storage_deposit} < token minimum ${o.storageMin} yoctoNEAR: owner must call set_storage_deposit`);
  }
  return p;
}
