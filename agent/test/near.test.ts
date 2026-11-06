// Offline tests for the NEAR RPC client: failover, retry/backoff, per-run view cache. fetch is mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearViewCache, DEFAULT_RETRY, nearConfig, view, type NearConfig, type RpcDeps } from '../src/near.ts';
import { fetchChainState } from '../src/analyze.ts';

const A = 'https://a.example';
const B = 'https://b.example';

/** A successful NEAR RPC body whose view returns `value`. */
const ok = (value: unknown) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: 'orvantra', result: { result: [...Buffer.from(JSON.stringify(value))] } }), { status: 200 });
const status = (code: number, headers: Record<string, string> = {}) => new Response('rate limited', { status: code, headers });

type Handler = (url: string, body: { params: { method_name: string; args_base64: string } }) => Response | Promise<Response>;

function setup(handler: Handler, overrides: Partial<NearConfig> = {}) {
  let clock = 0;
  const sleeps: number[] = [];
  const calls: { url: string; method: string; args: unknown }[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body));
    calls.push({ url, method: body.params.method_name, args: JSON.parse(Buffer.from(body.params.args_base64, 'base64').toString()) });
    return handler(url, body);
  });
  const deps: RpcDeps = {
    fetch: fetchMock as unknown as typeof fetch,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    random: () => 0.5,
    now: () => clock,
  };
  const cfg: NearConfig = { ...nearConfig({}), rpcUrls: [A, B], deps, ...overrides };
  return { cfg, calls, sleeps, advance: (ms: number) => { clock += ms; } };
}

beforeEach(() => clearViewCache());

describe('nearConfig', () => {
  it('defaults to fastnear then near.org for testnet and mainnet', () => {
    expect(nearConfig({}).rpcUrls).toEqual(['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org']);
    expect(nearConfig({ NEAR_NETWORK: 'mainnet' }).rpcUrls).toEqual(['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org']);
  });

  it('reads NEAR_RPC_URLS (comma-separated) and still honours legacy NEAR_RPC_URL', () => {
    expect(nearConfig({ NEAR_RPC_URLS: ` ${A} , ${B},` }).rpcUrls).toEqual([A, B]);
    expect(nearConfig({ NEAR_RPC_URL: A }).rpcUrls).toEqual([A]);
  });

  it('has a 30s view cache by default, configurable via NEAR_VIEW_CACHE_MS', () => {
    expect(nearConfig({}).cacheTtlMs).toBe(30_000);
    expect(nearConfig({ NEAR_VIEW_CACHE_MS: '0' }).cacheTtlMs).toBe(0);
    expect(nearConfig({ NEAR_VIEW_CACHE_MS: 'junk' }).cacheTtlMs).toBe(30_000);
  });
});

