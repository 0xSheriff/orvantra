'use client';
// Owner-only editors for the treasury rules: global limits (set_limits) and per-vendor
// policies (set_vendor_policy / remove_vendor_policy). Every write is signed in the
// owner's own wallet (selector); the server never signs. Redirect-safe like ApprovePanel:
// browser wallets such as MyNearWallet navigate away and back via callbackUrl.
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TGAS, useWallet } from './WalletProvider';
import { fmtAmount } from '@/lib/format';

export type PolicyShape = { max_per_invoice: string; monthly_cap: string };
export type VendorEditorRow = { account: string; name: string | null; policy: PolicyShape | null };
export type LimitsShape = {
  owner: string;
  treasuryId: string;
  auto_pay_threshold: string;
  monthly_cap: string;
  min_payout_age_sec: number;
};

const GAS = 150n * TGAS;
const ONE_YOCTO = 1n;
const U = 1_000_000n;
const STORAGE_KEY = 'orvantra:rules-signing';
type ActionId = 'limits' | `policy:${string}` | `revoke:${string}`;

function toBase(v: string): bigint | null {
  const t = v.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(t)) return null;
  const [i, f = ''] = t.split('.');
  return BigInt(i) * U + BigInt((f + '000000').slice(0, 6));
}
function toDisplay(base: string): string {
  let b: bigint;
  try { b = BigInt(base); } catch { return base; }
  const whole = b / U;
  const frac = (b % U).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'signing'; action: ActionId }
  | { kind: 'done'; text: string }
  | { kind: 'error'; message: string };

