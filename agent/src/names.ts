// Vendor-name comparison (invoice vs registry display_name). Pure.

/** Words that carry no identity: legal forms and glue words. */
const NOISE = new Set([
  'ltd', 'limited', 'inc', 'incorporated', 'llc', 'llp', 'plc', 'corp', 'corporation', 'co', 'company', 'gmbh', 'ag',
  'sa', 'sas', 'srl', 'bv', 'nv', 'pty', 'pvt', 'lda', 'oy', 'ab', 'the', 'and', 'of', 'de', 'la', 'le', 'el',
]);

/** Lowercase, diacritics removed (NFKD), punctuation to spaces, split into words. */
export function nameTokens(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean);
}

/** Edit distance <= 1 (insert, delete, substitute) between two strings. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}

const sameToken = (a: string, b: string) => a === b || (a.length >= 5 && b.length >= 5 && withinOneEdit(a, b));

/**
 * Token-set match, case- and diacritics-insensitive: every word of the shorter name (legal forms ignored) must be
 * a word of the longer one, so "Acme" matches "ACME Design Studio Ltd" and "Café Müller GmbH" matches
 * "Cafe Muller", but "Acme" does not match "Evil Corp". Words of 5+ letters may differ by one typo.
 * An empty name never matches.
 */
export function vendorNamesMatch(invoiceName: string, registryName: string): boolean {
  const tokens = (n: string) => {
    const all = nameTokens(n);
    const core = all.filter((t) => !NOISE.has(t));
    return core.length ? core : all;
  };
  const a = tokens(invoiceName);
  const b = tokens(registryName);
  if (a.length === 0 || b.length === 0) return false;
  const [small, large] = a.length <= b.length ? [a, b] : [b, a];
  return small.every((t) => large.some((u) => sameToken(t, u)));
}

/** One printable line of attacker-controlled text: control and zero-width characters removed, whitespace collapsed, capped. */
export function oneLine(text: string, max = 80): string {
  const clean = text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...clean];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : clean;
}
