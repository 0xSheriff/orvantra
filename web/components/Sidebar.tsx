import Link from 'next/link';
import { fmtAmount } from '@/lib/format';
import { getData } from '@/lib/server/cached';
import { Mark } from './Mark';
import { NavList } from './NavList';
import { WalletStatus } from './WalletStatus';

export async function Sidebar() {
  const d = await getData();
  const unit = d.ctx.unit;
  return (
    <aside className="side" aria-label="Orvantra">
      <Link className="brand" href="/review"><Mark size={26} /><span>Orvantra<small>Accounts payable</small></span></Link>
      <NavList counts={{ approval: d.pending.length, invoices: d.counts.all, vendors: d.vendors.filter((v) => v.policy).length }} />
      <div className="sidefoot">
        <WalletStatus owner={d.config?.owner ?? null} />
        <div className="treasury">
          Treasury balance
          <b>{d.balance != null ? `${fmtAmount(d.balance)} ${unit}` : '—'}</b>
          <span className="acct">{d.cfg.treasuryId}</span>
          <br />
          {d.config && d.totalSpent != null
            ? `Spent this month ${fmtAmount(d.totalSpent, { whole: true })} of ${fmtAmount(d.config.monthly_cap, { whole: true })}`
            : d.chainError ? 'Could not read the treasury' : null}
        </div>
      </div>
    </aside>
  );
}
