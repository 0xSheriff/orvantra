// Public-page links. Pure.

/** NEAR Blocks account page on the configured network. */
export function explorerAccountUrl(network: string, account: string): string {
  return `https://${network === 'mainnet' ? '' : 'testnet.'}nearblocks.io/address/${account}`;
}

/** NEAR Blocks transaction page on the configured network. */
export function explorerTxUrl(network: string, hash: string): string {
  return `https://${network === 'mainnet' ? '' : 'testnet.'}nearblocks.io/txns/${hash}`;
}

/** The vendor sign-up page in this app. */
export const VENDOR_PATH = '/register';

const clean =(v: string | undefined): string | null => (v && v.trim() ? v.trim() : null);

export interface SiteLinks {
  /** Where vendors register their payout details. */
  vendorUrl: string;
  /** Public repository; null hides every GitHub link. */
  repoUrl: string | null;
  treasuryExplorer: string;
  registryExplorer: string;
}

export function siteLinks(env: Record<string, string | undefined>, c: { network: string; treasuryId: string; registryId: string }): SiteLinks {
  const registryExplorer = explorerAccountUrl(c.network, c.registryId);
  return {
    vendorUrl: clean(env.NEXT_PUBLIC_VENDOR_URL) ?? VENDOR_PATH,
    repoUrl: clean(env.NEXT_PUBLIC_REPO_URL),
    treasuryExplorer: explorerAccountUrl(c.network, c.treasuryId),
    registryExplorer,
  };
}
