// Testnet end-to-end check of the gasless relay (/api/relay), with the dev server running.
//   node scripts/relay-selftest.ts [baseUrl]          (default http://localhost:3000)
//
// Signs a NEP-366 delegate action as orvantra-bob.testnet (legacy keychain file
// ~/.near-credentials/testnet/orvantra-bob.testnet.json, override with BOB_KEY_PATH) calling
// registry.set_vendor with bob's CURRENT values from get_vendor, so the entry does not change (an identical payout
// does not bump the version), with the required 1 yoctoNEAR attached. Posts it to /api/relay; the relayer account
// pays the gas fee. Prints the tx hash.
// Testnet only. Never prints keys.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Account } from '@near-js/accounts';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { actionCreators, encodeSignedDelegate } from '@near-js/transactions';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const NETWORK = process.env.NEAR_NETWORK ?? 'testnet';
const REGISTRY = process.env.REGISTRY_ID ?? 'orvantra-registry.testnet';
const BOB = process.env.BOB_ID ?? 'orvantra-bob.testnet';
const RPC = process.env.NEAR_RPC_URL ?? 'https://rpc.testnet.near.org';

if (NETWORK !== 'testnet') throw new Error('relay-selftest runs on testnet only');

interface VendorView { display_name: string; payout: { chain: string; asset_id: string; address: string }; version: number; updated_at_ns: string }

const keyPath = process.env.BOB_KEY_PATH ?? resolve(homedir(), '.near-credentials', 'testnet', `${BOB}.json`);
const { private_key } = JSON.parse(readFileSync(keyPath, 'utf8')) as { private_key: string };
const provider = new JsonRpcProvider({ url: RPC });
const bob = new Account(BOB, provider, KeyPairSigner.fromSecretKey(private_key as `ed25519:${string}`));

const getVendor = async (): Promise<VendorView | null> =>
  (await provider.callFunction(REGISTRY, 'get_vendor', { account_id: BOB })) as VendorView | null;

const before = await getVendor();
if (!before) throw new Error(`${BOB} has no registry entry; register it first`);
console.log(`before: ${BOB} v${before.version} ${before.payout.chain} ${before.payout.asset_id} ${before.payout.address}`);

const balanceBefore = await bob.getBalance();
const signedDelegate = await bob.signedDelegate({
  receiverId: REGISTRY,
  blockHeightTtl: 120,
  actions: [actionCreators.functionCall('set_vendor', {
    display_name: before.display_name,
    chain: before.payout.chain,
    asset_id: before.payout.asset_id,
    address: before.payout.address,
  // The registry requires exactly 1 yoctoNEAR; inside a meta transaction it comes from bob's balance.
  }, 30_000_000_000_000n, 1n)],
});
const b64 = Buffer.from(encodeSignedDelegate(signedDelegate)).toString('base64');

const res = await fetch(`${BASE}/api/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signedDelegate: b64 }) });
const body = (await res.json()) as { ok: boolean; txHash: string | null; reason: string | null };
console.log(`relay: HTTP ${res.status} ok=${body.ok} tx=${body.txHash ?? '-'}${body.reason ? ` reason=${body.reason}` : ''}`);
if (body.txHash) console.log(`explorer: https://testnet.nearblocks.io/txns/${body.txHash}`);

const after = await getVendor();
const balanceAfter = await bob.getBalance();
console.log(`after:  ${BOB} v${after?.version} ${after?.payout.chain} ${after?.payout.asset_id} ${after?.payout.address}`);
// Bob pays only the 1 yoctoNEAR deposit; the relayer pays the gas.
const spent = BigInt(balanceBefore) - BigInt(balanceAfter);
console.log(`bob paid gas: ${spent === 1n ? 'no (only the 1 yoctoNEAR deposit)' : `yes? balance ${balanceBefore} -> ${balanceAfter} (spent ${spent} yocto)`}`);
process.exit(body.ok ? 0 : 1);
