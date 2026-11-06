'use client';
// NEAR Wallet Selector (MyNearWallet, Meteor, HERE). Owner actions are signed in the owner's own wallet;
// the server never signs them. Loaded lazily in the browser only.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { WalletSelector } from '@near-wallet-selector/core';
import type { WalletSelectorModal } from '@near-wallet-selector/modal-ui';

export const TGAS = 1_000_000_000_000n;

interface WalletState {
  ready: boolean;
  accountId: string | null;
  /** Set when the selector could not start (e.g. blocked script). */
  error: string | null;
  connect: () => void;
  disconnect: () => Promise<void>;
  /** Calls `method` on the treasury. Browser wallets (MyNearWallet) redirect away and back instead of resolving. */
  call: (o: { method: string; args: object; gas: bigint; deposit: bigint; callbackUrl?: string }) => Promise<string | null>;
}

const Ctx = createContext<WalletState | null>(null);

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWallet outside WalletProvider');
  return v;
}

export function WalletProvider({ network, contractId, children }: { network: string; contractId: string; children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectorRef = useRef<WalletSelector | null>(null);
  const modalRef = useRef<WalletSelectorModal | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    (async () => {
      try {
        const [{ setupWalletSelector }, { setupModal }, { setupMyNearWallet }, { setupMeteorWallet }, { setupHereWallet }] = await Promise.all([
          import('@near-wallet-selector/core'),
          import('@near-wallet-selector/modal-ui'),
          import('@near-wallet-selector/my-near-wallet'),
          import('@near-wallet-selector/meteor-wallet'),
          import('@near-wallet-selector/here-wallet'),
        ]);
        const selector = await setupWalletSelector({
          network: network === 'mainnet' ? 'mainnet' : 'testnet',
          modules: [setupMyNearWallet(), setupMeteorWallet(), setupHereWallet()],
        });
        if (cancelled) return;
        const modal = setupModal(selector, { contractId, description: 'Sign in with the treasury owner account to approve or reject payments.' });
        selectorRef.current = selector;
        modalRef.current = modal;
        const sub = selector.store.observable.subscribe((state) => {
          setAccountId(state.accounts.find((a) => a.active)?.accountId ?? null);
        });
        unsubscribe = () => sub.unsubscribe();
        setReady(true);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [network, contractId]);

  const connect = useCallback(() => modalRef.current?.show(), []);

  const disconnect = useCallback(async () => {
    const s = selectorRef.current;
    if (!s) return;
    const w = await s.wallet();
    await w.signOut();
  }, []);

  const call = useCallback<WalletState['call']>(async ({ method, args, gas, deposit, callbackUrl }) => {
    const s = selectorRef.current;
    if (!s) throw new Error('The wallet is still loading.');
    const { actionCreators } = await import('@near-js/transactions');
    const w = await s.wallet();
    const params = { receiverId: contractId, actions: [actionCreators.functionCall(method, args, gas, deposit)] };
    const outcome = w.type === 'browser'
      ? await w.signAndSendTransaction({ ...params, callbackUrl })
      : await w.signAndSendTransaction(params);
    return outcome && typeof outcome === 'object' && 'transaction' in outcome ? (outcome.transaction as { hash?: string }).hash ?? null : null;
  }, [contractId]);

  const value = useMemo(() => ({ ready, accountId, error, connect, disconnect, call }), [ready, accountId, error, connect, disconnect, call]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
