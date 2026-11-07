import '@near-wallet-selector/modal-ui/styles.css';
import { Sidebar } from '@/components/Sidebar';
import { WalletProvider } from '@/components/WalletProvider';
import { publicConfig } from '@/lib/server/config';

/** The owner app: wallet + sidebar around every page in this group. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pub = publicConfig();
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <WalletProvider network={pub.network} contractId={pub.treasuryId}>
        <div className="app">
          <Sidebar />
          <main id="main">{children}</main>
        </div>
      </WalletProvider>
    </>
  );
}
