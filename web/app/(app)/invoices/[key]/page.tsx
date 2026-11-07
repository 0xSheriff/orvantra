import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ReviewScreen } from '@/components/ReviewScreen';
import { UploadButton } from '@/components/UploadButton';
import { getData } from '@/lib/server/cached';
import { reviewView } from '@/lib/server/review';

export const metadata: Metadata = { title: 'Invoice' };

/** Read-only review screen for any row (approvals happen on Needs approval). */
export default async function InvoiceDetail({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const d = await getData();
  // Older runs of the same invoice were folded into one row; their keys (e.g. a fresh upload link) still resolve.
  const row = d.rows.find((r) => r.key === key) ?? d.rows.find((r) => r.aliases.includes(key));
  if (!row) notFound();
  const v = reviewView(row, d);
  return (
    <ReviewScreen
      v={v}
      interactive={false}
      crumbs={<><Link href="/invoices">All invoices</Link> / <b>{v.title}</b></>}
      actions={
        <>
          {row.state === 'pending' && row.payment ? <Link href={`/review?p=${row.payment.id}`}>Review and approve</Link> : null}
          <UploadButton />
        </>
      }
    />
  );
}
