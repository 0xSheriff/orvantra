import type { Metadata } from 'next';
import Link from 'next/link';
import { publicConfig, publicLinks } from '@/lib/server/config';
import { Mark } from '@/components/Mark';
import { EvalTable } from '@/components/ProofEval';

const TITLE = 'Proof of everything — verify Orvantra on-chain';
const DESCRIPTION =
  'Every claim on one page: 15 invoice verdicts from the live eval run, five on-chain contract refusals with tx links, and the mainnet cross-chain proof.';

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, type: 'website', siteName: 'Orvantra' },
  twitter: { card: 'summary', title: TITLE, description: DESCRIPTION },
};

const TX = (h: string) => `https://testnet.nearblocks.io/txns/${h}`;

const REFUSALS = [
  {
    title: 'Payout changed — the contract will hold it',
    body: (
      <>
        Owner raised <code className="m">min_payout_age</code> to 3600 s, then Acme changed its payout on the registry (
        <a href={TX('E3RbWQmTHrYYp53GQyRrVoSKSHjRunvDedXSXbFuRVb1')}>tx</a>). The agent read the live chain and predicted
        before signing: <em>&ldquo;will be held by contract: payout changed less than 3600s ago&rdquo;</em>. The treasury enforces the
        payout-age itself — a changed address can never settle before it is old enough.
      </>
    ),
  },
  {
    title: 'Over the vendor monthly cap — refused on-chain',
    body: (
      <>
        The agent&rsquo;s real <a href={TX('Ak4forTB56S6DQsaZUaJNFWaDMfY37ah2jn3NgoPxSWt')}>propose_payment</a> transaction
        failed with <code className="m">Smart contract panicked: over vendor monthly cap</code>. The cap is in the
        contract, not the agent.
      </>
    ),
  },
  {
    title: 'Over the treasury monthly cap — refused on-chain',
    body: (
      <>
        Same, at the treasury level: <a href={TX('H3XvhxzgPxYaEe8nb3pkdu82n4kWrSNb8yCzZsFQ45vL')}>tx</a> failed with{' '}
        <code className="m">over treasury monthly cap</code>.
      </>
    ),
  },
  {
    title: 'Paused — refused on-chain',
    body: (
      <>
        The owner paused the treasury (<code className="m">pause()</code>); the agent&rsquo;s{' '}
        <a href={TX('CkniDBhcZsfPygkNeFCaPPfcDK4sPV541s8RQhvVzQxd')}>propose_payment</a> failed with{' '}
        <code className="m">treasury is paused</code>.
      </>
    ),
  },
  {
    title: 'Policy removed — rejected before signing',
    body: (
      <>
        The owner removed Bob&rsquo;s policy (<a href={TX('5gv91hLrWGVgTsSxyAoa3szqAUtykgskWCJ8F783qNcx')}>tx</a>). On the
        next invoice the agent rejected it client-side — <em>&ldquo;vendor orvantra-bob.testnet is not approved in the
        treasury policy&rdquo;</em> — and signed nothing.
      </>
    ),
  },
];

