// Runs the agent pipeline (agent/src/web-run.ts) in its own Node process and yields its NDJSON events.
// NEAR AI Cloud calls, PDF rendering and the agent's function-call key stay inside the agent process.
// One run at a time (proposals share the agent key's nonce and the ledger file), plus at most one waiting.
// If the browser goes away the child is killed, and a run never lasts longer than RUN_TIMEOUT_MS.
import 'server-only';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { Inflight } from '../uploadLimits';
import { AGENT_DIR, agentEnv } from './config';

export type RunMode = 'execute' | 'dry-run' | 'analyze';

export const RUN_TIMEOUT_MS = 5 * 60_000;

/** ORVANTRA_UPLOAD_MODE=dry-run|analyze makes uploads safe for a read-only demo. Default: execute (testnet). */
export function uploadMode(): RunMode {
  const m = process.env.ORVANTRA_UPLOAD_MODE;
  return m === 'dry-run' || m === 'analyze' ? m : 'execute';
}

let queue: Promise<unknown> = Promise.resolve();
const inflight = new Inflight(2);

/** Reserve the single running slot or the single waiting slot; null when both are taken. Pass the result to runAgent. */
export function reserveSlot(): (() => void) | null {
  if (!inflight.enter()) return null;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inflight.leave();
  };
}

export function runAgent(file: string, id: string, originalName: string, mode: RunMode, release: () => void): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let cancelled = false;
  let kill: (() => void) | null = null;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (o: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`${JSON.stringify(o)}\n`));
        } catch {
          closed = true;
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const job = queue.then(() => new Promise<void>((done) => {
        if (cancelled) {
          release();
          done();
          return;
        }
        send({ type: 'step', step: 'queued', state: 'done' });
        const args = [resolve(AGENT_DIR, 'src/web-run.ts'), file, '--id', id, '--name', originalName];
        if (mode === 'execute') args.push('--execute');
        if (mode === 'analyze') args.push('--analyze-only');
        const child = spawn(resolve(AGENT_DIR, 'node_modules/.bin/tsx'), args, { cwd: AGENT_DIR, env: agentEnv() as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
        const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS);
        kill = () => child.kill('SIGKILL');
        let buf = '';
        let stderr = '';
        let ended = false;
        const over = () => {
          clearTimeout(timer);
          kill = null;
          release();
          finish();
          done();
        };
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            try {
              const ev = JSON.parse(line) as { type?: string };
              if (ev.type === 'result' || ev.type === 'error') ended = true;
              send(ev);
            } catch {
              send({ type: 'log', line });
            }
          }
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (c: string) => {
          stderr = (stderr + c).slice(-2000);
        });
        child.on('error', (err) => {
          console.error(`[upload ${id}] could not start the agent: ${err.message}`);
          send({ type: 'error', message: 'The agent could not be started on this server.' });
          over();
        });
        child.on('close', (code) => {
          if (!ended) {
            console.error(`[upload ${id}] agent stopped (exit ${code}): ${stderr.trim().split('\n').at(-1) ?? ''}`);
            send({ type: 'error', message: 'The agent stopped before it finished. Nothing was lost; try again.' });
          }
          over();
        });
      }));
      queue = job.catch(() => {});
    },
    cancel() {
      // The browser disconnected: stop the child (or skip the job if it has not started yet).
      cancelled = true;
      kill?.();
    },
  });
}
