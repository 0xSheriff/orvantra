// Orvantra's NEP-366 relayer: wraps a vendor's SignedDelegate in a transaction signed and paid by the relayer
// account. The policy (lib/relay.ts) is checked first; this file only does key loading and RPC. Keys are never logged.
import 'server-only';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Account } from '@near-js/accounts';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { actionCreators } from '@near-js/transactions';
import type { SignedDelegate } from '@near-js/transactions';
import { RateLimiter, checkSignedDelegate, decodeSignedDelegate, outcomeFailure } from '../relay';
import { near, serverConfig } from './config';

export const DEFAULT_RELAYER = 'orvantra-relayer.testnet';
const limiter = new RateLimiter(5, 60 * 60_000);

export interface RelayResult {
  ok: boolean;
  status: number;
  reason?: string;
  txHash?: string;
}

function relayerId(): string {
  return process.env.RELAYER_ID || DEFAULT_RELAYER;
}

/** Legacy near-cli keychain JSON: { account_id, public_key, private_key }. */
function loadSigner(network: string): KeyPairSigner {
  const id = relayerId();
  const path = process.env.RELAYER_KEY_PATH || resolve(homedir(), '.near-credentials', network, `${id}.json`);
  let key: string;
  try {
    const json = JSON.parse(readFileSync(/*turbopackIgnore: true*/ path, 'utf8')) as { private_key?: string; secret_key?: string };
    key = json.private_key ?? json.secret_key ?? '';
  } catch {
    throw new Error(`relayer key file not readable (${path})`);
  }
  if (!/^ed25519:/.test(key)) throw new Error(`relayer key file has no ed25519 private_key (${path})`);
  return KeyPairSigner.fromSecretKey(key as `ed25519:${string}`);
}

function provider(): JsonRpcProvider {
  return new JsonRpcProvider({ url: near().rpcUrls[0] });
}

export async function relay(signedDelegateB64: unknown): Promise<RelayResult> {
  const cfg = serverConfig();
  if (cfg.network === 'mainnet' && process.env.ORVANTRA_ALLOW_MAINNET_RELAY !== '1') {
    return { ok: false, status: 403, reason: 'The relayer is disabled on mainnet.' };
  }
  if (typeof signedDelegateB64 !== 'string') return { ok: false, status: 400, reason: 'Missing signedDelegate.' };

  let sd: SignedDelegate;
  try {
    sd = decodeSignedDelegate(signedDelegateB64);
  } catch {
    return { ok: false, status: 400, reason: 'This is not a signed delegate action.' };
  }

  const rpc = provider();
  let height: bigint;
  try {
    const block = await rpc.viewBlock({ finality: 'final' });
    height = BigInt(block.header.height);
  } catch (e) {
    return { ok: false, status: 502, reason: `NEAR could not be reached: ${e instanceof Error ? e.message : String(e)}` };
  }

  const check = checkSignedDelegate(sd, { registryId: cfg.registryId, currentHeight: height });
  if (!check.ok) return { ok: false, status: 400, reason: check.reason };
  if (!limiter.take(check.senderId!, Date.now())) {
    return { ok: false, status: 429, reason: 'Too many changes from this account in the last hour. Try again later.' };
  }

  let signer: KeyPairSigner;
  try {
    signer = loadSigner(cfg.network);
  } catch (e) {
    console.error(`[relay] ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, status: 503, reason: 'The relayer is not configured on this server.' };
  }

  const account = new Account(relayerId(), rpc, signer);
  try {
    const outcome = await account.signAndSendTransaction({
      receiverId: sd.delegateAction.senderId,
      actions: [actionCreators.signedDelegate({ delegateAction: sd.delegateAction, signature: sd.signature })],
      waitUntil: 'FINAL',
      throwOnFailure: false,
    });
    const txHash = outcome.transaction?.hash as string | undefined;
    const failure = outcomeFailure(outcome);
    console.log(`[relay] ${check.method} for ${check.senderId}: ${failure ? 'failed' : 'ok'} ${txHash ?? ''}`);
    return failure ? { ok: false, status: 200, txHash, reason: failure } : { ok: true, status: 200, txHash };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[relay] send failed for ${check.senderId}: ${msg.slice(0, 300)}`);
    return { ok: false, status: 502, reason: `The network refused the transaction: ${msg.slice(0, 200)}` };
  }
}
