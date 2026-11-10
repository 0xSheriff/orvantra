'use client';
// Right half of /register: sign in, then set your own payout details in the vendor registry.
// Saving is gasless when the wallet can sign NEP-366 delegate actions (Orvantra's relayer pays); otherwise it is a
// normal transaction and the wallet asks the vendor to pay the fee.
// Both paths attach the registry's storage deposit (view storage_cost_estimate, largest entry; the registry refunds
// the excess). The deposit comes from the VENDOR, never from the relayer. A dapp's limited function-call key cannot
// attach a deposit, so the wallet always asks the vendor to confirm with their full-access key.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { explorerTxUrl } from '@/lib/links';
import {
  CHAINS, CHAIN_LABEL, MAX_DISPLAY_NAME_CHARS, SET_VENDOR_GAS, addressError, displayNameError, feeSentence, isChain, relativeTime,
  shortAddress, symbolFor, type Chain, type TokenOption,
} from '@/lib/registry';
import type { VendorPageData } from '@/lib/server/vendor';
import { useWallet } from './WalletProvider';

interface VendorView {
  account_id: string;
  display_name: string;
  payout: { chain: string; asset_id: string; address: string };
  updated_at_ns: string;
  version: number;
}

interface Saved {
  vendor: VendorView | null;
  txHash: string | null;
  paidBy: 'Orvantra' | 'you';
  chain: string;
  symbol: string;
}

const DEFAULT_CHAIN: Chain = 'base';

function holdText(sec: number | null): string {
  if (!sec) return 'Treasuries hold payments to a freshly changed address for a while before paying it.';
  const h = sec / 3600;
  const span = h >= 1 ? `${Number.isInteger(h) ? h : h.toFixed(1)} hour${h === 1 ? '' : 's'}` : `${Math.round(sec / 60)} minutes`;
  return `Treasuries hold payments to a freshly changed address for ${span} before paying it.`;
}

