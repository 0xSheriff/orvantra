// npm run pay -- <invoice.png|jpg|pdf> [--execute]
//
// analyze (Day 4: two NEAR AI readers + checks) -> reject => stop
//   -> path: direct (vendor wants our token on NEAR) | 1Click (mainnet) | SIMULATED 1Click (testnet)
//   -> 1Click quote: signature verified + strict validation against the REGISTRY payout
//   -> treasury.propose_payment signed with the agent's FUNCTION-CALL key (propose_payment only)
//   -> read back the on-chain payment (Paid / Pending / Rejected) + explorer link
//   -> mainnet cross-chain + Paid: submit the deposit tx to 1Click and poll until terminal.
// Default is a DRY RUN: it prints exactly what would be sent and sends nothing.
// The contract makes every decision; the agent never approves anything.
import './env.ts';
import { analyzeInvoice, toJson } from './analyze.ts';
import { checkKeyPermission, keyPath, loadKey } from './keys.ts';
import { alreadyProposed, defaultLedgerPath, readLedger, upsert, writeLedger, type Ledger, type LedgerEntry } from './ledger.ts';
import * as near from './near.ts';
import { formatAmount } from './normalize.ts';
import {
  buildQuoteRequest, getQuote, oneClickConfig, pollStatus, quoteSummary, submitDepositTx, validateQuote,
} from './oneclick.ts';
import {
  agentFlags, buildProposeArgs, DEFAULT_PROPOSE_GAS_TGAS, DEFAULT_SIM_DEPOSIT_ACCOUNT, preflightProblems, quoteExpectation,
  selectPath, SIMULATED_LABEL,
} from './plan.ts';
import { formatReport } from './report.ts';
import { explorerTxUrl, signAndSend, TGAS, treasuryEvents } from './tx.ts';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const execute = argv.includes('--execute');
if (!file) {
  console.error('usage: npm run pay -- <invoice.png|jpg|pdf> [--execute]');
  process.exit(2);
}

const cfg = near.nearConfig();
const oc = oneClickConfig();
const network = cfg.network;
const ledgerPath = defaultLedgerPath();
let ledger: Ledger = readLedger(ledgerPath);
const fileName = file.split('/').pop() ?? file;
let entryHash: string | null = null;

const bar = (s: string) => console.log(`\n=== ${s} ${'='.repeat(Math.max(0, 74 - s.length))}`);
const banner = (s: string) => console.log(`\n${'!'.repeat(78)}\n!! ${s}\n${'!'.repeat(78)}`);
function record(patch: Partial<LedgerEntry>, status: string, detail?: string) {
  if (!entryHash) return;
  ledger = upsert(ledger, entryHash, { file: fileName, network, treasury: cfg.treasuryId, ...patch }, { status, ...(detail ? { detail } : {}) });
  writeLedger(ledgerPath, ledger);
}
function stop(code: number, msg: string): never {
  console.log(`\n${msg}`);
  process.exit(code);
}

console.log(`Orvantra pay — ${execute ? 'EXECUTE (will sign and send)' : 'DRY RUN (nothing is sent)'}`);
console.log(`network ${network}, treasury ${cfg.treasuryId}, registry ${cfg.registryId}, ledger ${ledgerPath}`);

// ------------------------------------------------------------------ 1. analyze (Day 4)
bar('1. Read + check the invoice (NEAR AI Cloud, TEE)');
const analysis = await analyzeInvoice(file);
console.log(formatReport(analysis));
const d = analysis.decision;
const inv = analysis.comparison.agreed;
const config = analysis.chain.config;
entryHash = d.invoice_hash;
if (!entryHash) stop(1, 'STOP: no invoice_hash (vendor account / number / amount unreadable) — nothing sent.');
record({ vendor: inv?.vendor_account ?? null, amount: d.amount_base_units, invoice_number: inv?.invoice_number ?? null, decision: d.action }, `analyzed:${d.action}`);

