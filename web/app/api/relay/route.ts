// POST { signedDelegate: base64 borsh SignedDelegate } -> { ok, txHash?, reason? }
// Orvantra pays the network fee for a vendor's own registry update (NEP-366). Policy in lib/relay.ts.
import { clientIp } from '@/lib/relay';
import { relay } from '@/lib/server/relayer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A SignedDelegate is a few hundred bytes; refuse a larger body before reading it. */
const MAX_BODY_BYTES = 16 * 1024;

export async function POST(req: Request) {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return Response.json({ ok: false, reason: 'That request is too large.' }, { status: 413 });
  let body: { signedDelegate?: unknown };
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return Response.json({ ok: false, reason: 'That request is too large.' }, { status: 413 });
    body = JSON.parse(text) as { signedDelegate?: unknown };
  } catch {
    return Response.json({ ok: false, reason: 'Body must be JSON.' }, { status: 400 });
  }
  try {
    const r = await relay(body?.signedDelegate, clientIp(req.headers));
    return Response.json({ ok: r.ok, txHash: r.txHash ?? null, reason: r.reason ?? null }, { status: r.status, headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    console.error(`[relay] unexpected: ${e instanceof Error ? e.message : String(e)}`);
    return Response.json({ ok: false, txHash: null, reason: 'The relayer hit an error. Try again later.' }, { status: 500, headers: { 'cache-control': 'no-store' } });
  }
}
