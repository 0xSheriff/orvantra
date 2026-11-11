import type { Metadata } from 'next';
import Link from 'next/link';
import { liveParts } from '@/lib/live';
import { publicConfig, publicLinks } from '@/lib/server/config';
import { getLiveCounts } from '@/lib/server/live';
import { Mark } from '@/components/Mark';

const TITLE = "Orvantra — accounts payable, engineered for trust";
const DESCRIPTION =
  'Orvantra privately reads and verifies invoices, then pays vendors in stablecoins across any chain. Every payment goes exclusively to the vendor\'s registered NEAR address and stays within your predefined spending limits.';

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, type: 'website', siteName: 'Orvantra' },
  twitter: { card: 'summary', title: TITLE, description: DESCRIPTION },
};

const STEPS: [string, string][] = [
  ['You forward an invoice', 'PDF, photo or email'],
  ['Two models read it privately', "inside NEAR AI's secure hardware; both must agree"],
  ["It's checked against the vendor's own record", 'addresses printed on invoices are ignored'],
  ['Your rules decide', 'small known invoices pay themselves; the rest wait for your signature'],
  ['The vendor is paid their way', 'USDC on NEAR, Base, Solana and more via NEAR Intents'],
];

export default async function Home() {
  const { network } = publicConfig();
  const links = publicLinks();
  const live = await getLiveCounts();
  const parts = live ? liveParts(live) : null;

  return (
    <div className="split">
      <section className="half light">
        <header className="top">
          <Link className="logo" href="/"><Mark size={24} />Orvantra</Link>
        </header>
        <main className="mid" id="main">
          <h1 className="display">Accounts payable, engineered for trust.</h1>
          <p className="lede">
            It privately reads and verifies invoices, then pays vendors in stablecoins across any chain. Every payment
            goes exclusively to the vendor&apos;s registered NEAR address and stays within your predefined spending
            limits.
          </p>
          <nav className="doors" aria-label="Start here">
            <Link href="/review">
              <b>Run your treasury</b>
              <span>Review invoices and approve what&apos;s held</span>
              <i className="ar" aria-hidden="true">→</i>
            </Link>
            <a href={links.vendorUrl}>
              <b>Set your payout</b>
              <span>Register how you want to be paid</span>
              <i className="ar" aria-hidden="true">→</i>
            </a>
            <Link href="/judges">
              <b>I&apos;m a judge</b>
              <span>Try it on testnet in five steps</span>
              <i className="ar" aria-hidden="true">→</i>
            </Link>
          </nav>
        </main>
        <footer className="foot">Built on NEAR · NEAR Hackathon 2026</footer>
      </section>

      <section className="half dark" aria-label="How it works">
        <nav className="top menu" aria-label="Site">
          <a href={links.vendorUrl}>For vendors</a>
          <Link href="/judges">For judges</Link>
          <Link href="/proof">Proof</Link>
          {links.repoUrl ? <a href={links.repoUrl}>GitHub</a> : null}
          <Link className="open" href="/review">Open app</Link>
        </nav>
        <div className="mid">
          <h2 className="lbl">How it works</h2>
          <ol className="steps">
            {STEPS.map(([t, s]) => (
              <li key={t}>
                <span>{t}<small>{s}</small></span>
              </li>
            ))}
          </ol>
          <p className="live">
            <span>
              Live on {network}
              {live && parts ? (
                <> · <b>{parts.stopped}</b>, <b>{parts.paid}</b> <span className="nowrap">{live.period}</span></>
              ) : null}
            </span>
            <a href={links.treasuryExplorer}>Explorer <span className="ar">→</span></a>
          </p>
        </div>
        <footer className="foot">NEAR Intents · NEAR AI Cloud · Open source</footer>
      </section>
    </div>
  );
}
