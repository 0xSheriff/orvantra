import type { Metadata } from 'next';
import Link from 'next/link';
import { buildActivity } from '@/lib/activity';
import { fmtWhen } from '@/lib/format';
import { getData } from '@/lib/server/cached';

export const metadata: Metadata = { title: 'Activity' };

export default async function Activity() {
  const d = await getData();
  const events = buildActivity(d.rows, d.ctx.unit, d.config?.auto_pay_threshold ?? null);
  return (
    <>
      <div className="ph">
        <div>
          <h1>Activity</h1>
          <p>Everything the agent read and everything the treasury did, newest first.</p>
        </div>
      </div>
      {d.chainError ? <p className="notice">Could not read the treasury on NEAR, so on-chain events are missing: {d.chainError}</p> : null}
      <table className="list">
        <thead>
          <tr><th scope="col">When</th><th scope="col">What happened</th><th scope="col" className="r">Amount</th></tr>
        </thead>
        <tbody>
          {events.map((e, i) => (
            <tr key={`${e.rowKey}-${i}`}>
              <td className="s" style={{ width: 140, whiteSpace: 'nowrap' }}>{fmtWhen(e.at)}</td>
              <td><Link className={`row st ${e.tone === 'plain' ? '' : e.tone}`} href={`/invoices/${e.rowKey}`}>{e.text}</Link></td>
              <td className="n">{e.amount ?? '—'}</td>
            </tr>
          ))}
          {events.length === 0 ? <tr><td colSpan={3} className="emptyrow">Nothing has happened yet.</td></tr> : null}
        </tbody>
      </table>
    </>
  );
}
