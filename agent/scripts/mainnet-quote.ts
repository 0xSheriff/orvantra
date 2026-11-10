// npm run mainnet-quote -- --recipient <0x...> [--amount 1000000] [--refund-to orvantra.near] [--save <file>]
//
// Gets a REAL (dry=false) 1Click quote: USDC on NEAR -> USDC on Base, for the one-off mainnet demo payment.
// The quote alone moves nothing. It reserves a NEAR deposit address; the OWNER then sends exactly `amount`
// USDC from their own NEAR wallet to that address, and 1Click delivers USDC to the recipient on Base.
import '../src/env.ts';
import { writeFileSync } from 'node:fs';
import {
  buildQuoteRequest, getQuote, MAINNET_USDC_NEAR, oneClickConfig, quoteSummary, validateQuote,
  type QuoteExpectation,
} from '../src/oneclick.ts';

const argv = process.argv.slice(2);
const arg = (name: string, def?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};

const exp: QuoteExpectation = {
  dry: false,
  originAsset: arg('origin', MAINNET_USDC_NEAR)!,
  destinationAsset: arg('dest', 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near')!,
  recipient: arg('recipient')!,
  amount: arg('amount', '1000000')!,
  // Refunds land back on NEAR with the owner's account.
  refundTo: arg('refund-to', 'orvantra.near')!,
};
if (!exp.recipient || !/^0x[0-9a-fA-F]{40}$/.test(exp.recipient)) {
  console.error('usage: --recipient <0x + 40 hex> is required');
  process.exit(2);
}

const now = new Date();
const q = await getQuote(oneClickConfig(), buildQuoteRequest(exp, now));
const check = validateQuote(q, exp, now);
console.log(JSON.stringify({ summary: quoteSummary(q), check }, null, 2));
const save = arg('save');
if (save) {
  writeFileSync(save, `${JSON.stringify(q, null, 2)}\n`);
  console.log(`saved -> ${save}`);
}
process.exit(check.ok ? 0 : 1);
