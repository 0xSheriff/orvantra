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
import { RELAY_METHODS, SET_VENDOR_GAS, isValidNearAccountId } from './registry';

export const MAX_RELAY_GAS = SET_VENDOR_GAS;
/** A SignedDelegate for one small function call is a few hundred bytes; refuse anything far larger before decoding. */
export const MAX_SIGNED_DELEGATE_BYTES = 4096;

type Plain = Record<string, unknown>;

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

/**
 * Policy: receiver is the registry; exactly one FunctionCall to set_vendor/remove_vendor; no deposit; at most 30 TGas;
 * not expired; valid signature. `currentHeight` is the latest final block height.
 */
export function checkSignedDelegate(sd: SignedDelegate, o: { registryId: string; currentHeight: bigint }): RelayCheck {
  const da = sd.delegateAction;
  const no = (reason: string): RelayCheck => ({ ok: false, reason, senderId: da?.senderId });
  if (!da || typeof da.senderId !== 'string' || !isValidNearAccountId(da.senderId)) return no('The sender is not a valid NEAR account.');
  if (da.receiverId !== o.registryId) return no(`Orvantra only pays the fee for calls to the vendor registry (${o.registryId}).`);
  if (!Array.isArray(da.actions) || da.actions.length !== 1) return no('Exactly one action is allowed.');
  const fc = (da.actions[0] as unknown as Plain).functionCall as { methodName: string; gas: bigint; deposit: bigint } | undefined;
  if (!fc) return no('Only a function call is allowed.');
  if (!(RELAY_METHODS as readonly string[]).includes(fc.methodName)) return no(`Only ${RELAY_METHODS.join(' and ')} are allowed.`);
  if (BigInt(fc.deposit) !== 0n) return no('No deposit may be attached.');
  if (BigInt(fc.gas) > MAX_RELAY_GAS) return no(`At most ${MAX_RELAY_GAS / 1_000_000_000_000n} TGas is allowed.`);
  if (BigInt(da.maxBlockHeight) <= o.currentHeight) return no('This signature has expired. Please save again.');
  if (!signatureValid(sd)) return no('The signature does not match the request.');
  return { ok: true, senderId: da.senderId, method: fc.methodName };
}

/** In-memory sliding-window limit per sender (e.g. 5 per hour). One per server process. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(readonly limit: number, readonly windowMs: number) {}

  /** Records a hit and returns true when `key` is still under the limit. */
  take(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
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

function failureText(f: unknown): string {
  const panic = JSON.stringify(f).match(/"ExecutionError":"([^"]+)"/);
  if (panic) return panic[1].replace(/^Smart contract panicked: /, '');
  return JSON.stringify(f).slice(0, 300);
}
