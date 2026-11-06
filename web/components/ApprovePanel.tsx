'use client';
// Approve / Reject a Pending payment with the OWNER's wallet, then poll the payment until it settles.
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { TGAS, useWallet } from './WalletProvider';

type Action = 'approve' | 'reject';
type Phase =
  | { kind: 'idle' }
  | { kind: 'signing'; action: Action }
  | { kind: 'checking'; action: Action }
  | { kind: 'done'; status: string; reasons: string[] }
  | { kind: 'error'; message: string };

const GAS = 150n * TGAS;
const ONE_YOCTO = 1n;
const STORAGE_KEY = 'orvantra:signing';
const TERMINAL = new Set(['Paid', 'Failed', 'Rejected']);

export function ApprovePanel({ paymentId, owner, vendorName, amount, route }: {
  paymentId: number;
  owner: string | null;
  vendorName: string;
  amount: string;
  route: ReactNode;
}) {
  const w = useWallet();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const polling = useRef(false);

  const poll = useCallback(async (action: Action) => {
    if (polling.current) return;
    polling.current = true;
    setPhase({ kind: 'checking', action });
    const started = Date.now();
    try {
      while (Date.now() - started < 120_000) {
        const res = await fetch(`/api/payments/${paymentId}`, { cache: 'no-store' });
        if (res.ok) {
          const p = (await res.json()) as { status: string; reasons: string[] };
          if (TERMINAL.has(p.status)) {
            setPhase({ kind: 'done', status: p.status, reasons: p.reasons });
            sessionStorage.removeItem(STORAGE_KEY);
            // The payment is no longer pending: show its settled record (fresh server data, sidebar counts too).
            setTimeout(() => router.push(`/invoices/p${paymentId}?settled=1`), 1500);
            return;
          }
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      setPhase({ kind: 'error', message: 'The treasury has not settled this payment yet. Refresh in a minute to see the result.' });
    } finally {
      polling.current = false;
    }
  }, [paymentId, router]);

  // Coming back from a redirect wallet (MyNearWallet): pick up where we left off.
  useEffect(() => {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    let saved: { id: number; action: Action } | null = null;
    try {
      saved = JSON.parse(raw) as { id: number; action: Action };
    } catch {
      sessionStorage.removeItem(STORAGE_KEY);
    }
    if (!saved || saved.id !== paymentId) return;
    const q = new URLSearchParams(window.location.search);
    const clean = () => {
      ['transactionHashes', 'errorCode', 'errorMessage'].forEach((k) => q.delete(k));
      window.history.replaceState(null, '', `${window.location.pathname}${q.size ? `?${q}` : ''}`);
    };
    if (q.get('errorCode')) {
      sessionStorage.removeItem(STORAGE_KEY);
      clean();
      queueMicrotask(() => setPhase({ kind: 'error', message: 'Signing was cancelled in your wallet. Nothing was sent.' }));
    } else if (q.get('transactionHashes')) {
      clean();
      void poll(saved.action);
    }
  }, [paymentId, poll]);

  const isOwner = !!w.accountId && !!owner && w.accountId === owner;
  const busy = phase.kind === 'signing' || phase.kind === 'checking';

  async function act(action: Action) {
    if (!w.accountId) {
      w.connect();
      return;
    }
    if (!isOwner) return;
    setPhase({ kind: 'signing', action });
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ id: paymentId, action }));
    try {
      await w.call(action === 'approve'
        ? { method: 'approve_payment', args: { id: paymentId }, gas: GAS, deposit: ONE_YOCTO, callbackUrl: window.location.href }
        // reject_payment is not payable (no deposit); rejecting can only make the treasury safer.
        : { method: 'reject_payment', args: { id: paymentId, reason: 'rejected by the owner in the Orvantra app' }, gas: GAS, deposit: 0n, callbackUrl: window.location.href });
      await poll(action);
    } catch (e) {
      sessionStorage.removeItem(STORAGE_KEY);
      const msg = e instanceof Error ? e.message : String(e);
      setPhase({ kind: 'error', message: /reject|cancel|denied|closed/i.test(msg) ? 'Signing was cancelled in your wallet. Nothing was sent.' : `The wallet returned an error: ${msg}` });
    }
  }

  let note: ReactNode = null;
  if (phase.kind === 'signing') note = <p className="note" role="status">Waiting for your wallet…</p>;
  else if (phase.kind === 'checking') note = <p className="note" role="status">{phase.action === 'approve' ? `Signed. The treasury is checking ${vendorName}'s registry entry and paying…` : 'Signed. Rejecting the payment…'}</p>;
  else if (phase.kind === 'done') {
    note = (
      <p className={`note${phase.status === 'Paid' ? '' : ' warn'}`} role="status">
        <b>{phase.status === 'Paid' ? 'Paid.' : phase.status === 'Rejected' ? 'Rejected.' : 'The transfer failed.'}</b>{' '}
        {phase.status === 'Paid' ? `${amount} went to ${vendorName}'s registered address.` : phase.reasons.at(-1) ? `Reason: ${phase.reasons.at(-1)}.` : 'No money left the treasury.'}
        {' '}<a href={`/invoices/p${paymentId}`}>Open the record</a>
      </p>
    );
  } else if (phase.kind === 'error') note = <p className="note warn" role="alert">{phase.message}</p>;
  else if (w.error) note = <p className="note warn">The wallet could not load: {w.error}</p>;
  else if (!w.accountId) note = <p className="note">Connect the owner wallet{owner ? <> (<span className="mono">{owner}</span>)</> : null} to approve or reject.</p>;
  else if (!isOwner) note = <p className="note warn">You are signed in as <span className="mono">{w.accountId}</span>. Only the treasury owner{owner ? <>, <span className="mono">{owner}</span>,</> : null} can approve or reject this payment.</p>;

  const settled = phase.kind === 'done';
  return (
    <div className="payto">
      <div className="lbl">{settled ? (phase.status === 'Paid' ? 'Paid' : 'Not paid') : 'If you approve'}</div>
      <div className="amt">{amount}</div>
      {route}
      {!settled ? (
        <div className="btns">
          <button type="button" className="btn y" onClick={() => void act('approve')} disabled={busy || !w.ready || (!!w.accountId && !isOwner)}>
            {phase.kind === 'signing' && phase.action === 'approve' ? 'Approving…' : 'Approve'}
          </button>
          <button type="button" className="btn n" onClick={() => void act('reject')} disabled={busy || !w.ready || (!!w.accountId && !isOwner)}>
            {phase.kind === 'signing' && phase.action === 'reject' ? 'Rejecting…' : 'Reject'}
          </button>
        </div>
      ) : null}
      {note}
    </div>
  );
}
