// Public-page links. Pure.

/** NEAR Blocks account page on the configured network. */
export function explorerAccountUrl(network: string, account: string): string {
  return `https://${network === 'mainnet' ? '' : 'testnet.'}nearblocks.io/address/${account}`;
}

const clean = (v: string | undefined): string | null => (v && v.trim() ? v.trim() : null);

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
    // TODO: point at the vendor sign-up page (/register) once it exists.
    vendorUrl: clean(env.NEXT_PUBLIC_VENDOR_URL) ?? registryExplorer,
    repoUrl: clean(env.NEXT_PUBLIC_REPO_URL),
    treasuryExplorer: explorerAccountUrl(c.network, c.treasuryId),
    registryExplorer,
  };
}