describe('view: failover and retry', () => {
  it('fails over to the next endpoint on 429 and remembers the one that worked', async () => {
    const { cfg, calls, sleeps } = setup((url) => (url === A ? status(429) : ok(7)));
    expect(await view<number>(cfg, 'c.testnet', 'm1')).toBe(7);
    expect(calls.map((c) => c.url)).toEqual([A, B]);
    expect(sleeps).toHaveLength(1);
    // Next (different) call goes straight to B.
    expect(await view<number>(cfg, 'c.testnet', 'm2')).toBe(7);
    expect(calls.map((c) => c.url)).toEqual([A, B, B]);
  });

  it('retries 5xx and network errors with exponential backoff + jitter', async () => {
    let n = 0;
    const { cfg, calls, sleeps } = setup(() => {
      n++;
      if (n === 1) throw new TypeError('fetch failed');
      if (n === 2) return status(502);
      if (n === 3) return status(503);
      return ok('done');
    });
    expect(await view<string>(cfg, 'c.testnet', 'm')).toBe('done');
    expect(calls.map((c) => c.url)).toEqual([A, B, A, B]);
    // random()=0.5 -> delay = 0.75 * min(max, base * 2^n): 187.5, 375, 750
    expect(sleeps).toEqual([187.5, 375, 750]);
  });

  it('gives up after maxAttempts (5) with every error in the message', async () => {
    const { cfg, calls, sleeps } = setup(() => status(429));
    await expect(view(cfg, 'c.testnet', 'm')).rejects.toThrow(/failed after 5 attempt\(s\).*a\.example: HTTP 429.*b\.example: HTTP 429/);
    expect(calls).toHaveLength(DEFAULT_RETRY.maxAttempts);
    expect(calls.map((c) => c.url)).toEqual([A, B, A, B, A]);
    expect(sleeps).toHaveLength(4);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(DEFAULT_RETRY.maxDelayMs);
  });

  it('stops early rather than exceed the overall deadline', async () => {
    const { cfg, calls } = setup(() => status(503), {
      retry: { ...DEFAULT_RETRY, maxAttempts: 50, baseDelayMs: 1_000, maxDelayMs: 4_000, deadlineMs: 10_000 },
    });
    await expect(view(cfg, 'c.testnet', 'm')).rejects.toThrow(/failed after/);
    // sleeps 750 + 1500 + 3000 + 3000 = 8250; the next 3000 would cross 10s
    expect(calls).toHaveLength(5);
  });

  it('honours Retry-After (capped at maxDelayMs)', async () => {
    let n = 0;
    const { cfg, sleeps } = setup(() => (++n === 1 ? status(429, { 'retry-after': '1' }) : ok(1)));
    await view(cfg, 'c.testnet', 'm');
    expect(sleeps).toEqual([1_000]);
    clearViewCache();
    n = 0;
    const s2 = setup(() => (++n === 1 ? status(429, { 'retry-after': '120' }) : ok(1)));
    await view(s2.cfg, 'c.testnet', 'm');
    expect(s2.sleeps).toEqual([DEFAULT_RETRY.maxDelayMs]);
  });

  it('does not retry contract errors or 4xx (other than 429)', async () => {
    const panic = setup(() => new Response(JSON.stringify({ result: { error: 'wasm execution failed: MethodNotFound' } }), { status: 200 }));
    await expect(view(panic.cfg, 'c.testnet', 'm')).rejects.toThrow(/MethodNotFound/);
    expect(panic.calls).toHaveLength(1);

    clearViewCache();
    const bad = setup(() => status(400));
    await expect(view(bad.cfg, 'c.testnet', 'm')).rejects.toThrow(/HTTP 400/);
    expect(bad.calls).toHaveLength(1);

    clearViewCache();
    const unknown = setup(() => new Response(JSON.stringify({ error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' } } }), { status: 200 }));
    await expect(view(unknown.cfg, 'c.testnet', 'm')).rejects.toThrow(/UNKNOWN_ACCOUNT/);
    expect(unknown.calls).toHaveLength(1);
  });

  it('retries transient JSON-RPC errors (node timeout) and unparseable bodies', async () => {
    let n = 0;
    const { cfg, calls } = setup(() => {
      n++;
      if (n === 1) return new Response(JSON.stringify({ error: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' } } }), { status: 200 });
      if (n === 2) return new Response('<html>bad gateway</html>', { status: 200 });
      return ok(true);
    });
    expect(await view<boolean>(cfg, 'c.testnet', 'm')).toBe(true);
    expect(calls).toHaveLength(3);
  });
});

describe('view: per-run cache', () => {
  it('serves identical calls from cache (including concurrent in-flight ones)', async () => {
    const { cfg, calls } = setup(() => ok({ x: 1 }));
    const [a, b] = await Promise.all([view(cfg, 'c.testnet', 'm', { k: 1 }), view(cfg, 'c.testnet', 'm', { k: 1 })]);
    expect(await view(cfg, 'c.testnet', 'm', { k: 1 })).toEqual({ x: 1 });
    expect(a).toEqual(b);
    expect(calls).toHaveLength(1);
  });

  it('keys on contract, method and args', async () => {
    const { cfg, calls } = setup(() => ok(0));
    await view(cfg, 'c.testnet', 'm', { k: 1 });
    await view(cfg, 'c.testnet', 'm', { k: 2 });
    await view(cfg, 'c.testnet', 'other', { k: 1 });
    await view(cfg, 'd.testnet', 'm', { k: 1 });
    expect(calls).toHaveLength(4);
  });

  it('expires entries after the TTL', async () => {
    const { cfg, calls, advance } = setup(() => ok(0));
    await view(cfg, 'c.testnet', 'm');
    advance(29_999);
    await view(cfg, 'c.testnet', 'm');
    expect(calls).toHaveLength(1);
    advance(1);
    await view(cfg, 'c.testnet', 'm');
    expect(calls).toHaveLength(2);
  });

  it('never caches failures', async () => {
    let fail = true;
    const { cfg, calls } = setup(() => (fail ? status(400) : ok('fresh')));
    await expect(view(cfg, 'c.testnet', 'm')).rejects.toThrow();
    fail = false;
    expect(await view(cfg, 'c.testnet', 'm')).toBe('fresh');
    expect(calls).toHaveLength(2);
  });

  it('can be disabled with cacheTtlMs = 0', async () => {
    const { cfg, calls } = setup(() => ok(0), { cacheTtlMs: 0 });
    await view(cfg, 'c.testnet', 'm');
    await view(cfg, 'c.testnet', 'm');
    expect(calls).toHaveLength(2);
  });
});

describe('fetchChainState fail-safe', () => {
  it('records an error (=> hold) when every endpoint keeps rate-limiting', async () => {
    const { cfg } = setup(() => status(429));
    const s = await fetchChainState(cfg, 'orvantra-acme.testnet', 'ab'.repeat(32));
    expect(s.error).toMatch(/failed after \d attempt.*HTTP 429/);
    expect(s.config).toBe(null);
  });
});
