// The Day 5 pipeline as a function, shared by the CLI (`npm run pay`) and the web app (`src/web-run.ts`):
//
// analyze (two NEAR AI readers + checks) -> reject => stop
//   -> path: direct (vendor wants our token on NEAR) | 1Click (mainnet) | SIMULATED 1Click (testnet)
//   -> 1Click quote: signature verified + strict validation against the REGISTRY payout
//   -> treasury.propose_payment signed with the agent's FUNCTION-CALL key (propose_payment only)
//   -> read back the on-chain payment (Paid / Pending / Rejected) + explorer link
//   -> mainnet cross-chain + Paid: submit the deposit tx to 1Click and poll until terminal.
// Without `execute` it is a DRY RUN: it reports exactly what would be sent and sends nothing.
// The contract makes every decision; the agent never approves anything.
import { analyzeInvoice, toJson, type Analysis } from './analyze.ts';
import type { PageImage } from './extract.ts';
import { checkKeyPermission, keyPath, loadKey } from './keys.ts';
import { alreadyProposed, defaultLedgerPath, readLedger, upsert, writeLedger, type Ledger, type LedgerEntry } from './ledger.ts';
import * as near from './near.ts';
import { formatAmount } from './normalize.ts';
import {
  buildQuoteRequest, getQuote, oneClickConfig, pollStatus, quoteSummary, sameAddr, submitDepositTx, validateQuote,
} from './oneclick.ts';
import {
  agentFlags, buildProposeArgs, DEFAULT_PROPOSE_GAS_TGAS, DEFAULT_SIM_DEPOSIT_ACCOUNT, preflightProblems, quoteExpectation,
  selectPath, SIMULATED_LABEL, type PayPath,
} from './plan.ts';
import { formatReport } from './report.ts';
import { explorerTxUrl, signAndSend, TGAS, treasuryEvents } from './tx.ts';

/** Coarse progress steps (the web UI shows these). */
export type PayStep = 'read' | 'check' | 'quote' | 'propose' | 'result';
export type StepState = 'start' | 'done' | 'skip' | 'error';

export interface PayHooks {
  /** Human-readable log lines (the CLI prints them). */
  log?: (line: string) => void;
  step?: (step: PayStep, state: StepState, detail?: string) => void;
  onPages?: (pages: PageImage[]) => void | Promise<void>;
}

export interface PayOptions {
  execute: boolean;
  ledgerPath?: string;
  /** Extra fields stored on the ledger entry (e.g. the web upload id). */
  ledgerExtra?: Partial<LedgerEntry>;
  /** Display name stored in the ledger (defaults to the file's base name). */
  fileName?: string;
}

export type PayOutcome =
  | 'no-hash' // vendor / number / amount unreadable: nothing sent
  | 'rejected' // the agent rejected the invoice: nothing sent
  | 'cannot-propose' // NEAR state / registry / config missing: nothing sent
  | 'already-proposed' // the ledger shows this invoice was already sent to this treasury
  | 'quote-invalid' // 1Click quote did not match the registry: nothing sent
  | 'dry-run' // everything prepared, nothing signed
  | 'preflight-failed' // key or treasury setup problem: nothing sent
  | 'contract-refused' // transaction failed on-chain
  | 'proposed'; // payment exists on-chain (see payment.status)

/** What the owner needs to see before confirming a cross-chain payout (shown on the review screen). */
export interface QuoteEvidence {
  quote_hash: string | null;
  simulated: boolean;
  /** The 1Click manager-key signature over the quote verified. */
  signature_valid: boolean;
  /** The quote's recipient equals the vendor's registry address. */
  recipient_matches_registry: boolean;
  /** Every strict check passed (a failing quote is never proposed). */
  checks_ok: boolean;
}

export interface PayResult {
  outcome: PayOutcome;
  /** Process exit code the CLI uses for this outcome. */
  exitCode: number;
  message: string;
  analysis: Analysis;
  invoice_hash: string | null;
  path: PayPath | null;
  quote: (ReturnType<typeof quoteSummary> & QuoteEvidence) | null;
  deposit_address: string | null;
  agent_flags: string[];
  tx_hash: string | null;
  explorer_url: string | null;
  payment_id: number | null;
  payment: near.Payment | null;
}

