// Raw errors (RPC URLs, stack text, file paths) stay in the server log; the browser gets a short generic sentence.
import 'server-only';
import { genericError } from '../errors';

export function failJson(tag: string, e: unknown, status = 502): Response {
  console.error(`[${tag}] ${e instanceof Error ? e.message : String(e)}`.slice(0, 500));
  return Response.json({ error: genericError(status) }, { status, headers: { 'cache-control': 'no-store' } });
}
