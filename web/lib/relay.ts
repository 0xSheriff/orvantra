// NEP-366 relay policy: decode a vendor's SignedDelegate and decide whether Orvantra's relayer will pay for it.
// No network and no keys here (lib/server/relayer.ts does the I/O), so every rule is unit-tested.
//
// The relayer only sponsors one thing: a vendor editing its OWN registry entry. The registry uses
// predecessor_account_id, which stays the vendor inside a meta transaction, so the relayer cannot change anyone's
// payout and a vendor cannot use the relayer for anything else.
import { createHash } from 'node:crypto';
import { deserialize } from 'borsh';
import { PublicKey } from '@near-js/crypto';
import { SCHEMA, encodeDelegateAction } from '@near-js/transactions';
import type { SignedDelegate } from '@near-js/transactions';
import { REGISTRY_DEPOSIT, RELAY_METHODS, SET_VENDOR_GAS, isValidNearAccountId } from './registry';

export { RateLimiter, clientIp } from './limiter';

export const MAX_RELAY_GAS = SET_VENDOR_GAS;
/** A SignedDelegate for one small function call is a few hundred bytes; refuse anything far larger before decoding. */
export const MAX_SIGNED_DELEGATE_BYTES = 4096;
/** A delegate may live at most this many blocks (about 17 minutes), so a leaked signature expires quickly. */
export const MAX_BLOCK_HEIGHT_WINDOW = 1000n;
/** The relayer refuses to sponsor anything when its own balance is below 1 NEAR. */
export const MIN_RELAYER_BALANCE = 10n ** 24n;
/** set_vendor may carry the storage estimate plus this margin, never more than DEPOSIT_CAP. */
export const DEPOSIT_MARGIN = 10n ** 21n;
export const DEPOSIT_CAP = 5n * 10n ** 22n; // 0.05 NEAR

type Plain = Record<string, unknown>;

/** Highest deposit a set_vendor delegate may attach: the registry's storage estimate plus a small margin, capped. */
export function maxSetVendorDeposit(storageEstimate: bigint): bigint {
  const v = storageEstimate + DEPOSIT_MARGIN;
  return v > DEPOSIT_CAP ? DEPOSIT_CAP : v;
}

export interface RelayCheck {
  ok: boolean;
  /** Plain sentence for the vendor. */
  reason?: string;
  senderId?: string;
  method?: string;
}

/** Borsh-decode a base64 SignedDelegate. Throws on garbage. */
export function decodeSignedDelegate(b64: string): SignedDelegate {
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_SIGNED_DELEGATE_BYTES) throw new Error('bad size');
  return deserialize(SCHEMA.SignedDelegate, bytes) as unknown as SignedDelegate;
}

function keyOf(pk: unknown): PublicKey {
  const p = pk as Plain;
  const ed = p.ed25519Key as { data: Uint8Array } | undefined;
  if (ed) return new PublicKey({ keyType: 0, data: Uint8Array.from(ed.data) });
  const k1 = p.secp256k1Key as { data: Uint8Array } | undefined;
  if (k1) return new PublicKey({ keyType: 1, data: Uint8Array.from(k1.data) });
  throw new Error('unknown key type');
}

function signatureBytes(sig: unknown): Uint8Array {
  const s = sig as Plain;
  const d = (s.ed25519Signature ?? s.secp256k1Signature) as { data: Uint8Array } | undefined;
  if (!d) throw new Error('unknown signature type');
  return Uint8Array.from(d.data);
}

/** The vendor's signature over the NEP-366 message (sha256 of the prefixed DelegateAction). */
export function signatureValid(sd: SignedDelegate): boolean {
  try {
    const hash = createHash('sha256').update(encodeDelegateAction(sd.delegateAction)).digest();
    return keyOf(sd.delegateAction.publicKey).verify(hash, signatureBytes(sd.signature));
  } catch {
    return false;
  }
}

/** The public key of the delegate in NEAR text form ("ed25519:..."). */
export function delegateKeyString(sd: SignedDelegate): string {
  return keyOf(sd.delegateAction.publicKey).toString();
}

/**
 * Policy: receiver is the registry; exactly one FunctionCall to set_vendor/remove_vendor; set_vendor attaches at
 * least 1 yoctoNEAR and at most `maxSetVendorDeposit` (the storage deposit, taken from the VENDOR's balance, not the
 * relayer's), remove_vendor exactly 1 yoctoNEAR; at most 30 TGas; not expired and not valid for more than
 * 1000 blocks; valid signature. `currentHeight` is the latest final block height.
 */