export function VendorPanel({ network, options, minPayoutAgeSec, tokensError, typicalDeposit, attachDeposit }: VendorPageData) {
  const w = useWallet();
  const account = w.accountId;

  const [existing, setExisting] = useState<VendorView | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null); // account whose entry was loaded
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [chain, setChain] = useState<Chain>(DEFAULT_CHAIN);
  const [assetId, setAssetId] = useState(options[DEFAULT_CHAIN][0]?.assetId ?? '');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [relayFailed, setRelayFailed] = useState(false);
  const [saved, setSaved] = useState<Saved | null>(null);
  /** When the entry was last read; "last changed N ago" is relative to this. */
  const [now, setNow] = useState(0);

  const fetchVendor = useCallback(async (id: string): Promise<VendorView | null> => {
    const r = await fetch(`/api/vendor/${encodeURIComponent(id)}`, { cache: 'no-store' });
    const j = (await r.json()) as { vendor?: VendorView | null; error?: string };
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    return j.vendor ?? null;
  }, []);

  // Load (and prefill from) the signed-in account's registry entry.
  useEffect(() => {
    if (!account || loaded === account) return;
    let cancelled = false;
    fetchVendor(account).then(
      (v) => {
        if (cancelled) return;
        setLoadError(null);
        setSaved(null);
        setNow(Date.now());
        setExisting(v);
        setLoaded(account);
        if (v && isChain(v.payout.chain)) {
          setName(v.display_name);
          setChain(v.payout.chain);
          setAssetId(v.payout.asset_id);
          setAddress(v.payout.address);
        } else {
          setName('');
          setAddress(chain === 'near' ? account : '');
        }
      },
      (e) => !cancelled && setLoadError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
    // chain is read only for the first prefill of a new account
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, loaded, fetchVendor]);

  // Token choices for the chosen chain, keeping an older registry value selectable.
  const tokenList: TokenOption[] = useMemo(() => {
    const list = [...(options[chain] ?? [])];
    if (existing && existing.payout.chain === chain && !list.some((t) => t.assetId === existing.payout.asset_id)) {
      list.push({ symbol: symbolFor(options, chain, existing.payout.asset_id), assetId: existing.payout.asset_id });
    }
    return list;
  }, [options, chain, existing]);

  const onChain = (next: Chain) => {
    setChain(next);
    setAssetId((options[next] ?? [])[0]?.assetId ?? '');
    if (next === 'near' && (!address || addressError('near', address))) setAddress(account ?? '');
    else if (next !== 'near' && address === account) setAddress('');
    setError(null);
  };

  const label = CHAIN_LABEL[chain];
  const symbol = symbolFor(options, chain, assetId);
  const nameErr = displayNameError(name);
  const addrErr = address ? addressError(chain, address) : null;
  const unchanged = !!existing && existing.display_name === name && existing.payout.chain === chain
    && existing.payout.asset_id === assetId && existing.payout.address === address;
  const canSave = !!account && loaded === account && !nameErr && !addressError(chain, address) && !!assetId && !unchanged && !busy;

  async function save(forceFee = false) {
    if (!account || !canSave) return;
    setError(null);
    setRelayFailed(false);
    const args = { display_name: name, chain, asset_id: assetId, address };
    const gasless = w.gasless && !forceFee;
    // The registry keeps what the entry's storage costs and refunds the rest, so the largest estimate always works.
    const deposit = BigInt(attachDeposit);
    try {
      let txHash: string | null = null;
      if (gasless) {
        setBusy('Confirm in your wallet…');
        const signedDelegate = await w.signDelegate({ method: 'set_vendor', args, gas: SET_VENDOR_GAS, deposit });
        setBusy('Saving on NEAR…');
        const r = await fetch('/api/relay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signedDelegate }) });
        const j = (await r.json()) as { ok: boolean; txHash: string | null; reason: string | null };
        if (!j.ok) {
          setRelayFailed(!j.txHash);
          throw new Error(j.reason ?? 'The relayer could not save this.');
        }
        txHash = j.txHash;
      } else {
        setBusy('Confirm in your wallet…');
        txHash = await w.call({ method: 'set_vendor', args, gas: SET_VENDOR_GAS, deposit, callbackUrl: `${location.origin}/register` });
      }
      setBusy('Reading it back…');
      const vendor = await fetchVendor(account).catch(() => null);
      setNow(Date.now());
      setExisting(vendor);
      setSaved({ vendor, txHash, paidBy: gasless ? 'Orvantra' : 'you', chain, symbol });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // ------------------------------------------------------------------ signed out
  if (!account) {
    return (
      <>
        <header className="top status"><span>Step 1 of 2 · sign in</span></header>
        <div className="mid">
          <div className="vform">
            <h2 className="lbl">How do you want to be paid?</h2>
            <p className="intro">
              Sign in with the NEAR account your clients know you by, like <code className="m">acme.near</code>. Your payout
              details are saved under that account, and only it can change them.
            </p>
            <button type="button" className="submit" onClick={w.connect} disabled={!w.ready}>
              {w.error ? 'Wallet unavailable' : w.ready ? 'Connect your NEAR wallet' : 'Loading wallets…'}
            </button>
            <p className="fine">{w.error ? `The wallet selector could not start: ${w.error}` : 'MyNearWallet, Meteor or HERE.'}</p>
          </div>
        </div>
      </>
    );
  }

  const who = (
    <span className="who">
      Signed in as <b>{account}</b>
      <button type="button" className="switch" onClick={() => { void w.disconnect().then(w.connect); setLoaded(null); }}>Switch</button>
    </span>
  );

  // ------------------------------------------------------------------ saved
  if (saved) {
    const v = saved.vendor;
    return (
      <>
        <header className="top status"><span>Saved</span>{who}</header>
        <div className="mid">
          <div className="vform" role="status">
            <p className="done">
              Saved. Your clients&apos; Orvantra will pay <span className="m">{account}</span> — {saved.symbol} on {CHAIN_LABEL[saved.chain as Chain] ?? saved.chain}.
            </p>
            <dl className="receipt">
              {v ? <div><dt>Version</dt><dd>{v.version}</dd></div> : null}
              <div><dt>Paid the fee</dt><dd>{saved.paidBy}</dd></div>
              {saved.txHash ? (
                <div><dt>Transaction</dt><dd><a href={explorerTxUrl(network, saved.txHash)}>{shortAddress(saved.txHash)}</a></dd></div>
              ) : null}
            </dl>
            <button type="button" className="again" onClick={() => setSaved(null)}>Edit payout details</button>
          </div>
        </div>
      </>
    );
  }

  // ------------------------------------------------------------------ form
  const loading = loaded !== account;
  return (
    <>
      <header className="top status"><span>Step 2 of 2 · your payout details</span>{who}</header>
      <div className="mid">
        <form className="vform" onSubmit={(e) => { e.preventDefault(); void save(); }} aria-busy={loading || !!busy}>
          <h2 className="lbl">How do you want to be paid?</h2>
          {loadError ? <p className="bad">Your registry entry could not be read: {loadError}</p> : null}
          {existing ? (
            <p className="registered">
              You&apos;re registered — version {existing.version}, last changed {relativeTime(existing.updated_at_ns, now)}.
            </p>
          ) : null}

          <div className="f">
            <label htmlFor="v-name">Business name</label>
            <input id="v-name" value={name} maxLength={MAX_DISPLAY_NAME_CHARS * 2} disabled={loading}
              onChange={(e) => setName(e.target.value)} autoComplete="organization" aria-invalid={!!(name && nameErr)}
              aria-describedby={name && nameErr ? 'v-name-err' : undefined} />
            {name && nameErr ? <p className="hint bad" id="v-name-err">{nameErr}</p> : null}
          </div>

          <div className="f row2">
            <div>
              <label htmlFor="v-chain">Network</label>
              <select id="v-chain" value={chain} disabled={loading} onChange={(e) => onChain(e.target.value as Chain)}>
                {CHAINS.map((c) => (
                  <option key={c} value={c} disabled={(options[c] ?? []).length === 0 && !(existing?.payout.chain === c)}>
                    {CHAIN_LABEL[c]}{(options[c] ?? []).length === 0 ? ' (no USDC route)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="v-token">Token</label>
              <select id="v-token" value={assetId} disabled={loading || tokenList.length === 0} onChange={(e) => setAssetId(e.target.value)}>
                {tokenList.map((t) => <option key={t.assetId} value={t.assetId}>{t.symbol}</option>)}
              </select>
            </div>
          </div>

          <div className="f">
            <label htmlFor="v-addr">Your address on {label}</label>
            <input id="v-addr" className="mono" value={address} disabled={loading} spellCheck={false} autoCapitalize="off" autoComplete="off"
              onChange={(e) => setAddress(e.target.value.trim())} aria-invalid={!!addrErr}
              aria-describedby="v-addr-hint" placeholder={chain === 'near' ? 'acme.near' : undefined} />
            <p className={`hint ${addrErr ? 'bad' : address ? 'ok' : ''}`} id="v-addr-hint" aria-live="polite">
              {addrErr ?? (address ? `Valid ${label} address` : ' ')}
            </p>
          </div>

          {tokensError ? <p className="hint bad">The token list could not be loaded ({tokensError}). Try again in a minute.</p> : null}

          <div className="preview">
            <small>Your clients will see</small>
            <p>
              Pay <span className="m">{account}</span> — {symbol || 'a token'} on {label}, to{' '}
              {address && !addrErr ? shortAddress(address) : '…'}
            </p>
          </div>

          <button className="submit" type="submit" disabled={!canSave}>
            {busy ?? (unchanged ? 'Nothing to change' : existing ? 'Update payout details' : 'Save payout details')}
          </button>
          {error ? (
            <p className="bad" role="alert">
              {error}
              {relayFailed ? <> <button type="button" className="switch" onClick={() => void save(true)}>Pay the fee yourself instead</button></> : null}
            </p>
          ) : null}
          <p className="fine">
            {feeSentence(w.gasless, typicalDeposit == null ? null : BigInt(typicalDeposit))}
            {existing ? <> Payers are alerted when your payout changes. {holdText(minPayoutAgeSec)}</> : null}
          </p>
        </form>
      </div>
    </>
  );
}
