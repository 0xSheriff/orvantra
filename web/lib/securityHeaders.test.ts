import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, rpcOrigins, securityHeaders } from './securityHeaders.mjs';

const headers = (dev = false) => Object.fromEntries(securityHeaders({ dev, env: {} })[0].headers.map((h) => [h.key, h.value]));

describe('security headers', () => {
  it('sets the fixed headers on every path', () => {
    const rule = securityHeaders({ env: {} })[0];
    expect(rule.source).toBe('/:path*');
    const h = headers();
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(h['Strict-Transport-Security']).toMatch(/^max-age=\d{8,}/);
    expect(h['X-Frame-Options']).toBe('DENY');
  });

  it('CSP forbids framing, plugins and foreign base URIs', () => {
    const csp = headers()['Content-Security-Policy'];
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it('CSP leaves room for the wallet selector, NEAR RPC and wallet pop-ups', () => {
    const csp = headers()['Content-Security-Policy'];
    const connect = csp.split('; ').find((d) => d.startsWith('connect-src '))!;
    for (const host of ['https://rpc.testnet.near.org', 'https://test.rpc.fastnear.com', 'https://*.mynearwallet.com', 'https://*.herewallet.app', 'https://*.meteorwallet.app']) {
      expect(connect).toContain(host);
    }
    expect(csp.split('; ').find((d) => d.startsWith('frame-src '))).toContain('https://*.meteorwallet.app');
    expect(csp.split('; ').find((d) => d.startsWith('img-src '))).toContain('data:');
  });

  it('allows the wallet modal\'s Google Fonts stylesheet and font files', () => {
    const csp = headers()['Content-Security-Policy'].split('; ');
    expect(csp.find((d) => d.startsWith('style-src '))).toContain('https://fonts.googleapis.com');
    expect(csp.find((d) => d.startsWith('font-src '))).toContain('https://fonts.gstatic.com');
  });

  it('allows eval only in development', () => {
    expect(contentSecurityPolicy({ dev: true })).toContain("'unsafe-eval'");
    expect(contentSecurityPolicy()).not.toContain("'unsafe-eval'");
  });

  it('adds https RPC origins from NEAR_RPC_URLS and drops the rest', () => {
    expect(rpcOrigins({ NEAR_RPC_URLS: 'https://rpc.example.com/path, http://insecure.example, nonsense' })).toEqual(['https://rpc.example.com']);
    expect(contentSecurityPolicy({ extraConnect: ['https://rpc.example.com'] })).toContain('https://rpc.example.com');
  });
});
