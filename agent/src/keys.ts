// The agent's restricted signing key. Generated locally, stored OUTSIDE the repo with mode 600, and meant to be added
// on-chain as a FUNCTION-CALL access key: receiver = the treasury, methods = [propose_payment], small allowance.
// With such a key the agent can't transfer NEAR, call the token, withdraw, approve, or change policy.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { KeyPair, type KeyPairString } from '@near-js/crypto';
import type { AccessKeyPermission } from './near.ts';
import { isValidNearAccount } from './normalize.ts';

export const AGENT_METHODS = ['propose_payment'] as const;
export const DEFAULT_ALLOWANCE_NEAR = '0.25';

export interface StoredKey {
  account_id: string;
  network: string;
  /** The only contract this key is meant for. */
  contract_id: string;
  methods: string[];
  public_key: string;
  /** ed25519:<base58 64-byte secret>. Never printed. */
  private_key: string;
  created_at: string;
}

/** Keys live in ~/.orvantra/keys/<network>/<account>.json (override the root with ORVANTRA_KEYS_DIR). */
export function keyPath(network: string, account: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!/^[a-z0-9-]+$/.test(network)) throw new Error(`bad network "${network}"`);
  if (!isValidNearAccount(account)) throw new Error(`"${account}" is not a valid NEAR account id`);
  const root = env.ORVANTRA_KEYS_DIR ?? join(homedir(), '.orvantra', 'keys');
  return join(root, network, `${account}.json`);
}

export function generateAgentKey(account: string, contract: string, network: string, now = new Date()): StoredKey {
  if (!isValidNearAccount(contract)) throw new Error(`"${contract}" is not a valid NEAR account id`);
  const kp = KeyPair.fromRandom('ed25519');
  return {
    account_id: account,
    network,
    contract_id: contract,
    methods: [...AGENT_METHODS],
    public_key: kp.getPublicKey().toString(),
    private_key: kp.toString(),
    created_at: now.toISOString(),
  };
}

/** Writes the key with mode 600 (dir 700). Refuses to overwrite an existing key unless `force`. */
export function saveKey(path: string, key: StoredKey, force = false): void {
  if (existsSync(path) && !force) throw new Error(`${path} already exists (use --force to replace it)`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(key, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600); // mode is ignored when the file already existed
}

export function loadKey(path: string): { key: StoredKey; keyPair: KeyPair } {
  if (!existsSync(path)) throw new Error(`no agent key at ${path} — run: npm run setup-agent-key -- --account <agent> --contract <treasury>`);
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`${path} is readable by other users (mode ${mode.toString(8)}); run chmod 600 ${path}`);
  const key = JSON.parse(readFileSync(path, 'utf8')) as StoredKey;
  const keyPair = KeyPair.fromString(key.private_key as KeyPairString);
  if (keyPair.getPublicKey().toString() !== key.public_key) throw new Error(`${path}: public_key does not match private_key`);
  return { key, keyPair };
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The near-cli-rs command (run by the account owner) that adds `publicKey` as a function-call key. */
export function addKeyCommand(o: { account: string; contract: string; publicKey: string; network: string; allowanceNear?: string; methods?: readonly string[] }): string {
  const methods = (o.methods ?? AGENT_METHODS).join(', ');
  return [
    `near account add-key ${o.account}`,
    `grant-function-call-access --allowance ${shellQuote(`${o.allowanceNear ?? DEFAULT_ALLOWANCE_NEAR} NEAR`)}`,
    `--contract-account-id ${o.contract} --function-names ${shellQuote(methods)}`,
    `use-manually-provided-public-key ${o.publicKey}`,
    `network-config ${o.network} sign-with-legacy-keychain send`,
  ].join(' \\\n  ');
}

/**
 * The agent refuses to sign with a key that is not exactly what we expect on-chain: a function-call key for
 * `contract` allowing only `propose_payment`. (A full-access key would work technically — that is the point.)
 */
export function checkKeyPermission(p: AccessKeyPermission, contract: string): string | null {
  if (p === 'FullAccess') return 'the agent key is a FULL-ACCESS key on-chain; delete it and add a function-call key (npm run setup-agent-key)';
  const fc = p.FunctionCall;
  if (fc.receiver_id !== contract) return `the agent key is for ${fc.receiver_id}, not ${contract}`;
  const m = [...fc.method_names].sort();
  if (m.length !== AGENT_METHODS.length || m.some((x, i) => x !== AGENT_METHODS[i])) {
    return `the agent key allows methods [${fc.method_names.join(', ') || 'ANY'}]; expected exactly [${AGENT_METHODS.join(', ')}]`;
  }
  return null;
}
