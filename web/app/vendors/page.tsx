import type { Metadata } from 'next';
import { fmtAmount, fmtDuration, routeLabel, shortAddr } from '@/lib/format';
import { getData } from '@/lib/server/cached';

export const metadata: Metadata = { title: 'Vendors' };

export default async function Vendors() {
  const d = await getData();
  const approved = d.vendors.filter((v) => v.policy);
  const others = d.vendors.filter((v) => !v.policy);
  const minAge = d.config?.min_payout_age_sec ?? null;
  return (
    <>
      <div className="ph">
        <div>
          <h1>Vendors</h1>
          <p>Who you pay, where their money goes, and how much they can be paid. Vendors set their own payout in the registry.</p>
        </div>
      </div>
      {d.chainError ? <p className="notice">Could not read the registry or treasury on NEAR: {d.chainError}</p> : null}
      <table className="list">
        <thead>
          <tr><th scope="col">Vendor</th><th scope="col">Paid to</th><th scope="col">Payout</th><th scope="col">Per invoice</th><th scope="col" className="r">This month</th></tr>
        </thead>
        <tbody>
          {approved.map((v) => {
            const spent = v.monthlySpent ? BigInt(v.monthlySpent) : 0n;
            const cap = BigInt(v.policy!.monthly_cap);
            const pct = cap > 0n ? Number((spent * 1000n) / cap) / 10 : 0;
            const ageSec = v.payoutAgeNs ? Number(BigInt(v.payoutAgeNs) / 1_000_000_000n) : null;
            const fresh = ageSec != null && minAge != null && ageSec < minAge;
            return (
              <tr key={v.account}>
                <td>
                  <div className="v">{v.registry?.display_name ?? v.account}</div>
                  <div className="s">{v.account}</div>
                </td>
                <td>
                  {v.registry ? (
                    <>
                      <span className="mono" title={v.registry.payout.address}>{shortAddr(v.registry.payout.address)}</span>
                      <div className="s">{routeLabel(v.registry.payout, d.ctx.tokenId, d.ctx.unit)}</div>
                    </>
                  ) : <span className="st rej">Not in the registry</span>}
                </td>
                <td>
                  {v.registry ? (
                    <>
                      <span className="mono">v{v.registry.version}</span>
                      <div className={`s${fresh ? ' held' : ''}`}>
                        {ageSec != null ? `changed ${fmtDuration(ageSec)} ago` : '—'}
                        {fresh ? ' — new payouts are held' : ''}
                      </div>
                    </>
                  ) : '—'}
                </td>
                <td><span className="mono">{fmtAmount(v.policy!.max_per_invoice)}</span><div className="s">{v.paidCount} paid so far</div></td>
                <td className="n">
                  {fmtAmount(v.monthlySpent ?? '0')} <span className="dim">/ {fmtAmount(v.policy!.monthly_cap)}</span>
                  <span className={`meter${pct >= 80 ? ' hot' : ''}`} role="img" aria-label={`${pct}% of the monthly cap used`}><i style={{ width: `${Math.min(100, pct)}%` }} /></span>
                </td>
              </tr>
            );
          })}
          {approved.length === 0 ? (
            <tr><td colSpan={5} className="emptyrow">No approved vendors yet. The owner approves a vendor by setting its limits in the treasury.</td></tr>
          ) : null}
        </tbody>
      </table>
      {others.length ? (
        <div className="section">
          <h2>Registered, not approved by you</h2>
          <table className="list">
            <tbody>
              {others.map((v) => (
                <tr key={v.account}>
                  <td><div className="v">{v.registry?.display_name ?? v.account}</div><div className="s">{v.account}</div></td>
                  <td className="s">{v.registry ? routeLabel(v.registry.payout, d.ctx.tokenId, d.ctx.unit) : 'Not in the registry'}</td>
                  <td className="s">Invoices from this vendor are stopped until you set its limits.</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
