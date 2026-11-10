'use client';
// "Allow this invoice number again": the OWNER frees the invoice hash of a Rejected/Failed payment
// (treasury.release_invoice_hash, 1 yoctoNEAR) so the genuine invoice can be proposed again. Same wallet flow as
// ApprovePanel; the server never signs.
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { TGAS, useWallet } from './WalletProvider';

type Phase = { kind: 'idle' } | { kind: 'signing' } | { kind: 'done' } | { kind: 'error'; message: string };

const GAS = 50n * TGAS;
const STORAGE_KEY = 'orvantra:release';

export function ReleasePanel({ paymentId, owner }: { paymentId: number; owner: string | null }) {
  const w = useWallet();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const isOwner = !!w.accountId && !!owner && w.accountId === owner;

  // Back from a redirect wallet (MyNearWallet): the transaction hash is in the URL.
  useEffect(() => {
    if (sessionStorage.getItem(STORAGE_KEY) !== String(paymentId)) return;
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
      sessionStorage.removeItem(STORAGE_KEY);
      clean();
      queueMicrotask(() => setPhase({ kind: 'done' }));
    }
  }, [paymentId]);

  async function release() {
    if (!w.accountId) {
      w.connect();
      return;
    }
    if (!isOwner) return;
    setPhase({ kind: 'signing' });
    sessionStorage.setItem(STORAGE_KEY, String(paymentId));
    try {
      await w.call({ method: 'release_invoice_hash', args: { id: paymentId }, gas: GAS, deposit: 1n, callbackUrl: window.location.href });
      sessionStorage.removeItem(STORAGE_KEY);
      setPhase({ kind: 'done' });
      router.refresh();
    } catch (e) {
      sessionStorage.removeItem(STORAGE_KEY);
      const msg = e instanceof Error ? e.message : String(e);
      setPhase({ kind: 'error', message: /reject|cancel|denied|closed/i.test(msg) ? 'Signing was cancelled in your wallet. Nothing was sent.' : `The wallet returned an error: ${msg}` });
    }
  }

  const blocked = !w.ready || (!!w.accountId && !isOwner);
  return (
    <div className="payto">
      <div className="lbl">Same invoice again?</div>
      {phase.kind === 'done' ? (
        <p className="note" role="status"><b>Done.</b> This invoice number can be sent to the treasury again.</p>
      ) : (
        <>
          <p className="note">
            If a forged copy used up this invoice number, you can free it so the real invoice is accepted. Only do this for a payment you rejected.
          </p>
          <div className="btns">
            <button type="button" className="btn n" onClick={() => void release()} disabled={phase.kind === 'signing' || blocked}>
              {phase.kind === 'signing' ? 'Waiting for your wallet…' : 'Allow this invoice number again'}
            </button>
          </div>
          {phase.kind === 'error' ? <p className="note warn" role="alert">{phase.message}</p> : null}
          {!w.accountId && !w.error ? <p className="note">Connect the owner wallet{owner ? <> (<span className="mono">{owner}</span>)</> : null} to do this.</p> : null}
          {w.accountId && !isOwner ? <p className="note warn">You are signed in as <span className="mono">{w.accountId}</span>. Only the treasury owner{owner ? <>, <span className="mono">{owner}</span>,</> : null} can do this.</p> : null}
        </>
      )}
    </div>
  );
}
