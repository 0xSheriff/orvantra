// Limits for the public upload endpoint. Pure (time and files are inputs) so every rule is unit-tested.
// The demo is open to anyone, and every upload spends NEAR AI credits and may spend the agent key's allowance.
import { RateLimiter } from './limiter';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Multipart framing adds a little to the file itself. */
export const MAX_BODY_BYTES = MAX_UPLOAD_BYTES + 64 * 1024;
export const UPLOADS_PER_IP_PER_HOUR = 5;
export const UPLOADS_PER_DAY = 40;
export const DEFAULT_MAX_PROPOSALS_PER_DAY = 20;
export const KEEP_UPLOADS = 300;
export const KEEP_DAYS = 21;

export const MESSAGES = {
  tooLarge: 'That file is larger than 10 MB.',
  ip: 'You have uploaded 5 invoices in the last hour. This demo allows 5 per hour per visitor, so try again later.',
  global: 'This demo has reached its limit of 40 uploads in 24 hours. Try again later.',
  busy: 'Orvantra is reading another invoice right now. Try again in a minute.',
  proposals: (max: number) => `This demo has reached its limit of ${max} on-chain proposals today. Try again tomorrow.`,
} as const;

export class TooLargeError extends Error {
  constructor() {
    super('body too large');
  }
}

/** content-length above the cap (a missing or invalid header is not an error here: the byte cap catches it). */
export function declaredTooLarge(contentLength: string | null, max = MAX_BODY_BYTES): boolean {
  if (contentLength == null) return false;
  const n = Number(contentLength);
  return Number.isFinite(n) && n > max;
}

/** Reads a request body, stopping with TooLargeError as soon as it passes `max` bytes (so it is never fully buffered). */
export async function readCapped(body: ReadableStream<Uint8Array> | null, max = MAX_BODY_BYTES): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) throw new TooLargeError();
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  }
  return Buffer.concat(chunks);
}

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** Per-IP (5/hour) and global (40/day) upload limits. */
export class UploadLimits {
  private ip = new RateLimiter(UPLOADS_PER_IP_PER_HOUR, HOUR);
  private global = new RateLimiter(UPLOADS_PER_DAY, DAY);

  /** Records the upload when allowed. Returns the sentence to show, or null when it is allowed. */
  take(ip: string, now: number): string | null {
    // Check the global window without letting a refused visitor use it up: only count when the IP limit passes.
    if (!this.ip.take(ip, now)) return MESSAGES.ip;
    if (!this.global.take('all', now)) return MESSAGES.global;
    return null;
  }
}

/** At most one running and one waiting job. */
export class Inflight {
  private n = 0;
  constructor(readonly max = 2) {}

  enter(): boolean {
    if (this.n >= this.max) return false;
    this.n += 1;
    return true;
  }

  leave(): void {
    this.n = Math.max(0, this.n - 1);
  }

  get count(): number {
    return this.n;
  }
}

export function maxProposalsPerDay(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.ORVANTRA_MAX_PROPOSALS_PER_DAY);
  return Number.isInteger(n) && n >= 0 && env.ORVANTRA_MAX_PROPOSALS_PER_DAY !== undefined && env.ORVANTRA_MAX_PROPOSALS_PER_DAY !== ''
    ? n
    : DEFAULT_MAX_PROPOSALS_PER_DAY;
}

interface LedgerLike {
  network: string;
  treasury: string;
  tx_hash?: string | null;
  statuses: { at: string; status: string }[];
}

/** On-chain proposals the agent sent today (UTC day) to this treasury: ledger entries with a `proposed` status today. */
export function proposalsToday(ledger: Record<string, LedgerLike>, network: string, treasury: string, now: number): number {
  const day = new Date(now).toISOString().slice(0, 10);
  let n = 0;
  for (const e of Object.values(ledger)) {
    if (e.network !== network || e.treasury !== treasury || !e.tx_hash) continue;
    if (e.statuses.some((s) => s.status === 'proposed' && s.at.slice(0, 10) === day)) n += 1;
  }
  return n;
}

/** Upload record ids (`<13-digit ms>-<8 hex>`) to delete: all but the newest `keep`, and anything older than `days`. */
export function expiredUploadIds(ids: string[], now: number, keep = KEEP_UPLOADS, days = KEEP_DAYS): string[] {
  const sorted = [...ids].sort().reverse(); // ids start with the time in ms, so lexical order is chronological
  const cutoff = now - days * DAY;
  return sorted.filter((id, i) => i >= keep || Number(id.slice(0, 13)) < cutoff);
}
