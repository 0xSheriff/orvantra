// Prints the on-chain state the checks depend on (read-only). Usage: npx tsx scripts/chain-state.ts [vendor...]
import * as near from '../src/near.ts';

const cfg = near.nearConfig();
const vendors = process.argv.slice(2).length ? process.argv.slice(2) : ['orvantra-harboroak.testnet', 'orvantra-cloudline.testnet', 'orvantra-meridian.testnet', 'orvantra-tidewater.testnet'];
console.log('config', await near.getConfig(cfg));
for (const v of vendors) {
  console.log(v, {
    registry: await near.getVendor(cfg, v),
    payout_age_ns: await near.getPayoutAgeNs(cfg, v),
    policy: await near.getVendorPolicy(cfg, v),
    monthly_spent: await near.getMonthlySpent(cfg, v),
  });
}
for (const p of await near.getPayments(cfg)) {
  console.log(`#${p.id} ${p.vendor} ${p.amount} ${p.status} memo=${p.memo ?? '-'} direct=${p.direct} reasons=${JSON.stringify(p.reasons)}`);
}