export function RulesEditor({ vendors, limits, unit }: { vendors: VendorEditorRow[]; limits: LimitsShape; unit: string }) {
  const w = useWallet();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  // per-row drafts: account -> { max, cap }
  const [drafts, setDrafts] = useState<Record<string, { max: string; cap: string }>>(() =>
    Object.fromEntries(vendors.map((v) => [v.account, { max: v.policy ? toDisplay(v.policy.max_per_invoice) : '', cap: v.policy ? toDisplay(v.policy.monthly_cap) : '' }])),
  );
  const [limitsDraft, setLimitsDraft] = useState({ auto: toDisplay(limits.auto_pay_threshold), cap: toDisplay(limits.monthly_cap) });
  const [returned, setReturned] = useState(false);
  const busy = phase.kind === 'signing';
  const isOwner = !!w.accountId && w.accountId === limits.owner;

  // Coming back from a redirect wallet: refresh so the on-chain values re-read.
  useEffect(() => {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    let saved: { action: ActionId } | null = null;
    try { saved = JSON.parse(raw) as { action: ActionId }; } catch { sessionStorage.removeItem(STORAGE_KEY); return; }
    const q = new URLSearchParams(window.location.search);
    const clean = () => {
      ['transactionHashes', 'errorCode', 'errorMessage'].forEach((k) => q.delete(k));
      window.history.replaceState(null, '', `${window.location.pathname}${q.size ? `?${q}` : ''}`);
    };
    if (q.get('errorCode')) {
      sessionStorage.removeItem(STORAGE_KEY);
      clean();
      setPhase({ kind: 'error', message: 'Signing was cancelled in your wallet. Nothing was sent.' });
    } else if (q.get('transactionHashes')) {
      sessionStorage.removeItem(STORAGE_KEY);
      clean();
      setPhase({ kind: 'done', text: 'Signed. The new rule is live on NEAR.' });
      setReturned(true);
    }
  }, []);

  // Fresh server data after the redirect return.
  useEffect(() => {
    if (returned) void router.refresh();
  }, [returned, router]);

  const sign = useCallback(async (action: ActionId, method: string, args: object) => {
    if (!w.accountId) { w.connect(); return; }
    setPhase({ kind: 'signing', action });
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ action }));
    try {
      await w.call({ method, args, gas: GAS, deposit: ONE_YOCTO, callbackUrl: window.location.href });
      // Inline wallets (Meteor/HERE) resolve here; the wallet already has the tx.
      setPhase({ kind: 'done', text: 'Signed. The new rule is live on NEAR.' });
      sessionStorage.removeItem(STORAGE_KEY);
      void router.refresh();
    } catch (e) {
      sessionStorage.removeItem(STORAGE_KEY);
      const msg = e instanceof Error ? e.message : String(e);
      setPhase({ kind: 'error', message: /reject|cancel|denied|closed/i.test(msg) ? 'Signing was cancelled in your wallet. Nothing was sent.' : `The wallet returned an error: ${msg}` });
    }
  }, [w, router]);

  function saveVendorPolicy(account: string) {
    const d = drafts[account];
    if (!d || !d.max || !d.cap) { setPhase({ kind: 'error', message: 'Fill in both the per-invoice max and the 30-day cap before saving.' }); return; }
    const max = toBase(d.max), cap = toBase(d.cap);
    if (max == null || cap == null || max === 0n || cap === 0n) { setPhase({ kind: 'error', message: 'Limits must be positive numbers (up to 6 decimals).' }); return; }
    void sign(`policy:${account}`, 'set_vendor_policy', { vendor: account, max_per_invoice: max.toString(), monthly_cap: cap.toString() });
  }
  function revokeVendorPolicy(account: string) {
    void sign(`revoke:${account}`, 'remove_vendor_policy', { vendor: account });
  }
  function saveLimits() {
    const auto = toBase(limitsDraft.auto), cap = toBase(limitsDraft.cap);
    if (auto == null || cap == null || auto === 0n || cap === 0n) { setPhase({ kind: 'error', message: 'Both global limits must be positive numbers (up to 6 decimals).' }); return; }
    void sign('limits', 'set_limits', { auto_pay_threshold: auto.toString(), monthly_cap: cap.toString(), min_payout_age_sec: limits.min_payout_age_sec });
  }

  const label = (action: ActionId, idle: string, busyTxt: string) =>
    busy && phase.kind === 'signing' && phase.action === action ? busyTxt : idle;

  return (
    <div className="section editor">
      <h2>Change a rule</h2>
      {!w.accountId ? (
        <p className="note">Connect the owner wallet <span className="mono">{limits.owner}</span> to edit. Signed in your own wallet — the app never signs for you.</p>
      ) : !isOwner ? (
        <p className="note warn">You are signed in as <span className="mono">{w.accountId}</span>. Only the treasury owner, <span className="mono">{limits.owner}</span>, can change these rules.</p>
      ) : null}

      {isOwner ? (
        <>
          <div className="editrow">
            <div className="er-label">
              <span className="say">Pay automatically up to <input className="mono" value={limitsDraft.auto} onChange={(e) => setLimitsDraft((s) => ({ ...s, auto: e.target.value }))} inputMode="decimal" aria-label="Auto-pay threshold" /> {unit}.</span>
              <span className="why">Anything above waits for your approval.</span>
            </div>
            <div className="er-label">
              <span className="say">Spend at most <input className="mono" value={limitsDraft.cap} onChange={(e) => setLimitsDraft((s) => ({ ...s, cap: e.target.value }))} inputMode="decimal" aria-label="Monthly cap" /> {unit} in 30 days.</span>
              <span className="why">Across all vendors.</span>
            </div>
            <div className="er-actions">
              <button type="button" className="btn mini" onClick={saveLimits} disabled={busy}>
                {label('limits', 'Save global limits', 'Signing…')}
              </button>
            </div>
          </div>

          {vendors.map((v) => {
            const d = drafts[v.account] ?? { max: '', cap: '' };
            const set = (patch: Partial<{ max: string; cap: string }>) => setDrafts((s) => ({ ...s, [v.account]: { ...s[v.account], ...patch } }));
            const action: ActionId = `policy:${v.account}`;
            return (
              <div className="editrow" key={v.account}>
                <div className="er-label">
                  <span className="say">{v.name ?? v.account}: up to <input className="mono" value={d.max} onChange={(e) => set({ max: e.target.value })} inputMode="decimal" placeholder="0" aria-label={`Per-invoice max for ${v.account}`} /> {unit} per invoice and <input className="mono" value={d.cap} onChange={(e) => set({ cap: e.target.value })} inputMode="decimal" placeholder="0" aria-label={`30-day cap for ${v.account}`} /> {unit} in 30 days.</span>
                  <span className="why mono">{v.account}</span>
                </div>
                <div className="er-actions">
                  <button type="button" className="btn mini" onClick={() => saveVendorPolicy(v.account)} disabled={busy}>
                    {label(action, v.policy ? 'Save' : 'Approve vendor', 'Signing…')}
                  </button>
                  {v.policy ? (
                    <button type="button" className="btn mini ghost" onClick={() => revokeVendorPolicy(v.account)} disabled={busy}>
                      {label(`revoke:${v.account}`, 'Revoke', 'Signing…')}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </>
      ) : null}

      {phase.kind === 'signing' ? <p className="note" role="status">Waiting for your wallet…</p> : null}
      {phase.kind === 'done' ? <p className="note" role="status"><b>{phase.text}</b></p> : null}
      {phase.kind === 'error' ? <p className="note warn" role="alert">{phase.message}</p> : null}
      {w.error ? <p className="note warn">The wallet could not load: {w.error}</p> : null}
      <p className="foot">Current: auto-pay {fmtAmount(limits.auto_pay_threshold)} {unit} · 30-day cap {fmtAmount(limits.monthly_cap)} {unit} · rule changes are stored on {limits.treasuryId} and enforced by the contract, not the app.</p>
    </div>
  );
}
