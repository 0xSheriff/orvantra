// npm run pay -- <invoice.png|jpg|pdf> [--execute]
//
// CLI for the Day 5 pipeline (src/payflow.ts): analyze -> path -> 1Click quote -> treasury.propose_payment.
// Default is a DRY RUN: it prints exactly what would be sent and sends nothing.
// The contract makes every decision; the agent never approves anything.
import './env.ts';
import { payInvoice } from './payflow.ts';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const execute = argv.includes('--execute');
if (!file) {
  console.error('usage: npm run pay -- <invoice.png|jpg|pdf> [--execute]');
  process.exit(2);
}

const result = await payInvoice(file, { execute }, { log: (line) => console.log(line) });
process.exit(result.exitCode);
