import '@near-wallet-selector/modal-ui/styles.css';
import type { Metadata } from 'next';
import Link from 'next/link';
import { VendorPanel } from '@/components/VendorPanel';
import { WalletProvider } from '@/components/WalletProvider';
import { vendorPageData } from '@/lib/server/vendor';

const TITLE = 'Get paid your way — register your payout details with Orvantra';
const DESCRIPTION =
  "Choose the chain and token you want to receive. Your clients' Orvantra will pay only this address — a fake \"our bank details changed\" email can't move your money.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, type: 'website', siteName: 'Orvantra' },
  twitter: { card: 'summary', title: TITLE, description: DESCRIPTION },
};

/** Vendor sign-up, from the approved mockup design/final-vendor.html. Public: no app sidebar. */
export default async function Register() {
  const data = await vendorPageData();
  return (
    <div className="split vendor">
      <section className="half light">
        <header className="top">
          <Link className="logo" href="/">Orvantra</Link>
        </header>
        <main className="mid" id="main">
          <Link className="back" href="/"><span className="ar" aria-hidden="true">←</span> Home</Link>
          <h1 className="display judges">Get paid your way. Nobody can redirect it.</h1>
          <p className="lede">
            Choose the chain and token you want to receive. Your clients&apos; Orvantra will pay only this address — a
            fake &quot;our bank details changed&quot; email can&apos;t move your money.
          </p>
          <dl className="facts">
            <div><dt>Free with gasless wallets</dt><dd>Orvantra pays the network fee for you. Other wallets pay a tiny fee themselves — under 0.01 NEAR.</dd></div>
            <div><dt>Only you can change it</dt><dd>Changes are signed by your NEAR account. Payers are alerted before paying a new address.</dd></div>
            <div><dt>Put your name on invoices</dt><dd>Write <code className="m">acme.near</code> instead of a long address.</dd></div>
          </dl>
        </main>
        <footer className="foot">Your entry lives in the vendor registry contract on NEAR.</footer>
      </section>

      <section className="half dark" aria-label="Your payout details">
        <WalletProvider
          network={data.network}
          contractId={data.registryId}
          description="Sign in with the NEAR account your clients know you by. Your payout details are saved under it."
        >
          <VendorPanel {...data} />
        </WalletProvider>
        <footer className="foot">Supported: NEAR, Base, Ethereum, Arbitrum, Solana, Tron and more via NEAR Intents</footer>
      </section>
    </div>
  );
}
