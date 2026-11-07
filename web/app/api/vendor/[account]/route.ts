// Fresh (uncached) registry entry for one account, read by the vendor page after sign-in and after saving.
import { isValidNearAccountId } from '@/lib/registry';
import { readVendor } from '@/lib/server/vendor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ account: string }> }) {
  const { account } = await params;
  if (!isValidNearAccountId(account)) return Response.json({ error: 'bad account' }, { status: 400 });
  try {
    const vendor = await readVendor(account);
    return Response.json({ vendor }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