if (d.action === 'reject') {
  stop(0, `REJECTED by the agent — nothing sent.\n${d.reasons.map((r) => `  - ${r}`).join('\n')}`);
}
if (analysis.chain.error || !config || !d.payout || !inv?.vendor_account || !d.amount_base_units) {
  stop(1, `STOP: cannot build a proposal (${analysis.chain.error ?? 'missing registry payout / treasury config / amount'}) — nothing sent.`);
}
const prev = alreadyProposed(ledger, entryHash, network, cfg.treasuryId);
if (prev) stop(0, `Already proposed: payment #${prev.payment_id ?? '?'} tx ${prev.tx_hash} (${explorerTxUrl(network, prev.tx_hash!)}) — not sending again.`);

const vendor = inv.vendor_account;
const amount = d.amount_base_units;
const payout = d.payout;

// ------------------------------------------------------------------ 2. path
bar('2. Payment path');
const path = selectPath(network, payout, config.token);
console.log(`registry payout: ${payout.address} on ${payout.chain} (${payout.asset_id}), version ${payout.version}`);
console.log(
  path === 'direct'
    ? `path: DIRECT — vendor wants nep141:${config.token} on NEAR; the treasury pays ${payout.address} itself. No quote needed.`
    : path === 'oneclick'
      ? 'path: 1CLICK (mainnet) — real quote; the treasury pays the quote\'s deposit address.'
      : `path: 1CLICK SIMULATED (testnet) — dry MAINNET quote to verify price + signature; deposit goes to a testnet stand-in.`,
);

// ------------------------------------------------------------------ 3. quote
let depositAddress: string | null = null;
let quoteHash: string | null = null;
if (path !== 'direct') {
  bar('3. 1Click quote (signature + strict validation)');
  const simDeposit = process.env.SIM_DEPOSIT_ACCOUNT ?? DEFAULT_SIM_DEPOSIT_ACCOUNT;
  const exp = quoteExpectation({
    path, payout, amount, treasuryId: cfg.treasuryId, treasuryToken: config.token,
    dry: path === 'oneclick' ? !execute : true, simRefundTo: process.env.SIM_QUOTE_REFUND_TO,
  })!;
  const now = new Date();
  const q = await getQuote(oc, buildQuoteRequest(exp, now));
  const check = validateQuote(q, exp, now);
  const summary = quoteSummary(q);
  console.log(`quote: ${formatAmount(BigInt(summary.amount_in))} in -> ${summary.amount_out_formatted} out (min ${summary.min_amount_out}), ~${summary.time_estimate_s}s, dry=${summary.dry}`);
  console.log(`  recipient ${summary.recipient} | ${summary.destination_asset}`);
  console.log(`  signature ${check.signature_valid ? 'VALID (1Click manager key)' : 'INVALID'} | quote_hash ${check.quote_hash}`);
  for (const e of check.errors) console.log(`  [quote error] ${e}`);
  record({ path, quote: { ...summary, quote_hash: check.quote_hash, simulated: path === 'oneclick-simulated' } }, check.ok ? 'quote:ok' : 'quote:invalid', check.errors.join('; ') || undefined);
  if (!check.ok) stop(1, 'STOP: the quote does not match what the registry says — nothing sent.');
  quoteHash = check.quote_hash;
  if (path === 'oneclick-simulated') {
    depositAddress = simDeposit;
    banner(`${SIMULATED_LABEL}: tUSDC goes to ${simDeposit} (stand-in for the 1Click deposit address)`);
  } else {
    depositAddress = check.deposit_address; // null on a mainnet dry run
  }
}

// ------------------------------------------------------------------ 4. the proposal
bar(`${path === 'direct' ? '3' : '4'}. treasury.propose_payment`);
const flags = agentFlags(d);
const gasTgas = Number(process.env.PROPOSE_GAS_TGAS ?? DEFAULT_PROPOSE_GAS_TGAS);
const args = buildProposeArgs({
  invoiceHash: entryHash, vendor, amount, payoutVersion: payout.version, path,
  depositAddress: depositAddress ?? (execute ? null : '<deposit address from the real quote at --execute>'),
  quoteHash, invoiceNumber: inv.invoice_number, flags,
});
const signer = process.env.AGENT_ID ?? config.agent;
console.log(toJson({ signer, receiver: cfg.treasuryId, method: 'propose_payment', args, gas: `${gasTgas} TGas`, deposit: '0' }));
if (flags.length) console.log(`agent_flags (${flags.length}): the contract will hold this payment for the owner ("agent: ..." reasons).`);
for (const p of d.contract_predictions) console.log(`  [contract] ${p}`);
record({ agent_flags: flags, deposit_address: depositAddress }, execute ? 'sending' : 'dry-run');

