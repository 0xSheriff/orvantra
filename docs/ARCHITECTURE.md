# Invoice-to-Pay Agent — Architecture (draft v1)

Project name: **Orvantra**.
Tracks: `realworld` (primary), `security`, `privacy` — the submission may list several.

## One-line pitch
An AI accounts-payable agent that pays invoices in stablecoins on any chain, but can only pay
addresses the vendor registered on-chain, within limits the owner set in a NEAR contract.

## Difference from the official track example
The `realworld` example prompt is the *freelancer sending* an invoice. We are the *business paying*
invoices (accounts payable) and stopping invoice fraud. Different side, little overlap.

## Components

```
 Invoice (PDF/photo/email)
        │
        ▼
 ┌──────────────────────────── Agent service (TypeScript / Node) ───────────────────────────┐
 │ 1. Intake: web upload + Telegram bot (+ email forward if time)                           │
 │ 2. Extract  ── NEAR AI Cloud (TEE, private)  ──┐                                         │
 │            └─ Fortytwo (Qwen3.8-27B)        ──┴─► must agree on vendor/amount/due/ref    │
 │ 3. Checks: vendor approved? payout from registry? duplicate hash? amount vs history?     │
 │ 4. Quote: 1Click API → verify quote signature → check quote.recipient == registry payout │
 │ 5. Call treasury.propose_payment(...) with a FUNCTION-CALL key (cannot withdraw)          │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
        │                                         │
        ▼                                         ▼
 ┌─ vendor-registry (Rust) ─┐          ┌─ treasury (Rust, one per business) ──────────────┐
 │ acme.near → {chain,      │◄─reads───│ holds USDC (NEP-141)                              │
 │   token, address,        │          │ policy: approved vendors, per-invoice cap,        │
 │   updated_at}            │          │   monthly cap, auto-pay threshold                 │
 │ only vendor can set it   │          │ rejects duplicate invoice hashes                  │
 │ (gasless via relayer)    │          │ under threshold → pays (ft_transfer to 1Click     │
 └──────────────────────────┘          │   deposit addr, or direct to vendor on NEAR)      │
                                       │ over threshold / new or changed payout → PENDING  │
                                       │   → owner approves with own wallet key            │
                                       └───────────────────────────────────────────────────┘
        │
        ▼
 NEAR Intents settles → vendor gets e.g. USDC on Base / USDT on Tron. Status tracked via 1Click.
```

## NEAR tech used (name all of these in the README)
- **Named accounts** — vendor identity (`acme.near`) used on invoices instead of raw addresses.
- **Own Rust contracts** — vendor registry + treasury policy engine.
- **Function-call access keys** — agent key limited to `propose_payment`; no transfer/withdraw/admin.
- **Meta transactions + relayer** — vendors register/update payout without holding NEAR; relayer only pays for calls to our registry.
- **NEAR Intents / 1Click API** — cross-chain stablecoin payout in the vendor's chosen token/chain; quote signature verified.
- **NEAR AI Cloud (TEE)** — private invoice extraction; attestation shown per invoice (confirm API on day 1).
- **Stretch:** Trezu / Sputnik DAO multisig for large approvals; confidential swaps; on-chain quote-signature check.

## Fraud scenarios the demo must show
1. **Changed bank details email** — invoice says "pay new address 0xBAD". Ignored: payment goes only to the registry address.
2. **Vendor payout recently changed** — payment forced to PENDING, owner alerted.
3. **Duplicate invoice** — same invoice hash rejected by the contract.
4. **Over limit** — agent tries > cap; contract rejects (shown on explorer).
5. **Models disagree** — NEAR AI and Fortytwo read different amounts → held for human.

## Honest limits (put in README)
- Cross-chain: the 1Click deposit address can't be fully verified on-chain in v1. The agent verifies the
  quote signature and recipient off-chain; the contract caps the damage of a compromised agent to the
  auto-pay limit. Same-chain (USDC on NEAR) payouts go straight to the vendor account — fully on-chain.
- No fiat off-ramp. Vendors receive stablecoins.
- NEAR Intents is mainnet-only: contracts developed on testnet, final demo on mainnet with tiny amounts.

## Stack
- Contracts: Rust, near-sdk, near-workspaces tests.
- Agent + API: TypeScript (Node), `@defuse-protocol/one-click-sdk-typescript` (>=0.1.24 for signature check),
  near-api-js, OpenAI-compatible clients for NEAR AI Cloud and Fortytwo.
- UI: Next.js + NEAR Wallet Selector (owner approvals are signed by the owner's wallet, never by the bot).
- Notifications: Telegram bot (notify + link to approve).
- Secrets in `.env` only: `NEARAI_API_KEY`, `FORTYTWO_API_KEY`, `ONECLICK_JWT` (optional), agent key.
