'use client';
import { useWallet } from './WalletProvider';

export function WalletStatus({ owner }: { owner: string | null }) {
  const w = useWallet();
  if (w.error) return <div className="wallet">Wallet unavailable: {w.error}</div>;
  if (!w.accountId) {
    return (
      <div className="wallet">
        <button type="button" className="linkbtn" onClick={w.connect} disabled={!w.ready}>
          {w.ready ? 'Connect wallet' : 'Loading wallet…'}
        </button>
      </div>
    );
  }
  return (
    <div className="wallet">
      {owner && w.accountId === owner ? 'Signed in as the owner' : 'Signed in as'}
      <span className="who">{w.accountId}</span>
      <button type="button" className="linkbtn quiet" onClick={() => void w.disconnect()}>Disconnect</button>
    </div>
  );
}
