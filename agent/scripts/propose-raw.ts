// Send ONE treasury.propose_payment with the agent's restricted function-call key, no invoice involved.
// Used by scripts/testnet-roundB.sh to show the contract refusing proposals (caps, pause) on testnet.
//   npm run propose-raw -- --vendor orvantra-bob.testnet --amount 10000000 --memo RB-01 [--payout-version 2]
// The invoice_hash is sha256(memo) unless --hash is given. Prints one JSON line {tx_hash, explorer_url, failure}
// and exits 1 when the contract (or the network) refused the transaction, 0 when a payment was created.
import '../src/env.ts';
import { createHash } from 'node:crypto';
import { keyPath, loadKey } from '../src/keys.ts';
import * as near from '../src/near.ts';
import { explorerTxUrl, signAndSend, TGAS } from '../src/tx.ts';

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const vendor = opt('vendor');
const amount = opt('amount');
const memo = opt('memo');
if (!vendor || !amount || !memo) {
  console.error('usage: npm run propose-raw -- --vendor <account> --amount <base units> --memo <text> [--hash <64 hex>] [--payout-version <n>]');
  process.exit(2);
}
const hash = opt('hash') ?? createHash('sha256').update(memo).digest('hex');
const payoutVersion = Number(opt('payout-version') ?? '2');

const cfg = near.nearConfig();
const signer = process.env.AGENT_ID ?? 'orvantra-agent.testnet';
const { key, keyPair } = loadKey(keyPath(cfg.network, signer));
if (key.contract_id !== cfg.treasuryId) {
  console.error(`agent key was made for ${key.contract_id}, not ${cfg.treasuryId}`);
  process.exit(2);
}
const args = { invoice_hash: hash, vendor, amount, payout_version: payoutVersion, deposit_address: null, quote_hash: null, memo, agent_flags: [] };
console.error(`propose_payment as ${signer} (function-call key ${key.public_key}) -> ${cfg.treasuryId}: ${JSON.stringify(args)}`);
try {
  const out = await signAndSend(cfg, signer, keyPair, {
    receiverId: cfg.treasuryId, methodName: 'propose_payment', args, gas: 150n * TGAS, deposit: 0n,
  });
  console.log(JSON.stringify({ tx_hash: out.tx_hash, explorer_url: explorerTxUrl(cfg.network, out.tx_hash), failure: out.failure, logs: out.logs }));
  process.exit(out.failure ? 1 : 0);
} catch (err) {
  console.log(JSON.stringify({ tx_hash: null, explorer_url: null, failure: err instanceof Error ? err.message : String(err), logs: [] }));
  process.exit(1);
}
