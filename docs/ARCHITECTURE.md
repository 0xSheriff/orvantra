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
 │ 2. Extract  ── NEAR AI Cloud reader A: Qwen3-VL-30B (TEE, E2EE) ──┐                     │
 │            └─ NEAR AI Cloud reader B: GLM-5.3-flash (TEE, E2EE) ─┴─► must agree on      │
 │               vendor account / invoice no. / total / currency / due date; both signed   │
 │ 3. Checks: vendor approved? payout from registry? duplicate hash? amount vs history?     │
 │ 4. Quote: 1Click API → verify quote signature → strict check vs registry payout          │
 │    (recipient, assets, amount, refundTo, ORIGIN_CHAIN types, deadline); testnet: dry     │
 │    mainnet quote + SIMULATED deposit account (no NEAR Intents on testnet)                │
 │ 5. Call treasury.propose_payment(..., agent_flags = hold reasons) with a FUNCTION-CALL   │
 │    key: receiver = treasury, method = propose_payment only (cannot withdraw/approve)     │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
        │                                         │
        ▼                                         ▼
 ┌─ vendor-registry (Rust) ─┐          ┌─ treasury (Rust, one per business) ──────────────┐
 │ acme.near → {chain,      │◄─reads───│ holds USDC (NEP-141)                              │
 │   token, address,        │          │ policy: approved vendors, per-invoice cap,        │
 │   updated_at}            │          │   monthly cap, auto-pay threshold                 │
 │ only vendor can set it   │          │ rejects duplicate invoice hashes                  │
 │ (gasless via relayer)    │          │ under threshold → pays: storage_deposit(dest) then│
 └──────────────────────────┘          │   ft_transfer to 1Click deposit addr, or direct   │
                                       │   to vendor on NEAR                               │
                                       │ over threshold / new or changed payout / agent    │
                                       │   flags → PENDING → owner approves in own wallet  │
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
- **NEAR AI Cloud (TEE)** — private invoice extraction by two independent models (Qwen3-VL and GLM-5.3-flash),
  E2EE to the attested model key, response signature (`provider_tee`) verified per reading via
  `@nearai/inference-sdk`. Unverified reading → hold.
- **Stretch:** Trezu / Sputnik DAO multisig for large approvals; confidential swaps; on-chain quote-signature check.

## Fraud scenarios the demo must show
1. **Changed bank details email** — invoice says "pay new address 0xBAD". Ignored: payment goes only to the registry address.
2. **Vendor payout recently changed** — payment forced to PENDING, owner alerted.
3. **Duplicate invoice** — same invoice hash rejected by the contract.
4. **Over limit** — agent tries > cap; contract rejects (shown on explorer).
5. **Models disagree** — the two NEAR AI readers read different amounts → held for human (real example while
   choosing models: `moonshotai/kimi-k2.6` read a 1,200.00 total as 200).

## Design decision: both readers on NEAR AI Cloud (2026-11-06, with the owner)
Invoice content (images, text, extracted fields) is sent **only to NEAR AI Cloud** (TEE, attested, E2EE, signed
responses). It is never sent to Fortytwo or any other non-NEAR service. Two models from different families
give independent readings without a second provider. Fortytwo may optionally be used to generate synthetic
fixture text and never sees real invoices. Models tested and rejected: `Qwen/Qwen3.8-27B` (garbled fields
under a strict schema) and `moonshotai/kimi-k2.6` (misread a total).

## Day 5: agent → 1Click → treasury (2026-11-06)
- **Restricted agent key.** `agent/` generates its own ed25519 key outside the repo (`~/.orvantra/keys/…`, mode 600);
  the owner adds it as a function-call key (receiver = treasury, `propose_payment` only, 0.25 NEAR allowance). The
  agent refuses to sign if the on-chain permission is anything else. `npm run prove-key-limits` shows `set_limits`,
  `withdraw`, token `ft_transfer` and a NEAR transfer are all refused by the network.
- **Agent flags.** Day-4 hold reasons go on-chain as `agent_flags`; the contract then forces Pending with
  `"agent: …"` reasons. The agent can make the contract stricter, never looser. All decisions stay on-chain.
- **Payout registration.** A 1Click deposit address for USDC on NEAR is a fresh implicit account that is not
  registered on USDC (verified on mainnet), so the treasury calls `token.storage_deposit(dest, registration_only)`
  (0.00125 NEAR by default, owner-settable, excess refunded) before every `ft_transfer`, direct payouts included.
- **1Click quotes.** Signature verified with the SDK (`verifyQuoteSignature`), then every routing field is
  compared with the registry payout; `quote_hash` (base58 sha256 of the signed payload) is stored with the payment.
  Mainnet: real quote, pay `quote.depositAddress`, then submit the tx hash and poll `/status`. Testnet: a dry mainnet
  quote proves price + signature and tUSDC goes to a 64-hex implicit stand-in account (`SIM_DEPOSIT_ACCOUNT`, see `agent/src/plan.ts`), labelled **SIMULATED**.
- **Gas.** propose/approve: 65 TGas static (registry 5 + decision callback 60, which passes on storage_deposit 10 +
  registration callback 30 = ft_transfer 10 + transfer callback 10); attach 150 TGas.

## Honest limits (put in README)
- Cross-chain: the 1Click deposit address can't be fully verified on-chain in v1. The agent verifies the
  quote signature and recipient off-chain; the contract caps the damage of a compromised agent to the
  auto-pay limit. Same-chain (USDC on NEAR) payouts go straight to the vendor account — fully on-chain.
- No fiat off-ramp. Vendors receive stablecoins.
- NEAR Intents is mainnet-only: contracts developed on testnet, final demo on mainnet with tiny amounts. On testnet
  the cross-chain deposit is simulated (a plain testnet account); only the dry quote's price and signature are real.
- The function-call key's 0.25 NEAR allowance is a spending limit on gas, not on payments; payments are limited by
  the treasury policy.

## Stack
- Contracts: Rust, near-sdk, near-workspaces tests.
- Agent + API: TypeScript (Node), `@defuse-protocol/one-click-sdk-typescript` (>=0.1.24 for signature check),
  near-api-js, `@nearai/inference-sdk` (Node >= 24.22.1) for NEAR AI Cloud (attestation, E2EE, signature checks).
- UI: Next.js + NEAR Wallet Selector (owner approvals are signed by the owner's wallet, never by the bot).
- Notifications: Telegram bot (notify + link to approve).
- Secrets in `.env` only: `NEARAI_API_KEY`, `FORTYTWO_API_KEY` (fixture text only, optional), `ONECLICK_JWT` (optional), agent key.
