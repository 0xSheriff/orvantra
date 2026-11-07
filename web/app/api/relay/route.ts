// POST { signedDelegate: base64 borsh SignedDelegate } -> { ok, txHash?, reason? }
// Orvantra pays the network fee for a vendor's own registry update (NEP-366). Policy in lib/relay.ts.
import { relay } from '@/lib/server/relayer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let body: { signedDelegate?: unknown };
  try {
    body = (await req.json()) as { signedDelegate?: unknown };
  } catch {
    return Response.json({ ok: false, reason: 'Body must be JSON.' }, { status: 400 });
  }
  const r = await relay(body?.signedDelegate);
  return Response.json({ ok: r.ok, txHash: r.txHash ?? null, reason: r.reason ?? null }, { status: r.status, headers: { 'cache-control': 'no-store' } });
}
