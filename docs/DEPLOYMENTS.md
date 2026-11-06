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
