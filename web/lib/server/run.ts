// Runs the agent pipeline (agent/src/web-run.ts) in its own Node process and yields its NDJSON events.
// NEAR AI Cloud calls, PDF rendering and the agent's function-call key stay inside the agent process.
// One run at a time: proposals share the agent key's nonce and the ledger file.
import 'server-only';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { AGENT_DIR, agentEnv } from './config';

export type RunMode = 'execute' | 'dry-run' | 'analyze';

/** ORVANTRA_UPLOAD_MODE=dry-run|analyze makes uploads safe for a read-only demo. Default: execute (testnet). */
export function uploadMode(): RunMode {
  const m = process.env.ORVANTRA_UPLOAD_MODE;
  return m === 'dry-run' || m === 'analyze' ? m : 'execute';
}

let queue: Promise<unknown> = Promise.resolve();

export function runAgent(file: string, id: string, originalName: string, mode: RunMode): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (o: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`${JSON.stringify(o)}\n`));
        } catch {
          closed = true; // client went away; the run continues and its record is still written
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
        send({ type: 'step', step: 'queued', state: 'done' });
        const args = [resolve(AGENT_DIR, 'src/web-run.ts'), file, '--id', id, '--name', originalName];
        if (mode === 'execute') args.push('--execute');
        if (mode === 'analyze') args.push('--analyze-only');
        const child = spawn(resolve(AGENT_DIR, 'node_modules/.bin/tsx'), args, { cwd: AGENT_DIR, env: agentEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
        let buf = '';
        let stderr = '';
        let ended = false;
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
          send({ type: 'error', message: `could not start the agent: ${err.message}` });
          finish();
          done();
        });
        child.on('close', (code) => {
          if (!ended) send({ type: 'error', message: `the agent stopped (exit ${code})${stderr ? `: ${stderr.trim().split('\n').at(-1)}` : ''}` });
          finish();
          done();
        });
      }));
      queue = job.catch(() => {});
    },
  });
}
