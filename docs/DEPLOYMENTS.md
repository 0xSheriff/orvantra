# Deployments

## Testnet (dev accounts, faucet-funded; keys in ~/.near-credentials/testnet, never committed)
| Contract / role | Account | Notes |
|---|---|---|
| vendor-registry | `orvantra-registry.testnet` | deployed 2026-11-06, tx GmqW7LpFonQe1aegRqeey6Wss8Vy2wBvP7fR6kpMFypT |
| test vendor | `orvantra-acme.testnet` | payout USDC on Base, version 2 after change test |
| test second vendor | `orvantra-bob.testnet` | proves vendors can only edit their own entry |

Live check performed: register -> view -> other account cannot alter -> invalid EVM address rejected
("address must be 0x followed by 40 hex chars") -> payout change bumps version 1 -> 2.

## Mainnet
Not deployed. Requires explicit owner approval.
