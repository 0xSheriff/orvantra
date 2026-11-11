import type { Metadata } from 'next';
import { fmtAmount, fmtDuration } from '@/lib/format';
import { getData } from '@/lib/server/cached';
import { RulesEditor, type LimitsShape, type VendorEditorRow } from '@/components/RulesEditor';

export const metadata: Metadata = { title: 'Rules & limits' };

export default async function Rules() {
  const d = await getData();
  const c = d.config;
  const u = d.ctx.unit;
  const approved = d.vendors.filter((v) => v.policy);
  const limits: LimitsShape = c
    ? {
        owner: c.owner,
        treasuryId: d.cfg.treasuryId,
        auto_pay_threshold: c.auto_pay_threshold,
        monthly_cap: c.monthly_cap,
        min_payout_age_sec: c.min_payout_age_sec,
      }
    : (null as unknown as LimitsShape);
  const vendorRows: VendorEditorRow[] = d.vendors.map((v) => ({
    account: v.account,
    name: v.registry?.display_name ?? null,
    policy: v.policy,
  }));
  return (
    <>
      <div className="ph">
        <div>
          <h1>Rules &amp; limits</h1>
          <p>What the treasury contract enforces on every payment. The agent cannot change these; only the owner can.</p>
        </div>
      </div>
      {!c ? (
        <p className="notice">Could not read the treasury on NEAR{d.chainError ? `: ${d.chainError}` : '.'}</p>
      ) : (
        <>
          <ul className="sentences">
            <li>
              <span className="say">{c.paused ? 'Payments are paused.' : 'Payments are running.'}</span>
              <span className="why">{c.paused ? 'The treasury rejects every proposal until the owner unpauses it.' : 'The owner can pause the treasury at any time.'}</span>
            </li>
            <li>
              <span className="say">Pay automatically up to {fmtAmount(c.auto_pay_threshold)} {u}.</span>
              <span className="why">Anything above waits for your approval.</span>
            </li>
            <li>
              <span className="say">Spend at most {fmtAmount(c.monthly_cap)} {u} in 30 days, across all vendors.</span>
              <span className="why">{d.totalSpent != null ? `${fmtAmount(d.totalSpent)} committed so far.` : ''}</span>
            </li>
            <li>
              <span className="say">Hold payments to a vendor who changed their payout address in the last {fmtDuration(c.min_payout_age_sec)}.</span>
              <span className="why">Stops a hijacked vendor account from being paid straight away.</span>
            </li>
            <li>
              <span className="say">Hold the first payment to every vendor.</span>
              <span className="why">You see each new payout address once.</span>
            </li>
            <li>
              <span className="say">Never pay the same invoice twice.</span>
              <span className="why">Vendor, number, amount and currency are hashed and remembered.</span>
            </li>
            <li>
              <span className="say">Pay only the address the vendor registered on-chain.</span>
              <span className="why">Addresses written on an invoice are ignored.</span>
            </li>
          </ul>

          <div className="section">
            <h2>Per vendor</h2>
            <ul className="sentences">
              {approved.map((v) => (
                <li key={v.account}>
                  <span className="say">{v.registry?.display_name ?? v.account}: up to {fmtAmount(v.policy!.max_per_invoice)} per invoice and {fmtAmount(v.policy!.monthly_cap)} in 30 days.</span>
                  <span className="why mono">{v.account}</span>
                </li>
              ))}
              {approved.length === 0 ? <li><span className="say">No vendor is approved yet, so nothing can be paid.</span><span /></li> : null}
            </ul>
          </div>

          <div className="section">
            <h2>Who can do what</h2>
            <ul className="sentences">
              <li>
                <span className="say">Only {c.owner} can approve, reject, pause or change these rules.</span>
                <span className="why">Signed in the owner&apos;s own wallet.</span>
              </li>
              <li>
                <span className="say">The agent, {c.agent}, can only propose payments.</span>
                <span className="why">Its key is limited to propose_payment on this treasury.</span>
              </li>
            </ul>
          </div>
          <RulesEditor vendors={vendorRows} limits={limits} unit={u} />
          <p className="foot">These rules live in the treasury contract <span className="mono">{d.cfg.treasuryId}</span> on NEAR {d.cfg.network}.</p>
        </>
      )}
    </>
  );
}
