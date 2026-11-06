import { resolve } from 'node:path';

// The repo root is the workspace root: web/ imports the agent's light modules (NEAR views, ledger, records, types)
// through the local package `orvantra-agent` (file:../agent), compiled from TypeScript source.
const root = resolve(import.meta.dirname, '..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['orvantra-agent'],
  turbopack: { root },
  outputFileTracingRoot: root,
  poweredByHeader: false,
  reactStrictMode: true,
  devIndicators: false,
};

export default nextConfig;
