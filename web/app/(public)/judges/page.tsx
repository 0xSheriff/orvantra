import type { Metadata } from 'next';
import Link from 'next/link';
import { publicConfig, publicLinks } from '@/lib/server/config';
import { Mark } from '@/components/Mark';

const TITLE = 'For judges — try Orvantra in five steps';
const DESCRIPTION =
  'Everything runs on NEAR testnet against the deployed contracts. Download the test invoices, upload them in the app, and see what Orvantra pays, holds and stops.';

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, type: 'website', siteName: 'Orvantra' },
  twitter: { card: 'summary', title: TITLE, description: DESCRIPTION },
};

const M = ({ children }: { children: React.ReactNode }) => <code className="m">{children}</code>;
const Ar = () => <><span className="ar">→</span>{' '}</>;

export default function Judges() {
  const { network, treasuryId } = publicConfig();
  const links = publicLinks();
  return (
    <div className="split">
      <section className="half light">
        <header className="top">
          <Link className="logo" href="/"><Mark size={24} />Orvantra</Link>
        </header>
        <main className="mid" id="main">
          <Link className="back" href="/"><span className="ar" aria-hidden="true">←</span> Home</Link>
          <h1 className="display judges">Try it in five steps.</h1>
          <p className="lede">
            Everything runs on NEAR {network} against <M>{treasuryId}</M>. Each step says what to do and what you
            should see. The zip holds ten fresh invoices from three vendors you won&rsquo;t find on the All invoices
            page — the first upload of each gives the full path, and re-uploading demos the duplicate guard.
          </p>
          <nav className="doors links" aria-label="Resources">
            <a href="/judges/test-invoices.zip" download>
              <b>Download the test invoices</b>
              <i aria-hidden="true">↓</i>
            </a>
            {links.repoUrl ? (
              <a href={links.repoUrl}>
                <b>README on GitHub</b>
                <i className="ar" aria-hidden="true">→</i>
              </a>
            ) : null}
            <a href={links.treasuryExplorer}>
              <b>Contracts on the explorer</b>
              <i className="ar" aria-hidden="true">→</i>
            </a>
          </nav>
        </main>
        <footer className="foot">Network: {network} · Treasury: {treasuryId}</footer>
      </section>

      <section className="half dark" aria-label="Do this, see that">
        <nav className="top menu" aria-label="Site">
          <Link className="open" href="/review">Open app</Link>
        </nav>
        <div className="mid">
          <h2 className="lbl">Do this <span className="ar">→</span> see that</h2>
          <ol className="steps checks">
            <li><span>Open the app and connect a {network} wallet<small><Ar />owner view is <M>orvantra.testnet</M>; anyone can upload and watch the stream</small></span></li>
            <li><span>Upload <M>01-novatech-retainer.png</M><small><Ar />proposed: two TEE readers agree, the contract holds it (first payment to NovaTech) — the owner approves it in their own wallet and the money settles to the vendor&rsquo;s own NEAR account</small></span></li>
            <li><span>Upload <M>05-greenleaf-irrigation.png</M><small><Ar />proposed and held with two reasons: over the 100 auto-pay threshold, and first payment to GreenLeaf</small></span></li>
            <li><span>Upload <M>01-novatech-retainer.png</M> again<small><Ar />rejected before signing: its invoice hash is already on-chain (duplicate guard)</small></span></li>
            <li><span>Run <M>npm run prove-key-limits</M> in <M>agent/</M><small><Ar />4 / 4 refused by the network: the agent key can only propose</small></span></li>
          </ol>
          <p className="pf-note">Every claim, with tx links and the full 15-fixture verdict table: <Link href="/proof">proof of everything →</Link></p>
        </div>
        <footer className="foot">Questions: see the README&apos;s &ldquo;Do this → see this&rdquo; section</footer>
      </section>
    </div>
  );
}
