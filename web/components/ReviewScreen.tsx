import type { ReactNode } from 'react';
import type { ReviewView } from '@/lib/server/review';
import type { Segment } from '@/lib/verdict';
import { ApprovePanel } from './ApprovePanel';
import { ReleasePanel } from './ReleasePanel';

function Rich({ segs }: { segs: Segment[] }) {
  return (
    <>
      {segs.map((s, i) => {
        if (!s.mono && !s.strike) return <span key={i}>{s.text}</span>;
        const cls = [s.mono ? 'mono' : '', s.strike ? 'strike' : ''].filter(Boolean).join(' ');
        return s.strike ? <del key={i} className={cls}>{s.text}</del> : <span key={i} className={cls}>{s.text}</span>;
      })}
    </>
  );
}

function Route({ v }: { v: ReviewView }) {
  const p = v.pay;
  return (
    <div className="route">
      {p.vendorAccount ? <>to {p.vendorAccount}</> : null}
      {p.addressShort && p.address !== p.vendorAccount ? <> → <span className="mono" title={p.address ?? undefined}>{p.addressShort}</span></> : null}
      {p.route ? <> · {p.route}</> : null}
      {p.eta ? <> · {p.eta}</> : null}
      {p.simulated ? <> · simulated 1Click deposit on testnet</> : null}
    </div>
  );
}

function StaticPanel({ v }: { v: ReviewView }) {
  const t = v.verdict.tone;
  const label = t === 'paid' ? 'Paid' : t === 'paying' ? 'Paying now' : t === 'held' ? 'Waiting for approval' : 'Not paid';
  return (
    <div className="payto">
      <div className="lbl">{label}</div>
      <div className={`amt${t === 'stopped' ? ' gone' : ''}`}>{v.pay.amount}</div>
      <Route v={v} />
      {v.pay.explorerUrl ? (
        <p className="note"><a href={v.pay.explorerUrl} target="_blank" rel="noreferrer">See the proposal on NEAR Blocks</a></p>
      ) : null}
    </div>
  );
}

export function ReviewScreen({ v, crumbs, actions, interactive }: { v: ReviewView; crumbs: ReactNode; actions?: ReactNode; interactive: boolean }) {
  const img = v.image;
  const pending = v.pay.status === 'Pending' && v.pay.paymentId != null;
  return (
    <>
      <div className="crumbs">
        <div className="c">{crumbs}</div>
        {actions ? <div className="pager">{actions}</div> : null}
      </div>
      <div className="stage">
        <div className="paperwrap">
          <figure className="paper">
            {img ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element -- private, server-streamed invoice image */}
                <img src={img.src} width={img.width} height={img.height} alt={img.alt} />
                <div className="ov" aria-hidden="true">
                  {v.overlays.outlines.map((o) => (
                    <span key={o.field} className={`mark${o.tone === 'ok' ? ' ok' : ''}`} style={{ left: `${o.left}%`, top: `${o.top}%`, width: `${o.width}%`, height: `${o.height}%` }} />
                  ))}
                  {v.overlays.pins.map((p) => (
                    <span key={p.n} className={`pin${p.ok ? '' : ' r'}`} style={{ [p.side]: '-11px', top: `calc(${p.top}% - 11px)` }}>{p.n}</span>
                  ))}
                </div>
                {img.pages > 1 ? <figcaption className="pagenote">Page 1 of {img.pages}</figcaption> : null}
              </>
            ) : (
              <div className="empty">
                <h2>{v.title}</h2>
                <p>The original file was not kept for this payment. It was proposed outside the web app, so only the on-chain record is shown.</p>
              </div>
            )}
          </figure>
        </div>
        <aside className="railwrap" aria-label="Review">
          <div className="rail">
            <div className="verdict" data-tone={v.verdict.tone}>
              <div className="lbl">{v.verdict.label}</div>
              <h1>{v.verdict.headline}</h1>
              <p>{v.verdict.body}</p>
            </div>
            {v.verdict.items.length ? (
              <ol className="findings" aria-label="Findings">
                {v.verdict.items.map((it) => (
                  <li key={it.n} className="f">
                    <span className={`pin${it.ok ? '' : ' r'}`} aria-hidden="true">{it.n}</span>
                    <div>
                      <b>{it.title}<span className="sr-only">{it.ok ? ' (checked)' : ' (problem)'}</span></b>
                      <span className="d"><Rich segs={it.detail} /></span>
                    </div>
                  </li>
                ))}
              </ol>
            ) : null}
            {interactive && pending ? (
              <ApprovePanel
                paymentId={v.pay.paymentId!}
                owner={v.owner}
                vendorName={v.vendorName}
                amount={v.pay.amount}
                route={<Route v={v} />}
              />
            ) : (
              <StaticPanel v={v} />
            )}
            {v.release ? <ReleasePanel paymentId={v.release.paymentId} owner={v.owner} /> : null}
          </div>
          <p className="foot">
            {pending
              ? `Approval is signed in your NEAR wallet. The treasury checks ${v.vendorName}'s registry entry again before money moves.`
              : v.pay.paymentId != null
                ? `Payment #${v.pay.paymentId} in ${v.treasuryId}.`
                : 'This invoice never reached the treasury.'}
            {v.overlayNote ? <><br />{v.overlayNote}</> : null}
          </p>
        </aside>
      </div>
    </>
  );
}
