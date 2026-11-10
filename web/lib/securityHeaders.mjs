// Security headers for every response (used by next.config.mjs; plain .mjs so the config can import it).
// The CSP has to leave room for: Next's inline bootstrap scripts, the NEAR wallet selector (MyNearWallet, Meteor, HERE:
// RPC calls, wallet popups/iframes, wallet icons as data: images) and the NEAR RPC endpoints the app reads.

/** Hosts the browser may call (fetch / WebSocket) besides this site. */
export const CONNECT_HOSTS = [
  'https://rpc.testnet.near.org', 'https://rpc.mainnet.near.org', 'https://archival-rpc.mainnet.near.org', 'https://archival-rpc.testnet.near.org',
  'https://test.rpc.fastnear.com', 'https://free.rpc.fastnear.com', 'https://rpc.fastnear.com',
  'https://*.near.org', 'https://*.fastnear.com', 'https://*.nearblocks.io',
  'https://*.mynearwallet.com', 'https://*.herewallet.app', 'wss://*.herewallet.app', 'https://*.meteorwallet.app',
  'https://*.near.dev', 'https://*.near.link',
];

/** Wallet pop-ups and embedded wallet pages. */
export const FRAME_HOSTS = ['https://*.mynearwallet.com', 'https://*.herewallet.app', 'https://*.meteorwallet.app', 'https://wallet.meteorwallet.app'];

/** `extraConnect`: more RPC origins (from NEAR_RPC_URLS). `dev` adds what React's dev tooling needs. */
export function contentSecurityPolicy({ dev = false, extraConnect = [] } = {}) {
  const directives = {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])],
    // The wallet selector's modal stylesheet imports Inter from Google Fonts.
    'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
    'connect-src': ["'self'", ...CONNECT_HOSTS, ...extraConnect, ...(dev ? ['ws:', 'http://localhost:*'] : [])],
    'frame-src': FRAME_HOSTS,
    'frame-ancestors': ["'none'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'worker-src': ["'self'", 'blob:'],
  };
  return Object.entries(directives).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
}

/** Origins of NEAR_RPC_URLS (comma separated), for the CSP. Invalid entries are dropped. */
export function rpcOrigins(env = process.env) {
  return (env.NEAR_RPC_URLS ?? env.NEAR_RPC_URL ?? '').split(',').map((s) => s.trim()).filter(Boolean).flatMap((u) => {
    try {
      const url = new URL(u);
      return url.protocol === 'https:' ? [url.origin] : [];
    } catch {
      return [];
    }
  });
}

/** The Next.js `headers()` value: one rule for every path. */
export function securityHeaders({ dev = false, env = process.env } = {}) {
  return [
    {
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: contentSecurityPolicy({ dev, extraConnect: rpcOrigins(env) }) },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ],
    },
  ];
}
