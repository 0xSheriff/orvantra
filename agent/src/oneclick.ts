// 1Click (NEAR Intents) client + STRICT quote validation. HTTP via plain fetch (sends a User-Agent; JWT optional),
// signature check and quote hash from @defuse-protocol/one-click-sdk-typescript.
//
// The treasury pays the quote's depositAddress and cannot verify on-chain what that address will do. So before the
// agent proposes a cross-chain payment, every field that decides where the money goes must match what the agent
// expects (from the treasury config and the vendor REGISTRY, never from the invoice), and the 1Click signature must
// cover those exact fields.
import { quoteHash as sdkQuoteHash, verifyQuoteSignature as sdkVerify } from '@defuse-protocol/one-click-sdk-typescript';
import type { OneClickQuoteResponse, QuoteRequest, TokenResponse } from '@defuse-protocol/one-click-sdk-typescript';
import { isValidNearAccount } from './normalize.ts';

export const ONECLICK_BASE = 'https://1click.chaindefuser.com/v0';
export const USER_AGENT = 'orvantra-agent/0.1';
/** USDC on NEAR (mainnet), as a 1Click asset id. */
export const MAINNET_USDC_NEAR = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const MAINNET_USDC_CONTRACT = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

export type QuoteResponse = OneClickQuoteResponse;
export type { TokenResponse };

export type ExecutionStatus = 'KNOWN_DEPOSIT_TX' | 'PENDING_DEPOSIT' | 'INCOMPLETE_DEPOSIT' | 'PROCESSING' | 'SUCCESS' | 'REFUNDED' | 'FAILED';
export const TERMINAL_STATUSES: ReadonlySet<ExecutionStatus> = new Set(['SUCCESS', 'REFUNDED', 'FAILED']);

export interface StatusResponse {
  status: ExecutionStatus;
  updatedAt?: string;
  swapDetails?: { nearTxHashes?: string[]; destinationChainTxHashes?: { hash: string; explorerUrl: string }[]; amountOut?: string; refundedAmount?: string; refundReason?: string };
  [k: string]: unknown;
}

export interface OneClickConfig {
  baseUrl: string;
  /** Optional partner JWT (env ONECLICK_JWT). Never printed. */
  jwt?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function oneClickConfig(env: NodeJS.ProcessEnv = process.env): OneClickConfig {
  return { baseUrl: env.ONECLICK_BASE ?? ONECLICK_BASE, jwt: env.ONECLICK_JWT || undefined };
}

export class OneClickError extends Error {
  constructor(message: string, readonly status: number | null, readonly body: string) {
    super(message);
  }
}

async function call<T>(cfg: OneClickConfig, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const f = cfg.fetch ?? fetch;
  const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cfg.jwt) headers.authorization = `Bearer ${cfg.jwt}`;
  const url = `${cfg.baseUrl.replace(/\/$/, '')}${path}`;
  let res: Response;
  try {
    res = await f(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000) });
  } catch (err) {
    throw new OneClickError(`1Click ${method} ${path}: ${err instanceof Error ? err.message : String(err)}`, null, '');
  }
  const text = await res.text();
  if (!res.ok) {
    // Observed 2026-11-06: an ORIGIN_CHAIN quote whose refundTo is not an existing mainnet account gets an opaque
    // HTTP 400 "Internal server error".
    const hint = path === '/quote' && res.status === 400 ? ' (hint: refundTo must be an existing mainnet NEAR account)' : '';
    throw new OneClickError(`1Click ${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}${hint}`, res.status, text);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new OneClickError(`1Click ${method} ${path}: response is not JSON`, res.status, text);
  }
}

export const getTokens = (cfg: OneClickConfig) => call<TokenResponse[]>(cfg, 'GET', '/tokens');
export const getQuote = (cfg: OneClickConfig, req: QuoteRequest) => call<QuoteResponse>(cfg, 'POST', '/quote', req);
export const getStatus = (cfg: OneClickConfig, depositAddress: string) =>
  call<StatusResponse>(cfg, 'GET', `/status?depositAddress=${encodeURIComponent(depositAddress)}`);
export const submitDepositTx = (cfg: OneClickConfig, txHash: string, depositAddress: string, nearSenderAccount?: string) =>
  call<StatusResponse>(cfg, 'POST', '/deposit/submit', { txHash, depositAddress, ...(nearSenderAccount ? { nearSenderAccount } : {}) });

