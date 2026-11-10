// Which environment variables the agent child process may see. An explicit allowlist: the web server's own secrets
// (TELEGRAM_*, RELAYER_*, ...) are never passed down.

const EXACT = new Set([
  'TREASURY_ID', 'REGISTRY_ID', 'TOKEN_ID', 'AGENT_ID', 'NEARAI_API_KEY', 'PATH', 'HOME', 'NODE_ENV', 'TZ',
  // Non-secret agent settings (not the 1Click JWT): simulated testnet deposit, gas, E2EE switch, 1Click base URL.
  'SIM_DEPOSIT_ACCOUNT', 'SIM_QUOTE_REFUND_TO', 'PROPOSE_GAS_TGAS', 'NEARAI_E2EE', 'ONECLICK_BASE',
]);
const PATTERNS = [/^NEAR_[A-Z0-9_]+$/, /^ORVANTRA_[A-Z0-9_]+$/, /^READER_[A-Z]_(MODEL|BOXES)$/];

export function allowedForAgent(name: string): boolean {
  return EXACT.has(name) || PATTERNS.some((re) => re.test(name));
}

export function filterAgentEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && allowedForAgent(k)) out[k] = v;
  return out;
}
