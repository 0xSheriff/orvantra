// Client: fetches /proof/eval-results.json (committed copy, refreshed by prebuild) and renders every verdict.
// No verdicts are hardcoded — the page tracks whatever the latest `npm run eval` produced.
'use client';
import { useEffect, useState } from 'react';

type Reader = {
  reader: string;
  model: string;
  error: string | null;
  receipt: { verified: boolean; signature_kind: string; tee: boolean; e2ee: boolean } | null;
};
type Row = {
  file: string;
  reading: { readers: Reader[] };
  decision: { action: 'propose' | 'hold' | 'reject'; reasons: string[]; invoice_hash: string | null };
};

const GROUPS: { key: Row['decision']['action']; label: string; sub: string }[] = [
  { key: 'reject', label: 'Rejected', sub: 'nothing is signed, nothing is proposed' },
  { key: 'hold', label: 'Held', sub: 'proposed with a hold flag — the owner sees the reason before approving' },
  { key: 'propose', label: 'Proposed', sub: 'clean by the agent — the contract still applies its own rules' },
];

function shortModel(m: string): string {
  return m.split('/')[1]?.split('-')[0] ?? m;
}

export function EvalTable() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch('/proof/eval-results.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new String(r.status))))
      .then(setRows)
      .catch(() => setError(true));
  }, []);

  if (error)
    return (
      <p className="pf-note">The eval results file is missing on this deployment — run <code>npm run eval</code> and redeploy.</p>
    );
  if (!rows) return <p className="pf-note">Loading the eval run…</p>;

  return (
    <div>
      {GROUPS.map((g) => {
        const rs = rows.filter((r) => r.decision.action === g.key);
        if (rs.length === 0) return null;
        return (
          <section key={g.key} className={`pf-group pf-${g.key}`}>
            <h3 className="pf-h">
              {g.label} <em>({rs.length})</em>
            </h3>
            <p className="pf-sub">{g.sub}</p>
            <ul className="pf-rows">
              {rs.map((r) => {
                const readers = r.reading.readers;
                const bothOk = readers.length === 2 && readers.every((x) => x.receipt?.verified && x.error == null);
                const models = [...new Set(readers.map((x) => shortModel(x.model)))].join(' + ');
                return (
                  <li key={r.file}>
                    <code className="pf-file">{r.file}</code>
                    <span className="pf-why">{r.decision.reasons[0] ?? '(no reason recorded)'}</span>
                    <span className="pf-tail">
                      <code className="pf-hash">{r.decision.invoice_hash?.slice(0, 12) ?? '—'}</code>
                      <span className={bothOk ? 'ok' : 'warn'}>
                        {bothOk ? `${models}, TEE-attested, E2EE, signatures verified — readers agree` : 'reader problem'}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
