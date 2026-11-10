import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filterAgentEnv } from './agentEnv';
import { genericError } from './errors';
import { pruneUploads } from './server/retention';
import {
  Inflight, MAX_BODY_BYTES, MESSAGES, TooLargeError, UploadLimits, declaredTooLarge, expiredUploadIds, maxProposalsPerDay, proposalsToday, readCapped,
} from './uploadLimits';

const MB = 1024 * 1024;

const streamOf = (chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(x); c.close(); } });

describe('size limits', () => {
  it('refuses by content-length before reading anything', () => {
    expect(declaredTooLarge(String(11 * MB))).toBe(true);
    expect(declaredTooLarge(String(10 * MB))).toBe(false);
    expect(declaredTooLarge(null)).toBe(false);
    expect(declaredTooLarge('abc')).toBe(false);
  });

  it('caps the bytes of a body without a trustworthy content-length', async () => {
    const small = await readCapped(streamOf([new Uint8Array(100), new Uint8Array(50)]), 200);
    expect(small.length).toBe(150);
    await expect(readCapped(streamOf([new Uint8Array(150), new Uint8Array(100)]), 200)).rejects.toBeInstanceOf(TooLargeError);
    expect(MAX_BODY_BYTES).toBeGreaterThan(10 * MB);
    expect((await readCapped(null)).length).toBe(0);
  });

  it('stops pulling from a huge stream soon after the cap', async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({ pull(c) { pulled += 1; c.enqueue(new Uint8Array(1024)); } });
    await expect(readCapped(endless, 10 * 1024)).rejects.toBeInstanceOf(TooLargeError);
    expect(pulled).toBeLessThan(20);
  });
});

describe('upload limits', () => {
  it('allows 5 per IP per hour, then says so in a sentence', () => {
    const l = new UploadLimits();
    for (let i = 0; i < 5; i++) expect(l.take('1.1.1.1', 1_000 + i)).toBeNull();
    expect(l.take('1.1.1.1', 2_000)).toBe(MESSAGES.ip);
    expect(l.take('2.2.2.2', 2_000)).toBeNull();
    expect(l.take('1.1.1.1', 1_000 + 3_600_000)).toBeNull();
  });

  it('allows 40 uploads in total per day', () => {
    const l = new UploadLimits();
    let ok = 0;
    for (let i = 0; i < 50; i++) if (l.take(`10.0.0.${i}`, 1_000) === null) ok += 1;
    expect(ok).toBe(40);
    expect(l.take('9.9.9.9', 1_000)).toBe(MESSAGES.global);
    expect(l.take('9.9.9.9', 1_000 + 24 * 3_600_000)).toBeNull();
  });

  it('a visitor over the IP limit does not use up the global allowance', () => {
    const l = new UploadLimits();
    for (let i = 0; i < 5; i++) l.take('1.1.1.1', 1);
    for (let i = 0; i < 100; i++) l.take('1.1.1.1', 2);
    let ok = 0;
    for (let i = 0; i < 40; i++) if (l.take(`10.0.0.${i}`, 3) === null) ok += 1;
    expect(ok).toBe(35); // 40 total minus the 5 that visitor was allowed
  });
});

describe('one running and one waiting job', () => {
  it('admits two, refuses the third, and frees a slot on leave', () => {
    const f = new Inflight(2);
    expect([f.enter(), f.enter(), f.enter()]).toEqual([true, true, false]);
    f.leave();
    expect(f.enter()).toBe(true);
    f.leave(); f.leave(); f.leave();
    expect(f.count).toBe(0);
  });
});

describe('daily proposal cap', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const entry = (at: string, over: Record<string, unknown> = {}) => ({
    network: 'testnet', treasury: 'orvantra-treasury-v4.testnet', tx_hash: 'abc', statuses: [{ at, status: 'proposed' }], ...over,
  });

  it('counts only today\'s on-chain proposals to this treasury', () => {
    const ledger = {
      a: entry('2026-11-10T01:00:00Z'),
      b: entry('2026-11-10T11:00:00Z'),
      c: entry('2026-11-09T23:59:00Z'), // yesterday
      d: entry('2026-11-10T02:00:00Z', { treasury: 'other.testnet' }),
      e: entry('2026-11-10T03:00:00Z', { tx_hash: null }), // dry run, nothing sent
      f: { network: 'testnet', treasury: 'orvantra-treasury-v4.testnet', tx_hash: 'x', statuses: [{ at: '2026-11-10T04:00:00Z', status: 'analyzed:hold' }] },
    };
    expect(proposalsToday(ledger, 'testnet', 'orvantra-treasury-v4.testnet', now)).toBe(2);
  });

  it('reads the cap from ORVANTRA_MAX_PROPOSALS_PER_DAY, default 20', () => {
    expect(maxProposalsPerDay({})).toBe(20);
    expect(maxProposalsPerDay({ ORVANTRA_MAX_PROPOSALS_PER_DAY: '7' })).toBe(7);
    expect(maxProposalsPerDay({ ORVANTRA_MAX_PROPOSALS_PER_DAY: '0' })).toBe(0);
    expect(maxProposalsPerDay({ ORVANTRA_MAX_PROPOSALS_PER_DAY: 'lots' })).toBe(20);
    expect(maxProposalsPerDay({ ORVANTRA_MAX_PROPOSALS_PER_DAY: '' })).toBe(20);
    expect(MESSAGES.proposals(20)).toMatch(/limit of 20 on-chain proposals today/);
  });
});

