// npm run analyze -- <invoice.png|jpg|pdf> [--json-only]
import './env.ts';
import { analyzeInvoice, toJson } from './analyze.ts';
import { formatReport } from './report.ts';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: npm run analyze -- <invoice.png|jpg|pdf> [--json-only]');
  process.exit(2);
}

const analysis = await analyzeInvoice(file);
if (!args.includes('--json-only')) {
  console.log(formatReport(analysis));
  console.log('\n--- JSON ---');
}
console.log(toJson(analysis));
