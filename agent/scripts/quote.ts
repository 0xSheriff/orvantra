// npm run quote -- --recipient <addr> --dest <asset_id> --amount <base units> [--refund-to <acct>] [--save <file>]
// Gets a DRY 1Click quote (mainnet assets; dry quotes move nothing), verifies its signature and validates it.
import '../src/env.ts';
import { writeFileSync } from 'node:fs';
import { buildQuoteRequest, getQuote, MAINNET_USDC_NEAR, oneClickConfig, quoteSummary, validateQuote, type QuoteExpectation } from '../src/oneclick.ts';

const argv = process.argv.slice(2);
const arg = (name: string, def?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};

const exp: QuoteExpectation = {
  dry: true,
  originAsset: MAINNET_USDC_NEAR,
  destinationAsset: arg('dest', 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near')!,
  recipient: arg('recipient', '0x3333333333333333333333333333333333333333')!,
  amount: arg('amount', '120000000')!,
  // ORIGIN_CHAIN quotes need refundTo to be an EXISTING mainnet account (else 1Click answers HTTP 400).
  refundTo: arg('refund-to', process.env.SIM_QUOTE_REFUND_TO ?? 'intents.near')!,
};
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
