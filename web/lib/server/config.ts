// Server-only configuration. The repo-root .env is loaded here at runtime (never bundled, never sent to the browser).
// Only the non-secret ids in `publicConfig()` ever reach client components.
import 'server-only';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { nearConfig, type NearConfig } from 'orvantra-agent/near';
import { filterAgentEnv } from '../agentEnv';
import { siteLinks, type SiteLinks } from '../links';

export const REPO_ROOT = process.env.ORVANTRA_ROOT ?? resolve(process.cwd(), '..');
export const AGENT_DIR = resolve(REPO_ROOT, 'agent');

const envFile = resolve(REPO_ROOT, '.env');
if (existsSync(envFile)) dotenv.config({ path: envFile, quiet: true });

export const DEFAULT_TREASURY = 'orvantra-treasury-v6.testnet';
export const DEFAULT_REGISTRY = 'orvantra-registry.testnet';

export interface ServerConfig {
  network: string;
  treasuryId: string;
  registryId: string;
  /** null = read it from the treasury config */
  tokenId: string | null;
  ledgerPath: string;
  filesDir: string;
  fixturesDir: string;
  /** Fresh judge invoices: never processed on any treasury, separate from the live All-invoices runs. */
  judgesFixturesDir: string;
}

export function serverConfig(): ServerConfig {
  const e = process.env;
  const ledgerPath = e.ORVANTRA_LEDGER ?? resolve(AGENT_DIR, 'data/ledger.json');
  return {
    network: e.NEAR_NETWORK ?? 'testnet',
    treasuryId: e.TREASURY_ID ?? DEFAULT_TREASURY,
    registryId: e.REGISTRY_ID ?? DEFAULT_REGISTRY,
    tokenId: e.TOKEN_ID ?? null,
    ledgerPath,
    filesDir: e.ORVANTRA_FILES_DIR ?? resolve(AGENT_DIR, 'data/files'),
    fixturesDir: resolve(AGENT_DIR, 'fixtures'),
    judgesFixturesDir: e.ORVANTRA_JUDGES_FIXTURES_DIR ?? resolve(AGENT_DIR, 'fixtures-judges'),
  };
}

/** Env for the agent child process: an explicit allowlist (lib/agentEnv.ts), plus the web app's network/contract ids. */
export function agentEnv(): Record<string, string> {
  const c = serverConfig();
  return {
    ...filterAgentEnv(process.env),
    NEAR_NETWORK: c.network,
    TREASURY_ID: c.treasuryId,
    REGISTRY_ID: c.registryId,
    ORVANTRA_LEDGER: c.ledgerPath,
    ORVANTRA_FILES_DIR: c.filesDir,
  };
}

/** NEAR view config. `fresh` disables the per-process view cache (used when polling a payment). */
export function near(fresh = false): NearConfig {
  const c = serverConfig();
  return nearConfig({
    ...process.env,
    NEAR_NETWORK: c.network,
    TREASURY_ID: c.treasuryId,
    REGISTRY_ID: c.registryId,
    NEAR_VIEW_CACHE_MS: fresh ? '0' : process.env.NEAR_VIEW_CACHE_MS ?? '5000',
  });
}

export interface PublicConfig {
  network: string;
  treasuryId: string;
  registryId: string;
}

export function publicConfig(): PublicConfig {
  const c = serverConfig();
  return { network: c.network, treasuryId: c.treasuryId, registryId: c.registryId };
}

/** Links for the public pages (read at request time, after the repo-root .env is loaded). */
export function publicLinks(): SiteLinks {
  return siteLinks(process.env, serverConfig());
}