export async function payInvoice(file: string, opts: PayOptions, hooks: PayHooks = {}): Promise<PayResult> {
  const log = hooks.log ?? (() => {});
  const step = hooks.step ?? (() => {});
  const { execute } = opts;
  const cfg = near.nearConfig();
  const oc = oneClickConfig();
  const network = cfg.network;
  const ledgerPath = opts.ledgerPath ?? defaultLedgerPath();
  let ledger: Ledger = readLedger(ledgerPath);
  const fileName = opts.fileName ?? file.split('/').pop() ?? file;
  let entryHash: string | null = null;

  const bar = (s: string) => log(`\n=== ${s} ${'='.repeat(Math.max(0, 74 - s.length))}`);
  const banner = (s: string) => log(`\n${'!'.repeat(78)}\n!! ${s}\n${'!'.repeat(78)}`);
  function record(patch: Partial<LedgerEntry>, status: string, detail?: string) {
    if (!entryHash) return;
    ledger = upsert(
      ledger, entryHash,
      { file: fileName, network, treasury: cfg.treasuryId, ...opts.ledgerExtra, ...patch },
      { status, ...(detail ? { detail } : {}) },
    );
    writeLedger(ledgerPath, ledger);
  }

  log(`Orvantra pay — ${execute ? 'EXECUTE (will sign and send)' : 'DRY RUN (nothing is sent)'}`);
  log(`network ${network}, treasury ${cfg.treasuryId}, registry ${cfg.registryId}, ledger ${ledgerPath}`);

  // ------------------------------------------------------------------ 1. analyze (Day 4)
  bar('1. Read + check the invoice (NEAR AI Cloud, TEE)');
  step('read', 'start');
  const analysis = await analyzeInvoice(file, {
    onPages: hooks.onPages,
    onRead: (r) => {
      const ok = r.readers.filter((x) => x.extraction).length;
      step('read', ok === r.readers.length ? 'done' : 'error', `${ok} of ${r.readers.length} readers answered`);
      step('check', 'start');
    },
  });
  log(formatReport(analysis));
  const d = analysis.decision;
  const inv = analysis.comparison.agreed;
  const config = analysis.chain.config;
  entryHash = d.invoice_hash;
  step('check', analysis.chain.error ? 'error' : 'done', d.action);

  const result: PayResult = {
    outcome: 'dry-run', exitCode: 0, message: '', analysis, invoice_hash: entryHash, path: null, quote: null,
    deposit_address: null, agent_flags: [], tx_hash: null, explorer_url: null, payment_id: null, payment: null,
  };
  const stop = (outcome: PayOutcome, exitCode: number, message: string): PayResult => {
    log(`\n${message}`);
    Object.assign(result, { outcome, exitCode, message });
    return result;
  };
  const skipRest = (from: PayStep[]) => from.forEach((s) => step(s, 'skip'));

  if (!entryHash) {
    skipRest(['quote', 'propose']);
    return stop('no-hash', 1, 'STOP: no invoice_hash (vendor account / number / amount unreadable) — nothing sent.');
  }
  record({
    vendor: inv?.vendor_account ?? null, vendor_name: inv?.vendor_name || null, amount: d.amount_base_units,
    invoice_number: inv?.invoice_number ?? null, decision: d.action, reasons: d.reasons,
  }, `analyzed:${d.action}`);

  if (d.action === 'reject') {
    skipRest(['quote', 'propose']);
    return stop('rejected', 0, `REJECTED by the agent — nothing sent.\n${d.reasons.map((r) => `  - ${r}`).join('\n')}`);
  }
  if (analysis.chain.error || !config || !d.payout || !inv?.vendor_account || !d.amount_base_units) {
    skipRest(['quote', 'propose']);
    return stop('cannot-propose', 1, `STOP: cannot build a proposal (${analysis.chain.error ?? 'missing registry payout / treasury config / amount'}) — nothing sent.`);
  }
  const prev = alreadyProposed(ledger, entryHash, network, cfg.treasuryId);
  if (prev) {
    skipRest(['quote', 'propose']);
    Object.assign(result, { tx_hash: prev.tx_hash ?? null, payment_id: prev.payment_id ?? null, explorer_url: explorerTxUrl(network, prev.tx_hash!) });
    return stop('already-proposed', 0, `Already proposed: payment #${prev.payment_id ?? '?'} tx ${prev.tx_hash} (${explorerTxUrl(network, prev.tx_hash!)}) — not sending again.`);
  }

  const vendor = inv.vendor_account;
  const amount = d.amount_base_units;
  const payout = d.payout;

  // ------------------------------------------------------------------ 2. path
  bar('2. Payment path');
  const path = selectPath(network, payout, config.token);
  result.path = path;
  log(`registry payout: ${payout.address} on ${payout.chain} (${payout.asset_id}), version ${payout.version}`);
  log(
    path === 'direct'
      ? `path: DIRECT — vendor wants nep141:${config.token} on NEAR; the treasury pays ${payout.address} itself. No quote needed.`
      : path === 'oneclick'
        ? 'path: 1CLICK (mainnet) — real quote; the treasury pays the quote\'s deposit address.'
        : `path: 1CLICK SIMULATED (testnet) — dry MAINNET quote to verify price + signature; deposit goes to a testnet stand-in.`,
  );

  // ------------------------------------------------------------------ 3. quote
  let depositAddress: string | null = null;
  let quoteHash: string | null = null;
  if (path === 'direct') {
    step('quote', 'skip', 'paid directly on NEAR, no quote needed');
  } else {
    bar('3. 1Click quote (signature + strict validation)');
    step('quote', 'start');
    const simDeposit = process.env.SIM_DEPOSIT_ACCOUNT ?? DEFAULT_SIM_DEPOSIT_ACCOUNT;
    const exp = quoteExpectation({
      path, payout, amount, treasuryId: cfg.treasuryId, treasuryToken: config.token,
      dry: path === 'oneclick' ? !execute : true, simRefundTo: process.env.SIM_QUOTE_REFUND_TO,
    })!;
    const now = new Date();
    const q = await getQuote(oc, buildQuoteRequest(exp, now));
    const check = validateQuote(q, exp, now);
    const summary = quoteSummary(q);
    log(`quote: ${formatAmount(BigInt(summary.amount_in))} in -> ${summary.amount_out_formatted} out (min ${summary.min_amount_out}), ~${summary.time_estimate_s}s, dry=${summary.dry}`);
    log(`  recipient ${summary.recipient} | ${summary.destination_asset}`);
    log(`  signature ${check.signature_valid ? 'VALID (1Click manager key)' : 'INVALID'} | quote_hash ${check.quote_hash}`);
    for (const e of check.errors) log(`  [quote error] ${e}`);
    result.quote = {
      ...summary, quote_hash: check.quote_hash, simulated: path === 'oneclick-simulated',
      signature_valid: check.signature_valid, recipient_matches_registry: sameAddr(summary.recipient, payout.address), checks_ok: check.ok,
    };
    record({ path, quote: result.quote }, check.ok ? 'quote:ok' : 'quote:invalid', check.errors.join('; ') || undefined);
    if (!check.ok) {
      step('quote', 'error', check.errors.join('; '));
      skipRest(['propose']);
      return stop('quote-invalid', 1, 'STOP: the quote does not match what the registry says — nothing sent.');
    }
    step('quote', 'done', check.signature_valid ? 'signature valid' : undefined);
    quoteHash = check.quote_hash;
    if (path === 'oneclick-simulated') {
      depositAddress = simDeposit;
      banner(`${SIMULATED_LABEL}: tUSDC goes to ${simDeposit} (stand-in for the 1Click deposit address)`);
    } else {
      depositAddress = check.deposit_address; // null on a mainnet dry run
    }
  }
  result.deposit_address = depositAddress;

  // ------------------------------------------------------------------ 4. the proposal
  bar(`${path === 'direct' ? '3' : '4'}. treasury.propose_payment`);
  const flags = agentFlags(d);
  result.agent_flags = flags;
  const gasTgas = Number(process.env.PROPOSE_GAS_TGAS ?? DEFAULT_PROPOSE_GAS_TGAS);
  const args = buildProposeArgs({
    invoiceHash: entryHash, vendor, amount, payoutVersion: payout.version, path,
    depositAddress: depositAddress ?? (execute ? null : '<deposit address from the real quote at --execute>'),
    quoteHash, invoiceNumber: inv.invoice_number, flags, depositPlaceholder: !depositAddress,
  });
  const signer = process.env.AGENT_ID ?? config.agent;
  log(toJson({ signer, receiver: cfg.treasuryId, method: 'propose_payment', args, gas: `${gasTgas} TGas`, deposit: '0' }));
  if (flags.length) log(`agent_flags (${flags.length}): the contract will hold this payment for the owner ("agent: ..." reasons).`);
  for (const p of d.contract_predictions) log(`  [contract] ${p}`);
  record({ agent_flags: flags, deposit_address: depositAddress }, execute ? 'sending' : 'dry-run');

  if (!execute) {
    step('propose', 'skip', 'dry run');
    return stop('dry-run', 0, 'DRY RUN — nothing was signed or sent. Re-run with --execute to send exactly this.');
  }
  step('propose', 'start');

  // ------------------------------------------------------------------ 5. preflight + sign
  const { key, keyPair } = loadKey(keyPath(network, signer));
  if (key.contract_id !== cfg.treasuryId) {
    step('propose', 'error', 'agent key mismatch');
    return stop('preflight-failed', 1, `STOP: agent key was made for ${key.contract_id}, not ${cfg.treasuryId}.`);
  }
  const ak = await near.getAccessKey(cfg, signer, key.public_key);
  const keyProblem = checkKeyPermission(ak.permission, cfg.treasuryId);
  if (keyProblem) {
    step('propose', 'error', keyProblem);
    return stop('preflight-failed', 1, `STOP: ${keyProblem}`);
  }
  log(`signing as ${signer} with FUNCTION-CALL key ${key.public_key} (receiver ${cfg.treasuryId}, methods [propose_payment])`);
  const bounds = await near.viewOn<{ min: string } | null>(cfg, config.token, 'storage_balance_bounds').catch(() => null);
  const problems = preflightProblems({ config, signerId: signer, storageMin: bounds?.min ?? null });
  if (problems.length) {
    step('propose', 'error', problems.join('; '));
    return stop('preflight-failed', 1, `STOP:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }

  const outcome = await signAndSend(cfg, signer, keyPair, {
    receiverId: cfg.treasuryId, methodName: 'propose_payment', args, gas: BigInt(gasTgas) * TGAS, deposit: 0n,
  });
  result.tx_hash = outcome.tx_hash;
  result.explorer_url = explorerTxUrl(network, outcome.tx_hash);
  log(`tx ${outcome.tx_hash}\n  ${result.explorer_url}`);
  record({ tx_hash: outcome.tx_hash }, 'proposed');

  const proposed = treasuryEvents(outcome.logs).find((e) => e.event === 'payment_proposed');
  let id = proposed ? Number(proposed.data[0]?.id) : NaN;
  if (!Number.isInteger(id)) {
    if (outcome.failure) {
      record({}, 'tx-failed', outcome.failure);
      step('propose', 'error', outcome.failure);
      return stop('contract-refused', 1, `Contract refused the proposal: ${outcome.failure}`);
    }
    near.clearViewCache();
    const all = await near.getPayments(cfg);
    id = all.find((p) => p.invoice_hash === entryHash)?.id ?? NaN;
  }
  if (!Number.isInteger(id)) {
    step('propose', 'error', 'payment record not found');
    return stop('contract-refused', 1, 'Could not find the payment record on-chain.');
  }
  step('propose', 'done', `payment #${id}`);

  near.clearViewCache();
  const payment = await near.getPayment(cfg, id);
  if (!payment) return stop('contract-refused', 1, `payment #${id} not found`);
  result.payment_id = id;
  result.payment = payment;
  bar(`Result: payment #${id} is ${payment.status.toUpperCase()}`);
  log(`  amount ${formatAmount(BigInt(payment.amount))} -> ${payment.destination ?? '-'} (${payment.direct ? 'direct to vendor' : 'via deposit address'})`);
  for (const r of payment.reasons) log(`  reason: ${r}`);
  if (payment.status === 'Pending') log(`  The OWNER must approve or reject payment #${id} with their own wallet (approve_payment, 1 yoctoNEAR).`);
  if (path === 'oneclick-simulated') log(`  (${SIMULATED_LABEL})`);
  record({ payment_id: id }, payment.status, payment.reasons.join('; ') || undefined);

  // ------------------------------------------------------------------ 6. 1Click tracking (mainnet only)
  if (path === 'oneclick' && depositAddress) {
    if (payment.status === 'Paid') {
      bar('1Click: submit deposit tx + track');
      await submitDepositTx(oc, outcome.tx_hash, depositAddress, cfg.treasuryId).catch((e) => log(`  submit failed (1Click will still detect the deposit): ${(e as Error).message}`));
      const final = await pollStatus(oc, depositAddress, { onChange: (s) => { log(`  1Click status: ${s.status}`); record({}, `1click:${s.status}`); } });
      log(`  final: ${final?.status ?? 'unknown (timed out)'}`);
      for (const t of final?.swapDetails?.destinationChainTxHashes ?? []) log(`  destination tx: ${t.explorerUrl || t.hash}`);
    } else if (payment.status === 'Pending') {
      log(`  After the owner approves: npm run oneclick-status -- ${depositAddress} --tx <approve tx hash> --sender ${cfg.treasuryId}`);
      log('  (the quote deadline still applies; a late deposit is refunded by 1Click to the treasury)');
    }
  }
  Object.assign(result, { outcome: 'proposed', exitCode: 0, message: `payment #${id} is ${payment.status}` });
  return result;
}
