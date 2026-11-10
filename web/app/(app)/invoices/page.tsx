import type { Metadata } from 'next';
import Link from 'next/link';
import { UploadButton } from '@/components/UploadButton';
import { fmtAmount, fmtWhen } from '@/lib/format';
import { getData } from '@/lib/server/cached';
import type { Category } from '@/lib/rows';

export const metadata: Metadata = { title: 'All invoices' };

const FILTERS: { id: 'all' | Category; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'held', label: 'Held' },
  { id: 'paid', label: 'Paid' },
  { id: 'stopped', label: 'Stopped' },
];

const TONE: Record<Category, string> = { held: 'held', paid: 'paid', stopped: 'rej' };

export default async function Invoices({ searchParams }: { searchParams: Promise<{ f?: string; sel?: string }> }) {
  const { f, sel } = await searchParams;
  const d = await getData();
  const filter = FILTERS.find((x) => x.id === f)?.id ?? 'all';
  const rows = filter === 'all' ? d.rows : d.rows.filter((r) => r.category === filter);
  return (
    <>
      <div className="ph">
        <div>
          <h1>All invoices</h1>
          <p>Every invoice Orvantra has read, and what happened to it. Uploads are public on this demo.</p>
        </div>
        <UploadButton />
      </div>
      {d.chainError ? <p className="notice">Could not read the treasury on NEAR, so on-chain status is missing: {d.chainError}</p> : null}
      <nav className="filters" aria-label="Filter invoices">
        {FILTERS.map((x) => (
          <Link key={x.id} href={x.id === 'all' ? '/invoices' : `/invoices?f=${x.id}`} className={filter === x.id ? 'on' : undefined} aria-current={filter === x.id ? 'page' : undefined}>
            <span>{x.label} {d.counts[x.id]}</span>
          </Link>
        ))}
      </nav>
      <table className="list">
        <thead>
          <tr><th scope="col">Vendor</th><th scope="col">Invoice</th><th scope="col">Outcome</th><th scope="col">Route</th><th scope="col" className="r">Amount</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={r.key === sel ? 'sel' : undefined}>
              <td>
                <Link className="row v" href={`/invoices/${r.key}`}>{r.vendorName}</Link>
                <div className="s">{r.vendorAccount ?? '—'}{r.invoiceName ? ` · invoice says ${r.invoiceName}` : ''}</div>
              </td>
              <td>
                <span className="mono">{r.invoiceNumber ?? '—'}</span>
                <div className="s" title={r.receivedSource === 'chain' ? 'Time the treasury recorded the payment' : 'Time the agent first read the invoice'}>
                  {r.receivedSource === 'chain' ? 'on-chain' : 'received'} {fmtWhen(r.receivedAt)}
                </div>
              </td>
              <td><span className={`st ${TONE[r.category]}`}>{r.outcome}</span></td>
              <td className="s">{r.route ?? '—'}</td>
              <td className="n">{fmtAmount(r.amount)}</td>
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="emptyrow">
                {filter === 'all' ? 'No invoices yet. Upload one to see what Orvantra does with it.' : `No ${filter} invoices.`}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </>
  );
}
