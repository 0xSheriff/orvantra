// Orvantra's NEP-366 relayer: wraps a vendor's SignedDelegate in a transaction signed and paid by the relayer
// account. The policy (lib/relay.ts) is checked first; this file only does key loading and RPC. Keys are never logged.
//
// Order: client-IP limit -> decode -> policy (lib/relay.ts) -> the signing key is a FULL-ACCESS key of the sender
// on-chain with a lower nonce (so a made-up sender or an old/leaked signature is refused before it costs anything)
// -> sender limit -> global limit -> relayer balance >= 1 NEAR -> send.
import 'server-only';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Account } from '@near-js/accounts';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { actionCreators } from '@near-js/transactions';
import type { SignedDelegate } from '@near-js/transactions';
import {
  MIN_RELAYER_BALANCE, RateLimiter, checkAccessKey, checkSignedDelegate, decodeSignedDelegate, delegateKeyString, maxSetVendorDeposit,
  outcomeFailure, type AccessKeyInfo,
} from '../relay';
import { near, serverConfig } from './config';
import { storageEstimates } from './vendor';

export const DEFAULT_RELAYER = 'orvantra-relayer.testnet';
const HOUR = 60 * 60_000;
export const limits = {
  sender: new RateLimiter(5, HOUR),
  ip: new RateLimiter(10, HOUR),
  global: new RateLimiter(60, HOUR),
};
const BALANCE_TTL_MS = 60_000;
let balanceCache: { at: number; yocto: bigint } | null = null;

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

const logErr = (what: string, e: unknown) => console.error(`[relay] ${what}: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);

/** null = the account or the key does not exist; throws on any other (network) failure. */
async function viewKey(rpc: JsonRpcProvider, accountId: string, publicKey: string): Promise<AccessKeyInfo | null> {
  try {
    const k = await rpc.viewAccessKey(accountId, publicKey, { finality: 'final' });
    return { nonce: k.nonce, permission: k.permission };
  } catch (e) {
    if (/does not exist|unknown.?(access.?key|account)|AccountDoesNotExist|UnknownAccessKey/i.test(`${(e as Error)?.name} ${(e as Error)?.message} ${(e as { type?: string })?.type}`)) return null;
    throw e;
  }
}

async function relayerBalance(rpc: JsonRpcProvider, now: number): Promise<bigint> {
  if (balanceCache && now - balanceCache.at < BALANCE_TTL_MS) return balanceCache.yocto;
  const acc = await rpc.viewAccount(relayerId(), { finality: 'final' });
  balanceCache = { at: now, yocto: BigInt(acc.amount) };
  return balanceCache.yocto;
}

export async function relay(signedDelegateB64: unknown, ip = 'unknown', now = Date.now()): Promise<RelayResult> {
  const cfg = serverConfig();
  if (cfg.network === 'mainnet' && process.env.ORVANTRA_ALLOW_MAINNET_RELAY !== '1') {
    return { ok: false, status: 403, reason: 'The relayer is disabled on mainnet.' };
  }
  if (!limits.ip.take(ip, now)) return { ok: false, status: 429, reason: 'Too many requests from your network in the last hour. Try again later.' };
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
    logErr('viewBlock failed', e);
    return { ok: false, status: 502, reason: 'NEAR could not be reached. Try again in a minute.' };
  }

  const est = await storageEstimates(now);
  const check = checkSignedDelegate(sd, { registryId: cfg.registryId, currentHeight: height, maxSetVendorDeposit: maxSetVendorDeposit(est.max) });
  if (!check.ok) return { ok: false, status: 400, reason: check.reason };

  let keyCheck;
  try {
    keyCheck = checkAccessKey(sd, await viewKey(rpc, sd.delegateAction.senderId, delegateKeyString(sd)));
  } catch (e) {
    logErr('view_access_key failed', e);
    return { ok: false, status: 502, reason: 'NEAR could not be reached. Try again in a minute.' };
  }
  if (!keyCheck.ok) return { ok: false, status: 400, reason: keyCheck.reason };

  if (!limits.sender.take(check.senderId!, now)) {
    return { ok: false, status: 429, reason: 'Too many changes from this account in the last hour. Try again later.' };
  }
  if (!limits.global.take('all', now)) {
    return { ok: false, status: 429, reason: 'Orvantra has paid for many changes this hour. Try again later, or pay the small fee yourself.' };
  }

  try {
    if ((await relayerBalance(rpc, now)) < MIN_RELAYER_BALANCE) {
      console.error(`[relay] relayer ${relayerId()} balance is below 1 NEAR: refusing`);
      return { ok: false, status: 503, reason: 'Orvantra has run out of fee money for gasless saves right now. Pay the small network fee yourself instead.' };
    }
  } catch (e) {
    logErr('relayer balance failed', e);
    return { ok: false, status: 502, reason: 'NEAR could not be reached. Try again in a minute.' };
  }

  let signer: KeyPairSigner;
  try {
    signer = loadSigner(cfg.network);
  } catch (e) {
    logErr('signer', e);
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
    logErr(`send failed for ${check.senderId}`, e);
    return { ok: false, status: 502, reason: 'The network refused the transaction. Try again, or pay the small fee yourself.' };
  }
}