if (!execute) stop(0, 'DRY RUN — nothing was signed or sent. Re-run with --execute to send exactly this.');

// ------------------------------------------------------------------ 5. preflight + sign
const { key, keyPair } = loadKey(keyPath(network, signer));
if (key.contract_id !== cfg.treasuryId) stop(1, `STOP: agent key was made for ${key.contract_id}, not ${cfg.treasuryId}.`);
const ak = await near.getAccessKey(cfg, signer, key.public_key);
const keyProblem = checkKeyPermission(ak.permission, cfg.treasuryId);
if (keyProblem) stop(1, `STOP: ${keyProblem}`);
console.log(`signing as ${signer} with FUNCTION-CALL key ${key.public_key} (receiver ${cfg.treasuryId}, methods [propose_payment])`);
const bounds = await near.viewOn<{ min: string } | null>(cfg, config.token, 'storage_balance_bounds').catch(() => null);
const problems = preflightProblems({ config, signerId: signer, storageMin: bounds?.min ?? null });
if (problems.length) stop(1, `STOP:\n${problems.map((p) => `  - ${p}`).join('\n')}`);

const outcome = await signAndSend(cfg, signer, keyPair, {
  receiverId: cfg.treasuryId, methodName: 'propose_payment', args, gas: BigInt(gasTgas) * TGAS, deposit: 0n,
});
console.log(`tx ${outcome.tx_hash}\n  ${explorerTxUrl(network, outcome.tx_hash)}`);
record({ tx_hash: outcome.tx_hash }, 'proposed');

const proposed = treasuryEvents(outcome.logs).find((e) => e.event === 'payment_proposed');
let id = proposed ? Number(proposed.data[0]?.id) : NaN;
if (!Number.isInteger(id)) {
  if (outcome.failure) {
    record({}, 'tx-failed', outcome.failure);
    stop(1, `Contract refused the proposal: ${outcome.failure}`);
  }
  near.clearViewCache();
  const all = await near.getPayments(cfg);
  id = all.find((p) => p.invoice_hash === entryHash)?.id ?? NaN;
}
if (!Number.isInteger(id)) stop(1, 'Could not find the payment record on-chain.');

near.clearViewCache();
const payment = await near.getPayment(cfg, id);
if (!payment) stop(1, `payment #${id} not found`);
bar(`Result: payment #${id} is ${payment.status.toUpperCase()}`);
console.log(`  amount ${formatAmount(BigInt(payment.amount))} -> ${payment.destination ?? '-'} (${payment.direct ? 'direct to vendor' : 'via deposit address'})`);
for (const r of payment.reasons) console.log(`  reason: ${r}`);
if (payment.status === 'Pending') console.log(`  The OWNER must approve or reject payment #${id} with their own wallet (approve_payment, 1 yoctoNEAR).`);
if (path === 'oneclick-simulated') console.log(`  (${SIMULATED_LABEL})`);
record({ payment_id: id }, payment.status, payment.reasons.join('; ') || undefined);

// ------------------------------------------------------------------ 6. 1Click tracking (mainnet only)
if (path === 'oneclick' && depositAddress) {
  if (payment.status === 'Paid') {
    bar('1Click: submit deposit tx + track');
    await submitDepositTx(oc, outcome.tx_hash, depositAddress, cfg.treasuryId).catch((e) => console.log(`  submit failed (1Click will still detect the deposit): ${(e as Error).message}`));
    const final = await pollStatus(oc, depositAddress, { onChange: (s) => { console.log(`  1Click status: ${s.status}`); record({}, `1click:${s.status}`); } });
    console.log(`  final: ${final?.status ?? 'unknown (timed out)'}`);
    for (const t of final?.swapDetails?.destinationChainTxHashes ?? []) console.log(`  destination tx: ${t.explorerUrl || t.hash}`);
  } else if (payment.status === 'Pending') {
    console.log(`  After the owner approves: npm run oneclick-status -- ${depositAddress} --tx <approve tx hash> --sender ${cfg.treasuryId}`);
    console.log('  (the quote deadline still applies; a late deposit is refunded by 1Click to the treasury)');
  }
}
