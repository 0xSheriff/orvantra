import type { Metadata } from 'next';
import Link from 'next/link';
import { ReviewScreen } from '@/components/ReviewScreen';
import { UploadButton } from '@/components/UploadButton';
import { fmtAmount } from '@/lib/format';
import { getData } from '@/lib/server/cached';
import { reviewView } from '@/lib/server/review';

export const metadata: Metadata = { title: 'Needs approval' };

export default async function NeedsApproval({ searchParams }: { searchParams: Promise<{ p?: string }> }) {
  const { p } = await searchParams;
  const d = await getData();
  const pending = d.pending;

  if (pending.length === 0) {
    return (
      <>
        <div className="ph">
          <div>
            <h1>Nothing needs your approval</h1>
            <p>Payments the treasury holds for you will appear here, one at a time.</p>
          </div>
          <UploadButton />
        </div>
        {d.chainError ? <p className="notice">Could not read the treasury on NEAR: {d.chainError}</p> : null}
        <div className="emptyrow">
          Upload an invoice to have it read, checked and proposed. Anything above your limits waits here. <Link href="/invoices">See all invoices</Link>
        </div>
      </>
    );
  }

  const idx = Math.max(0, pending.findIndex((r) => String(r.payment?.id) === p));
  const row = pending[idx];
  const next = pending.length > 1 ? pending[(idx + 1) % pending.length] : null;
  const v = reviewView(row, d);
  return (
    <ReviewScreen
      v={v}
      interactive
      crumbs={<>Needs approval / <b>{v.title}</b></>}
      actions={
        <>
          <span>{idx + 1} of {pending.length}</span>
          {next ? (
            <Link href={`/review?p=${next.payment?.id}`}>
              Next: {next.vendorName.split(' ')[0]} · {fmtAmount(next.amount)}
            </Link>
          ) : null}
          <UploadButton />
        </>
      }
    />
  );
}
