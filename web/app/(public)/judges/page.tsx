import type { Metadata } from 'next';
import Link from 'next/link';
import { publicConfig, publicLinks } from '@/lib/server/config';

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
          <Link className="logo" href="/">Orvantra</Link>
        </header>
        <main className="mid" id="main">
          <Link className="back" href="/"><span className="ar" aria-hidden="true">←</span> Home</Link>
          <h1 className="display judges">Try it in five steps.</h1>
          <p className="lede">
            Everything runs on NEAR {network} against the deployed contracts. Each step says what to do and what you
            should see.
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
            <li><span>Open the app and connect a {network} wallet<small><Ar />owner view; approving needs the treasury owner</small></span></li>
            <li><span>Upload <M>04-acme-changed-bank.png</M><small><Ar />held: &quot;This invoice asks you to pay someone else&quot;</small></span></li>
            <li><span>Upload <M>03-bob-small.png</M><small><Ar />paid automatically, direct to bob on NEAR</small></span></li>
            <li><span>Upload the same invoice again<small><Ar />stopped as a duplicate, nothing sent</small></span></li>
            <li><span>Run <M>npm run prove-key-limits</M> in <M>agent/</M><small><Ar />4 / 4 refused: the agent key can only propose</small></span></li>
          </ol>
        </div>
        <footer className="foot">Questions: see the README&apos;s judging section</footer>
      </section>
    </div>
  );
}
