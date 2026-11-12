// The kept original for every treasury payment on orvantra-treasury-v6.testnet, by on-chain invoice_hash.
// These payments were proposed outside the web app (CLI pipeline), so no upload record links them to a file.
// Hashes read back live from the treasury 2026-11-12. Files: agent/fixtures/ (B-0007 is a render of the kept PDF).
export const KEPT_ORIGINALS: Record<string, string> = {
  '20cf49f13a2f23b21b7bc5bdf92928e7e67e2a2e79b61a04f0eb388aa0a95924': '01-harboroak-furniture.png',
  'c587fb3c57c37d6e335729a4fa36f439073a420c34b2b57f8ba49f40b3e5eaaf': '02-cloudline-hosting.png',
  'd3b3cc5103798294c99071f0ec40183e6eec7527ab14fbef71e9383421c4e4d4': '03-meridian-shipment.png',
  '23c8175f529610c77121cc419a58370e3db72202869c53ffa8441459c9f83597': '04-harboroak-workshop.png',
  '0e62fa47bf00f0ba70cc91c720bf41e914747e0d877a8361595e913ddb78fe5a': '05-cloudline-seats.png',
  '81cc36cfaecff89c6a1f2ace33f6b699a91e3d52ef84f898ac07402f235a6965': '06-meridian-storage.png',
  '51ef28709f99f35b6052b4a05246af1af7dfa723c0cff45e93bfc512cf44176a': '07-harboroak-dining.png',
  'abaddfa21fb30f02e303978da0ebce0d964caf6e83af5c131a6e0f752c509a99': '08-cloudline-migration.png',
  '6b8c6790ceb0b64c4bed1dd59184487c251177226a56a2d917acedac66a738cc': '09-meridian-coldchain.png',
  'a294a49c3ab51018694424abd01269beae3c0113a0f502b11d790ce5b771c230': '10-cloudline-audit.png',
  // The four pre-existing All-invoices originals, so they still show even if the agent's ledger volume is wiped.
  '0870bb0d76d3b5d1edae23b07c74dd0ab3b317456ed86e0d788c456c3b4ffcad': '02-bob-normal-page1.png',
  '6bee355b4701d6f3dbb6d84191ccc667506dabf6fcbb619b5c3b2ec58031155f': '03-bob-small.png',
  '5f9fbb3a40f8ae123dc1880f2410c2b8378fb778cd45c2084dcb6ce5fef2a2a4': '05-acme-duplicate.png',
  'e285808d95752c128f35b665fd04a31bb6886eda12203f40faacc83b3107c44f': '04-acme-changed-bank.png',
};

export function keptOriginal(invoiceHash: string | null): string | null {
  return invoiceHash ? KEPT_ORIGINALS[invoiceHash] ?? null : null;
}
