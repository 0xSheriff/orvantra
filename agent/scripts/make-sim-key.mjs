// One-off: make the dev key whose implicit account is the testnet stand-in for the 1Click deposit address
// (DEFAULT_SIM_DEPOSIT_ACCOUNT in src/plan.ts). Stored OUTSIDE the repo at ~/.orvantra/keys/testnet/sim.json (mode 600).
// The account id is just the hex of the public key, so it can receive tUSDC once it is registered on the token.
//   node scripts/make-sim-key.mjs
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KeyPair } from '@near-js/crypto';

const path = join(process.env.ORVANTRA_KEYS_DIR ?? join(homedir(), '.orvantra', 'keys'), 'testnet', 'sim.json');
if (existsSync(path)) {
  console.error(`${path} already exists; not overwriting`);
  process.exit(1);
}
const kp = KeyPair.fromRandom('ed25519');
const publicKey = kp.getPublicKey();
const account = Buffer.from(publicKey.data).toString('hex');
mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
writeFileSync(path, `${JSON.stringify({ account_id: account, network: 'testnet', purpose: 'simulated 1Click deposit address', public_key: publicKey.toString(), private_key: kp.toString(), created_at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
chmodSync(path, 0o600);
console.log(`created ${path}\nimplicit account id: ${account}`);