describe('retention', () => {
  const DAY = 86_400_000;
  const now = Date.parse('2026-11-10T12:00:00Z');
  const id = (ms: number, n = 0) => `${String(ms).padStart(13, '0')}-${n.toString(16).padStart(8, '0')}`;

  it('keeps the newest 300 and drops anything older than 21 days', () => {
    const fresh = Array.from({ length: 305 }, (_, i) => id(now - i * 1000, i));
    const old = id(now - 22 * DAY);
    const doomed = expiredUploadIds([...fresh, old], now);
    expect(doomed).toHaveLength(6); // the 5 beyond 300, plus the old one
    expect(doomed).toContain(old);
    expect(doomed).not.toContain(fresh[0]);
    expect(expiredUploadIds([id(now - 20 * DAY)], now)).toEqual([]);
  });

  it('deletes every file of an expired upload and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orv-ret-'));
    const oldId = id(now - 30 * DAY);
    const newId = id(now - DAY);
    for (const f of [`${oldId}.png`, `${oldId}.json`, `${oldId}.page1.png`, `${newId}.pdf`, `${newId}.json`, 'notes.txt']) writeFileSync(join(dir, f), 'x');
    expect(pruneUploads(dir, now)).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([`${newId}.json`, `${newId}.pdf`, 'notes.txt']);
    expect(pruneUploads(join(dir, 'missing'), now)).toBe(0);
  });
});

describe('agent environment allowlist', () => {
  const env = {
    PATH: '/usr/bin', HOME: '/home/orvantra', NODE_ENV: 'production', TZ: 'UTC',
    NEAR_NETWORK: 'testnet', NEAR_RPC_URLS: 'https://x', TREASURY_ID: 't', REGISTRY_ID: 'r', TOKEN_ID: 'k', AGENT_ID: 'a',
    NEARAI_API_KEY: 'sk', ORVANTRA_KEYS_DIR: '/secrets/keys', ORVANTRA_LEDGER: '/l', READER_A_MODEL: 'm', READER_B_MODEL: 'n',
    TELEGRAM_BOT_TOKEN: 'secret', TELEGRAM_CHAT_ID: '1', RELAYER_KEY_PATH: '/secrets/relayer.json', RELAYER_ID: 'x',
    RELAYER_KEY_JSON_B64: 'secret', AGENT_KEY_JSON_B64: 'secret', ONECLICK_JWT: 'secret', RAILWAY_TOKEN: 'secret', FORTYTWO_API_KEY: 'secret',
  };

  it('passes the agent what it needs', () => {
    const out = filterAgentEnv(env);
    for (const k of ['PATH', 'HOME', 'NODE_ENV', 'TZ', 'NEAR_NETWORK', 'NEAR_RPC_URLS', 'TREASURY_ID', 'REGISTRY_ID', 'TOKEN_ID', 'AGENT_ID', 'NEARAI_API_KEY', 'ORVANTRA_KEYS_DIR', 'ORVANTRA_LEDGER', 'READER_A_MODEL', 'READER_B_MODEL']) {
      expect(out[k], k).toBe((env as Record<string, string>)[k]);
    }
  });

  it('never passes Telegram, relayer or other secrets', () => {
    const out = filterAgentEnv(env);
    for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'RELAYER_KEY_PATH', 'RELAYER_ID', 'RELAYER_KEY_JSON_B64', 'AGENT_KEY_JSON_B64', 'ONECLICK_JWT', 'RAILWAY_TOKEN', 'FORTYTWO_API_KEY']) {
      expect(out, k).not.toHaveProperty(k);
    }
  });
});

describe('generic errors', () => {
  it('has no raw detail', () => {
    expect(genericError(502)).toMatch(/NEAR could not be read/);
    expect(genericError(500)).toMatch(/Something went wrong/);
  });
});