/** Poll /status until a terminal status (SUCCESS / REFUNDED / FAILED) or the timeout. Calls onChange on every new status. */
export async function pollStatus(
  cfg: OneClickConfig,
  depositAddress: string,
  o: { intervalMs?: number; timeoutMs?: number; onChange?: (s: StatusResponse) => void; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<StatusResponse | null> {
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const end = now() + (o.timeoutMs ?? 15 * 60_000);
  let last: StatusResponse | null = null;
  for (;;) {
    try {
      const s = await getStatus(cfg, depositAddress);
      if (!last || s.status !== last.status) o.onChange?.(s);
      last = s;
      if (TERMINAL_STATUSES.has(s.status)) return s;
    } catch (err) {
      // 404 right after the deposit is normal for a short while; anything else is reported but we keep polling.
      if (!(err instanceof OneClickError && err.status === 404)) o.onChange?.({ status: (last?.status ?? 'PENDING_DEPOSIT') as ExecutionStatus, error: (err as Error).message });
    }
    if (now() >= end) return last;
    await sleep(o.intervalMs ?? 5_000);
  }
}

// ------------------------------------------------------------------ request building + validation (pure)

/** What the quote MUST say. Everything comes from the treasury config and the vendor registry. */
export interface QuoteExpectation {
  dry: boolean;
  /** 1Click asset id of the treasury's token, e.g. nep141:<usdc contract>. */
  originAsset: string;
  /** registry payout.asset_id */
  destinationAsset: string;
  /** registry payout.address */
  recipient: string;
  /** invoice amount, origin-asset base units (EXACT_INPUT) */
  amount: string;
  /** the treasury account (refunds go back to it on NEAR) */
  refundTo: string;
}

export const DEFAULT_SLIPPAGE_BPS = 100;
/** The treasury only pays a deposit address shaped like this (64 lowercase hex = NEAR implicit account). */
const IMPLICIT_ACCOUNT = /^[0-9a-f]{64}$/;

export interface QuoteOptions {
  /** Slippage requested in the quote and required back in the signed request (default 100 = 1%). */
  slippageBps?: number;
  /** Real quotes: minimum time between now and the quote deadline (default 30 min). */
  minLeadMs?: number;
  /** How long 1Click may take before refunding (default 1 h). */
  deadlineMs?: number;
  /** Max allowed USD loss amountIn→amountOut in basis points (default 300 = 3%). */
  maxLossBps?: number;
}

export function buildQuoteRequest(e: QuoteExpectation, now: Date, o: QuoteOptions = {}): QuoteRequest {
  return {
    dry: e.dry,
    swapType: 'EXACT_INPUT' as QuoteRequest.swapType,
    slippageTolerance: o.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
    originAsset: e.originAsset,
    depositType: 'ORIGIN_CHAIN' as QuoteRequest.depositType,
    destinationAsset: e.destinationAsset,
    amount: e.amount,
    refundTo: e.refundTo,
    refundType: 'ORIGIN_CHAIN' as QuoteRequest.refundType,
    recipient: e.recipient,
    recipientType: 'DESTINATION_CHAIN' as QuoteRequest.recipientType,
    deadline: new Date(now.getTime() + (o.deadlineMs ?? 3_600_000)).toISOString(),
  };
}

export interface QuoteCheck {
  ok: boolean;
  errors: string[];
  /** base58(sha256(signed payload)), the exact message 1Click signed. Stored on-chain as quote_hash. */
  quote_hash: string | null;
  signature_valid: boolean;
  deposit_address: string | null;
}

export interface ValidateDeps {
  verify?: (q: QuoteResponse) => boolean;
  hash?: (q: QuoteResponse) => string;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Exact comparison, except EVM addresses (checksum case is not part of the address). */
export const sameAddr = (a: string | undefined, b: string) =>
  typeof a === 'string' && (EVM_ADDRESS.test(b) && EVM_ADDRESS.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b);

/** A real quote's deadline must leave at least this long for the owner to approve and the deposit to land. */
export const MIN_QUOTE_LEAD_MS = 30 * 60_000;

/**
 * Strict validation of a 1Click quote against what the agent expects. Any mismatch is an error; the agent must not
 * propose a payment with a quote that has errors. The checks read the SIGNED fields (response.quoteRequest and
 * response.quote), so a tampered field also breaks the signature.
 */
export function validateQuote(q: QuoteResponse, e: QuoteExpectation, now: Date, o: QuoteOptions = {}, d: ValidateDeps = {}): QuoteCheck {
  const errors: string[] = [];
  const r = q?.quoteRequest;
  const quote = q?.quote;
  if (!r || !quote || typeof q.signature !== 'string') {
    return { ok: false, errors: ['malformed quote response (missing quoteRequest/quote/signature)'], quote_hash: null, signature_valid: false, deposit_address: null };
  }

  const signatureValid = (d.verify ?? sdkVerify)(q);
  if (!signatureValid) errors.push('1Click signature is INVALID for this quote');
  let hash: string | null = null;
  try {
    hash = (d.hash ?? sdkQuoteHash)(q);
  } catch (err) {
    errors.push(`cannot hash quote: ${err instanceof Error ? err.message : String(err)}`);
  }

  const must = (label: string, got: unknown, want: unknown) => {
    if (got !== want) errors.push(`${label} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  };
  must('dry', r.dry, e.dry);
  must('swapType', r.swapType, 'EXACT_INPUT');
  must('originAsset', r.originAsset, e.originAsset);
  must('destinationAsset', r.destinationAsset, e.destinationAsset);
  if (!sameAddr(r.recipient, e.recipient)) errors.push(`recipient is ${JSON.stringify(r.recipient)}, expected the registry payout ${e.recipient}`);
  must('recipientType', r.recipientType, 'DESTINATION_CHAIN');
  must('slippageTolerance', r.slippageTolerance, o.slippageBps ?? DEFAULT_SLIPPAGE_BPS);
  must('amount', r.amount, e.amount);
  must('quote.amountIn', quote.amountIn, e.amount);
  must('refundTo', r.refundTo, e.refundTo);
  must('depositType', r.depositType, 'ORIGIN_CHAIN');
  must('refundType', r.refundType, 'ORIGIN_CHAIN');
  // Fields that could redirect or alter delivery: we never ask for them, so they must be absent.
  for (const k of ['customRecipientMsg', 'virtualChainRecipient', 'virtualChainRefundRecipient'] as const) {
    if (r[k] || quote[k]) errors.push(`unexpected ${k} in quote`);
  }

  const reqDeadline = Date.parse(r.deadline);
  if (!Number.isFinite(reqDeadline)) errors.push(`deadline ${JSON.stringify(r.deadline)} is not a date`);
  else if (reqDeadline <= now.getTime()) errors.push(`deadline ${r.deadline} has passed`);

  let depositAddress: string | null = null;
  if (!e.dry) {
    depositAddress = quote.depositAddress ?? null;
    if (!depositAddress) errors.push('real quote has no depositAddress');
    else if (!IMPLICIT_ACCOUNT.test(depositAddress)) errors.push(`depositAddress ${depositAddress} is not a 64-hex NEAR implicit account (the only kind the treasury pays)`);
    if (quote.depositMemo) errors.push('quote requires a deposit memo (not supported: the treasury cannot attach one)');
    // A real quote must carry its own deadline, far enough ahead for the owner to approve and for the deposit to land.
    const t = quote.deadline ? Date.parse(quote.deadline) : NaN;
    if (!quote.deadline) errors.push('real quote has no deadline');
    else if (!Number.isFinite(t) || t <= now.getTime()) errors.push(`quote deadline ${quote.deadline} has passed`);
    else if (t < now.getTime() + (o.minLeadMs ?? MIN_QUOTE_LEAD_MS)) errors.push(`quote deadline ${quote.deadline} is less than ${(o.minLeadMs ?? MIN_QUOTE_LEAD_MS) / 60_000} minutes away`);
  } else if (quote.depositAddress) {
    errors.push('dry quote unexpectedly has a depositAddress');
  }

  // Price sanity (signed USD values): a stablecoin payout should not lose more than maxLossBps.
  const inUsd = Number(quote.amountInUsd);
  const outUsd = Number(quote.amountOutUsd);
  const maxLoss = o.maxLossBps ?? 300;
  const amountOut = /^\d+$/.test(quote.amountOut ?? '') ? BigInt(quote.amountOut) : 0n;
  if (!(amountOut > 0n)) errors.push('quote amountOut is not positive');
  // The USD values are signed; without them there is no price check at all, so they are required.
  if (!quote.amountInUsd || !quote.amountOutUsd || !Number.isFinite(inUsd) || !Number.isFinite(outUsd) || inUsd <= 0 || outUsd <= 0) {
    errors.push('quote has no usable USD values (amountInUsd / amountOutUsd), so the price cannot be checked');
  } else if (outUsd < inUsd * (1 - maxLoss / 10_000)) {
    errors.push(`quote loses too much: $${quote.amountInUsd} in -> $${quote.amountOutUsd} out (max ${maxLoss / 100}%)`);
  }
  // minAmountOut is what 1Click guarantees: it may be at most `slippage` below the quoted amountOut.
  const slippage = BigInt(o.slippageBps ?? DEFAULT_SLIPPAGE_BPS);
  if (!/^\d+$/.test(quote.minAmountOut ?? '')) errors.push('quote has no minAmountOut');
  else if (BigInt(quote.minAmountOut) < (amountOut * (10_000n - slippage)) / 10_000n) {
    errors.push(`quote minAmountOut ${quote.minAmountOut} is more than ${Number(slippage) / 100}% below amountOut ${quote.amountOut}`);
  }

  return { ok: errors.length === 0, errors, quote_hash: hash, signature_valid: signatureValid, deposit_address: depositAddress };
}

/** Short, printable summary for the ledger and the console. */
export function quoteSummary(q: QuoteResponse) {
  return {
    dry: q.quoteRequest.dry,
    origin_asset: q.quoteRequest.originAsset,
    destination_asset: q.quoteRequest.destinationAsset,
    recipient: q.quoteRequest.recipient,
    amount_in: q.quote.amountIn,
    amount_in_usd: q.quote.amountInUsd,
    amount_out: q.quote.amountOut,
    amount_out_formatted: q.quote.amountOutFormatted,
    min_amount_out: q.quote.minAmountOut,
    amount_out_usd: q.quote.amountOutUsd,
    deposit_address: q.quote.depositAddress ?? null,
    deadline: q.quote.deadline ?? q.quoteRequest.deadline,
    time_estimate_s: q.quote.timeEstimate,
    timestamp: q.timestamp,
    correlation_id: q.correlationId,
    signature: q.signature,
  };
}