export default function Proof() {
  const { network, treasuryId, registryId } = publicConfig();
  const links = publicLinks();
  return (
    <div className="split">
      <section className="half light">
        <header className="top">
          <Link className="logo" href="/"><Mark size={24} />Orvantra</Link>
        </header>
        <main className="mid" id="main">
          <Link className="back" href="/"><span className="ar" aria-hidden="true">←</span> Home</Link>
          <h1 className="display judges">Proof of everything.</h1>
          <p className="lede">
            Every claim Orvantra makes, on one page, in two forms: the live eval run&rsquo;s verdicts (fetched from the
            actual JSON), and on-chain transactions you can open yourself. Nothing below is a screenshot.
          </p>
          <nav className="doors links" aria-label="Verify">
            <a href={links.treasuryExplorer}>
              <b>Treasury contract on the explorer</b>
              <i className="ar" aria-hidden="true">→</i>
            </a>
            <a href={links.registryExplorer}>
              <b>Vendor registry on the explorer</b>
              <i className="ar" aria-hidden="true">→</i>
            </a>
            <Link href="/judges">
              <b>Or try it yourself</b>
              <i className="ar" aria-hidden="true">→</i>
            </Link>
          </nav>
        </main>
        <footer className="foot">Network: {network} · Treasury: {treasuryId} · Registry: {registryId}</footer>
      </section>

      <section className="half dark" aria-label="Evidence">
        <nav className="top menu" aria-label="Site">
          <Link href="/judges">Try it in steps</Link>
          <Link className="open" href="/review">Open app</Link>
        </nav>
        <div className="mid">
          <h2 className="lbl">1 · The eval — 15 invoices, two TEE readers, live chain views</h2>
          <p className="pf-lede">
            Each fixture goes through both NEAR AI Cloud readers (provider-TEE-attested, E2EE, signatures verified) and
            read-only views of the live registry and the eval&rsquo;s target treasury,{' '}
            <code className="m">orvantra-treasury-v4.testnet</code>. The table below is fetched from{' '}
            <code className="m">agent/eval-results.json</code> — the output of <code className="m">npm run eval</code>{' '}
            as of the last deploy.
          </p>
          <EvalTable />

          <h2 className="lbl pf-h2">2 · The contract refuses the agent — five real transactions</h2>
          <ol className="steps">
            {REFUSALS.map((r) => (
              <li key={r.title}>
                <span>{r.title}<small>{r.body}</small></span>
              </li>
            ))}
          </ol>
          <p className="pf-note">
            All five ran on {treasuryId} on 2026-11-11; every setting the demo changed was restored afterwards (tx
            hashes in <code className="m">docs/DEPLOYMENTS.md</code>).
          </p>

          <h2 className="lbl pf-h2">3 · Mainnet and wallet proofs</h2>
          <ol className="steps">
            <li>
              <span>Cross-chain delivery, mainnet, real money
                <small>
                  0.45 NEAR left <code className="m">orvantra.near</code> and 1.607589 USDC arrived on Base through NEAR
                  Intents (1Click) — <a href="https://explorer.near.org/transactions/AD8QDvGKJTx8f3sjQM5XB9GYaiXrisAXRzYewAy4Lo7n">NEAR tx</a>{' '}
                  + <a href="https://basescan.org/tx/0x4abc3615397620258189036353e909f47044ba784461c8c8c0ed7003fdeac3fb">Base tx</a>.
                  The product flow itself is testnet (Intents has no testnet); this proves the primitive.
                </small>
              </span>
            </li>
            <li>
              <span>Rules changed from a browser wallet
                <small>
                  On 2026-11-11 the owner signed <code className="m">set_vendor_policy</code> in the browser from{' '}
                  <code className="m">/rules</code> — the server never held the signature. On-chain result: a 200.00 /
                  200.00 policy for <code className="m">orvantra.testnet</code> on {treasuryId} (readable via{' '}
                  <code className="m">get_vendor_policy</code>; all actions on the{' '}
                  <a href={links.treasuryExplorer}>treasury account</a>).
                </small>
              </span>
            </li>
            <li>
              <span>The agent key can only propose
                <small>
                  <code className="m">orvantra-agent.testnet</code> holds a function-call key scoped to{' '}
                  <code className="m">propose_payment</code> on {treasuryId} with a 0.24 NEAR allowance — visible on the{' '}
                  <a href="https://testnet.nearblocks.io/accounts/orvantra-agent.testnet">agent account page</a>. Running{' '}
                  <code className="m">npm run prove-key-limits</code> in <code className="m">agent/</code> gets 4/4 refusals
                  from the network.
                </small>
              </span>
            </li>
          </ol>
        </div>
        <footer className="foot">
          Reproduce: <code className="m">cd agent &amp;&amp; npm ci &amp;&amp; npm run eval</code> — 15/15, real TEE readers.
        </footer>
      </section>
    </div>
  );
}
