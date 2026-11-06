// npm run oneclick-status -- <depositAddress> [--tx <deposit tx hash> --sender <treasury>]
// Optionally tells 1Click about the deposit transaction, then polls /status until SUCCESS / REFUNDED / FAILED.
import '../src/env.ts';
import { oneClickConfig, pollStatus, submitDepositTx } from '../src/oneclick.ts';

const argv = process.argv.slice(2);
const deposit = argv.find((a) => !a.startsWith('--'));
const arg = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (!deposit) {
  console.error('usage: npm run oneclick-status -- <depositAddress> [--tx <hash> --sender <account>]');
  process.exit(2);
}
const oc = oneClickConfig();
const tx = arg('tx');
if (tx) console.log('submit:', (await submitDepositTx(oc, tx, deposit, arg('sender'))).status);
const s = await pollStatus(oc, deposit, { onChange: (x) => console.log(`${new Date().toISOString()} ${x.status}`) });
console.log(JSON.stringify(s, null, 2));
