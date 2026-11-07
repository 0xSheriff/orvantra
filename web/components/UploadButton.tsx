'use client';
// "Upload invoice": sends the file to /api/upload and shows the agent's progress as it streams back.
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

type StepId = 'read' | 'check' | 'quote' | 'propose' | 'result';
type StepState = 'waiting' | 'working' | 'done' | 'skipped' | 'failed';

const STEPS: { id: StepId; label: string }[] = [
  { id: 'read', label: 'Reading with two private models' },
  { id: 'check', label: 'Checking registry and limits' },
  { id: 'quote', label: 'Getting 1Click quote' },
  { id: 'propose', label: 'Proposing on-chain' },
  { id: 'result', label: 'Result' },
];

const STATE_TEXT: Record<StepState, string> = { waiting: '', working: 'working', done: 'done', skipped: 'skipped', failed: 'failed' };

interface ResultRecord {
  id: string;
  outcome: string;
  message: string;
  payment_id: number | null;
  payment: { status: string } | null;
  decision: { action: string } | null;
}

function destination(r: ResultRecord): { href: string; text: string } {
  const st = r.payment?.status;
  if (r.payment_id != null && st === 'Pending') return { href: `/review?p=${r.payment_id}`, text: 'Held for your approval.' };
  if (r.payment_id != null && st === 'Paid') return { href: `/invoices?sel=p${r.payment_id}`, text: 'Paid automatically.' };
  if (r.payment_id != null) return { href: `/invoices?sel=p${r.payment_id}`, text: `Payment #${r.payment_id} is ${st?.toLowerCase() ?? 'recorded'}.` };
  if (r.outcome === 'dry-run' || r.outcome === 'analyzed') return { href: `/invoices/u${r.id}`, text: 'Read and checked. Nothing was sent (uploads are in read-only mode).' };
  return { href: `/invoices?sel=u${r.id}`, text: 'Stopped. Nothing was sent.' };
}

export function UploadButton() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState('');
  const [steps, setSteps] = useState<Record<StepId, { state: StepState; detail?: string }>>(() => fresh());
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ href: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function fresh() {
    return Object.fromEntries(STEPS.map((s) => [s.id, { state: 'waiting' as StepState }])) as Record<StepId, { state: StepState; detail?: string }>;
  }

  function setStep(id: StepId, state: StepState, detail?: string) {
    setSteps((prev) => ({ ...prev, [id]: { state, detail: detail ?? prev[id].detail } }));
  }

  async function start(file: File) {
    setName(file.name);
    setSteps(fresh());
    setResult(null);
    setError(null);
    setRunning(true);
    dialog.current?.showModal();
    const body = new FormData();
    body.append('file', file);
    try {
      const res = await fetch('/api/upload', { method: 'POST', body });
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(j?.message ?? `Upload failed (HTTP ${res.status}).`);
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      let finished = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as { type: string; step?: string; state?: string; detail?: string; record?: ResultRecord; message?: string };
          if (ev.type === 'step' && ev.step && STEPS.some((s) => s.id === ev.step)) {
            const map: Record<string, StepState> = { start: 'working', done: 'done', skip: 'skipped', error: 'failed' };
            setStep(ev.step as StepId, map[ev.state ?? ''] ?? 'working', ev.detail);
          } else if (ev.type === 'result' && ev.record) {
            finished = true;
            const dest = destination(ev.record);
            setStep('result', 'done', dest.text);
            setResult(dest);
            router.push(dest.href);
            router.refresh();
          } else if (ev.type === 'error') {
            finished = true;
            setStep('result', 'failed');
            setError(ev.message ?? 'The agent stopped.');
          }
        }
      }
      if (!finished) throw new Error('The connection closed before the agent finished. Check All invoices in a moment.');
    } catch (e) {
      setStep('result', 'failed');
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      if (input.current) input.current.value = '';
    }
  }

  function close() {
    if (running) return;
    dialog.current?.close();
  }

  return (
    <>
      <button type="button" className="upload" onClick={() => input.current?.click()} disabled={running}>
        {running ? 'Reading…' : 'Upload invoice'}
      </button>
      <input
        ref={input}
        type="file"
        accept="application/pdf,image/png,image/jpeg"
        className="sr-only"
        tabIndex={-1}
        aria-label="Invoice file (PDF, PNG or JPEG)"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void start(f);
        }}
      />
      <dialog ref={dialog} className="run" aria-labelledby="run-title" onCancel={(e) => { if (running) e.preventDefault(); }}>
        <div className="head">
          <h2 id="run-title">{running ? 'Reading the invoice' : error ? 'The invoice was not processed' : 'Done'}</h2>
          <p>{name}</p>
        </div>
        <ol aria-live="polite">
          {STEPS.map((s, i) => {
            const st = steps[s.id];
            return (
              <li key={s.id} className={st.state}>
                <span className="pin" aria-hidden="true">{i + 1}</span>
                <div>
                  {s.label}
                  {st.detail ? <span className="det">{st.detail}</span> : null}
                </div>
                <span className="st">{STATE_TEXT[st.state]}</span>
              </li>
            );
          })}
        </ol>
        {error ? <div className="out"><p className="err" role="alert">{error}</p></div> : null}
        <div className="acts">
          <button type="button" className="upload" onClick={close} disabled={running}>
            {running ? 'Working…' : result ? 'Close and see the result' : 'Close'}
          </button>
        </div>
      </dialog>
    </>
  );
}
