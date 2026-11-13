// Register a vendor in the registry from this host (TESTNET ONLY, read the flags before running).
//   npm run register-vendor -- --account orvantra-tidewater.testnet --name "Tidewater Print Co" [--create]
// --create first asks the testnet faucet for the account (a fresh ed25519 key, saved to the legacy keychain
// ~/.near-credentials/<network>/<account>.json with mode 600). Without it the key must already be there.
// Payout = tUSDC on NEAR to the account itself. No treasury policy is set: that is the owner's job (web /rules),
// so a vendor registered here is "registered but not approved" until the owner approves it.
import '../src/env.ts';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KeyPair, type KeyPairString } from '@near-js/crypto';
import * as near from '../src/near.ts';
import { isValidNearAccount } from '../src/normalize.ts';
import { signAndSend, TGAS } from '../src/tx.ts';

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const account = opt('account');
const name = opt('name');
if (!account || !name || !isValidNearAccount(account)) { console.error('usage: --account <id> --name <display name> [--create]'); process.exit(2); }
const cfg = near.nearConfig();
if (cfg.network !== 'testnet') { console.error('testnet only'); process.exit(2); }
const keyFile = join(homedir(), '.near-credentials', cfg.network, `${account}.json`);

const exists = () => near.rpc(cfg, 'query', { request_type: 'view_account', finality: 'final', account_id: account }).then(() => true, () => false);

let keyPair: KeyPair;
if (argv.includes('--create')) {
  if (existsSync(keyFile) || (await exists())) { console.error(`${account} or its key already exists`); process.exit(2); }
  keyPair = KeyPair.fromRandom('ed25519');
  mkdirSync(join(homedir(), '.near-credentials', cfg.network), { recursive: true, mode: 0o700 });
  writeFileSync(keyFile, `${JSON.stringify({ account_id: account, public_key: keyPair.getPublicKey().toString(), private_key: keyPair.toString() }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  const res = await fetch('https://helper.nearprotocol.com/account', {
    method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'orvantra-agent/0.1' },
    body: JSON.stringify({ newAccountId: account, newAccountPublicKey: keyPair.getPublicKey().toString() }),
  });
  if (!res.ok) { console.error(`faucet HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`); process.exit(1); }
  for (let i = 0; i < 20 && !(await exists()); i++) await new Promise((r) => setTimeout(r, 3000));
  if (!(await exists())) { console.error('account not visible yet; re-run without --create later'); process.exit(1); }
  console.error(`created ${account} (key: ${keyFile})`);
} else {
  const k = JSON.parse(readFileSync(keyFile, 'utf8')) as { private_key: string };
  keyPair = KeyPair.fromString(k.private_key as KeyPairString);
}

const payout = { chain: 'near', asset_id: `nep141:${(await near.getConfig(cfg)).token}`, address: account };
const est = BigInt(await near.view<string>(cfg, cfg.registryId, 'storage_cost_estimate', { display_name_len: name.length, address_len: account.length, asset_len: payout.asset_id.length }));
const out = await signAndSend(cfg, account, keyPair, {
  receiverId: cfg.registryId, methodName: 'set_vendor', args: { display_name: name, ...payout }, gas: 30n * TGAS, deposit: est + est / 5n,
});
console.log(JSON.stringify({ tx_hash: out.tx_hash, failure: out.failure, vendor: await near.getVendor(cfg, account), policy: await near.getVendorPolicy(cfg, account) }, null, 2));
process.exit(out.failure ? 1 : 0);
