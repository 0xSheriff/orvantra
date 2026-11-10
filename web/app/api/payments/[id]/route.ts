// Fresh (uncached) read of one treasury payment, polled by the review screen after the owner signs.
import { failJson } from '@/lib/server/errors';
import { readPayment } from '@/lib/server/data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d{1,10}$/.test(id)) return Response.json({ error: 'bad id' }, { status: 400 });
  try {
    const p = await readPayment(Number(id));
    if (!p) return Response.json({ error: 'not found' }, { status: 404 });
    return Response.json({ id: p.id, status: p.status, reasons: p.reasons, approved_by_owner: !!p.approved_by_owner }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return failJson('payments', e);
  }
}