export function checkSignedDelegate(sd: SignedDelegate, o: { registryId: string; currentHeight: bigint; maxSetVendorDeposit: bigint }): RelayCheck {
  const da = sd.delegateAction;
  const no = (reason: string): RelayCheck => ({ ok: false, reason, senderId: da?.senderId });
  if (!da || typeof da.senderId !== 'string' || !isValidNearAccountId(da.senderId)) return no('The sender is not a valid NEAR account.');
  if (da.receiverId !== o.registryId) return no(`Orvantra only pays the fee for calls to the vendor registry (${o.registryId}).`);
  if (!Array.isArray(da.actions) || da.actions.length !== 1) return no('Exactly one action is allowed.');
  const fc = (da.actions[0] as unknown as Plain).functionCall as { methodName: string; gas: bigint; deposit: bigint } | undefined;
  if (!fc) return no('Only a function call is allowed.');
  if (!(RELAY_METHODS as readonly string[]).includes(fc.methodName)) return no(`Only ${RELAY_METHODS.join(' and ')} are allowed.`);
  const deposit = BigInt(fc.deposit);
  if (fc.methodName === 'remove_vendor') {
    if (deposit !== REGISTRY_DEPOSIT) return no('Exactly 1 yoctoNEAR must be attached.');
  } else if (deposit < REGISTRY_DEPOSIT || deposit > o.maxSetVendorDeposit) {
    return no('The deposit is not the registry storage deposit. Reload the page and try again.');
  }
  if (BigInt(fc.gas) > MAX_RELAY_GAS) return no(`At most ${MAX_RELAY_GAS / 1_000_000_000_000n} TGas is allowed.`);
  const maxHeight = BigInt(da.maxBlockHeight);
  if (maxHeight <= o.currentHeight) return no('This signature has expired. Please save again.');
  if (maxHeight - o.currentHeight > MAX_BLOCK_HEIGHT_WINDOW) return no('This signature is valid for too long. Please save again.');
  if (!signatureValid(sd)) return no('The signature does not match the request.');
  return { ok: true, senderId: da.senderId, method: fc.methodName };
}

export interface AccessKeyInfo {
  nonce: number | bigint | string;
  permission: unknown;
}

/**
 * The delegate's key must be a FULL-ACCESS key of the sender on-chain (our methods need a deposit, which function-call
 * keys cannot attach), and the delegate nonce must be above the key's current nonce (no replay of old signatures).
 * `key` is null when the sender does not exist or the key is not on the account.
 */
export function checkAccessKey(sd: SignedDelegate, key: AccessKeyInfo | null): RelayCheck {
  const no = (reason: string): RelayCheck => ({ ok: false, reason, senderId: sd.delegateAction.senderId });
  if (!key) return no('This account does not exist, or the key that signed is not on it.');
  if (key.permission !== 'FullAccess') return no('The signing key must be a full-access key of your account. Confirm with your wallet, not a limited sign-in key.');
  if (BigInt(sd.delegateAction.nonce) <= BigInt(key.nonce)) return no('This signature is outdated. Please save again.');
  return { ok: true, senderId: sd.delegateAction.senderId };
}

/** First failure in a FinalExecutionOutcome (tx or any receipt), as text; null if everything succeeded. */
export function outcomeFailure(outcome: unknown): string | null {
  const o = outcome as { status?: Plain; transaction_outcome?: { outcome?: { status?: Plain } }; receipts_outcome?: { outcome?: { status?: Plain } }[] };
  const statuses = [o.status, o.transaction_outcome?.outcome?.status, ...(o.receipts_outcome ?? []).map((r) => r.outcome?.status)];
  for (const s of statuses) {
    if (s && typeof s === 'object' && 'Failure' in s) return failureText(s.Failure);
  }
  return null;
}

/** The contract's own panic message (it is written for vendors), else a generic sentence. */
function failureText(f: unknown): string {
  const panic = JSON.stringify(f).match(/"ExecutionError":"([^"]+)"/);
  if (panic) return panic[1].replace(/^Smart contract panicked: /, '').slice(0, 200);
  return 'The transaction failed on NEAR.';
}
