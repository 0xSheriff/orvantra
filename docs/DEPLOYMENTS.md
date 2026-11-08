# Deployments

## Testnet (dev accounts, faucet-funded; keys in ~/.near-credentials/testnet, never committed)
| Contract / role | Account | Notes |
|---|---|---|
| vendor-registry | `orvantra-registry.testnet` | deployed 2026-11-06, tx GmqW7LpFonQe1aegRqeey6Wss8Vy2wBvP7fR6kpMFypT |
| test vendor | `orvantra-acme.testnet` | payout USDC on Base, version 2 after change test |
| test second vendor | `orvantra-bob.testnet` | proves vendors can only edit their own entry; payout set to tUSDC on NEAR for the direct path |
| test token (tUSDC) | `orvantra-tusdc.testnet` | NEP-141, 6 decimals |
| treasury (Day 3 contract) | `orvantra-treasury.testnet` | owner `orvantra-owner.testnet`, agent `orvantra-agent.testnet`; holds Bob's earlier payment history |
| treasury v2 (Day 5 contract) | `orvantra-treasury-v2.testnet` | **planned**: `scripts/testnet-day5.sh` (fresh state, agent_flags + storage_deposit chain) |
| simulated 1Click deposit | `orvantra-1click-sim.testnet` | **planned**: stand-in deposit address for cross-chain payouts on testnet |

Treasury e2e (`scripts/testnet-e2e.sh`), verified 2026-11-06: #0 first payment + fresh payout -> Pending -> owner
approved -> Paid; #1 5 tUSDC auto-paid; #2 150 tUSDC over threshold -> Pending -> approved -> Paid; duplicate
invoice rejected; 400 > max_per_invoice rejected; vendor monthly cap rejected.

Live check performed: register -> view -> other account cannot alter -> invalid EVM address rejected
("address must be 0x followed by 40 hex chars") -> payout change bumps version 1 -> 2.

## Mainnet
Not deployed. Requires explicit owner approval.

## Day 5 (2026-11-06) — treasury v2 + restricted agent key
| Contract / role | Account | Notes |
|---|---|---|
| treasury v2 | `orvantra-treasury-v2.testnet` | agent_flags + storage_deposit before every payout |
| 1Click stand-in | `orvantra-1click-sim.testnet` | SIMULATED deposit address (testnet has no NEAR Intents) |
| agent key | `ed25519:4NZW8ukRXJimdYcuhV1pQAw4EBsAi1HdvDTHgiRxVrFP` on `orvantra-agent.testnet` | function-call only: `propose_payment` on treasury v2, 0.25 NEAR allowance |

Verified run (`scripts/testnet-day5.sh` + manual checks):
- #0 45 tUSDC Bob: first payment -> Pending -> owner approved -> Paid (direct)
- #1 12.50 tUSDC Bob (`03-bob-small.png`): auto-paid, direct, no human step
- #2 120 tUSDC Acme (`01-acme-normal.png`): Pending (threshold + first payment) -> owner approved -> Paid to sim deposit
- #3 80 tUSDC Acme (`04-acme-changed-bank.png`): Pending with "agent: invoice asks to pay a different address" (still pending)
- `05-acme-duplicate.png`: rejected by agent (invoice_hash already used), no transaction
- prove-key-limits: 4/4 refused (set_limits, withdraw, token ft_transfer, NEAR transfer) with InvalidAccessKeyError
- storage registration fix: `orvantra-acme.testnet` was NOT registered on tUSDC; owner withdraw 1 tUSDC to it succeeded
  (treasury registered it first). tx 5ydQLZfHk6K1YPa3fmaV5Sa5q58UJ3pCFjj36nGoYy69

## Day 6 (2026-11-07) — treasury v3 owned by the real owner wallet
| Contract / role | Account | Notes |
|---|---|---|
| treasury v3 | `orvantra-treasury-v3.testnet` | owner `orvantra.testnet` (owner's own wallet), initial vendor policies set at init |
| agent key | `ed25519:D8LqFgFhWJYVUkh7reRK78uffqSk1GwdqoPYRTttNpR4` | function-call only: `propose_payment` on treasury v3 |

Verified with the owner's wallet in the web app (signed by orvantra.testnet, not by the server):
- #0 Acme 120 tUSDC: approved by owner -> Paid (simulated 1Click deposit)
- #1 Acme 80 tUSDC "changed bank details": rejected by owner -> Rejected, nothing moved
- #2 Bob 12.50 tUSDC: approved by owner -> Paid
Treasury balance 500 -> 367.50 tUSDC.

## 2026-11-07 — registry security upgrade
`orvantra-registry.testnet` code upgraded in place (state kept: 3 vendors). `set_vendor` / `remove_vendor` now
require exactly 1 yoctoNEAR, so browser function-call keys can no longer change payouts silently.
Verified: 0-deposit call rejected ("Requires attached deposit of exactly 1 yoctoNEAR"); gasless relay self-test ok,
tx H2rFYdn6V6qT2cb3YQcm8ThnwRWugqk4An8p1yoJCSU8 (relayer paid gas and the 1 yocto).

## Hosting (2026-11-08)
Permanent demo: https://web-production-f1e29.up.railway.app (Railway project `orvantra`, service `web`, volume at
/app/agent/data). One container runs the Next.js app + Telegram notifier (`Dockerfile`, `deploy/entrypoint.sh`).
Secrets on Railway: NEAR AI key (capped), Telegram bot token/chat id, agent function-call key (propose_payment only,
treasury v3), relayer key (testnet, registry-only relay policy). NOT on Railway: Fortytwo key, 1Click JWT, any owner
or mainnet key. Railway had an env-var breach in Oct 2026 — rotate these if Railway reports another incident.
