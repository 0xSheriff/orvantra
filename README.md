# Orvantra

**AI accounts-payable agent that pays invoices in stablecoins on any chain — but can only pay the address each vendor registered on-chain, within limits the owner set in a NEAR contract.**

Live demo (testnet): **https://orvantra.up.railway.app**

An accounts-payable team gets an invoice. Orvantra reads it privately on NEAR AI Cloud (two independent TEE models must agree), checks it against the vendor's on-chain payout registration, and proposes a payment into a Rust treasury contract that enforces the owner's spending policy. The agent's key can only call `propose_payment` — it cannot withdraw, approve, or change anything. The owner approves in their own wallet. Cross-chain payouts settle via NEAR Intents (1Click) to the vendor's chosen token on the vendor's chosen chain.

---

## Do this → see this (for judges)

The live demo runs on **NEAR testnet** with a real owner wallet and a real restricted agent key. Test data for every case below is in `agent/fixtures/` (images/PDFs) with expected verdicts in `agent/fixtures/EXPECTED.md`.

### 1. Happy path — upload an invoice, watch it get proposed
**Do:** open https://orvantra.up.railway.app, connect a testnet wallet (any testnet account works; the owner role is `orvantra.testnet`), upload `agent/fixtures/01-acme-normal.png` (a $120 invoice from Acme).
**See:** an NDJSON stream as it happens:
- two NEAR AI Cloud readers (Qwen3-VL and GLM-5.3, both **provider TEE-attested, E2EE on**) independently extract vendor / invoice no. / total / currency / due date; their readings and TEE signatures are shown
- the agent compares the extracted vendor account against the on-chain registry (`orvantra-registry.testnet`) and the payout address against the vendor's self-registered payout (version-checked)
- a 1Click cross-chain quote is fetched, **its signature is verified**, and every routing field is checked against the registry payout
- the agent signs `propose_payment` with its function-call key (nothing else is allowed) — the treasury contract puts the payment in **Pending** with on-chain reasons
- in the web app the owner sees the pending payment, the quote, and the registry payout it must match; approving signs in **the owner's own wallet** (never the server), and the contract pays (testnet: tUSDC to the simulated 1Click deposit address; mainnet: to the 1Click deposit address)

The real recorded run of this exact case (2026-11-10): tx `5JRMF8W2xKQMPVdgHf6xA5MNPCjZsLAGs48PrGNzvxEm`, payment #1 Pending on `orvantra-treasury-v4.testnet`, both readers `VERIFIED`.

### 2. "Changed bank details" fraud — invoice names a new address
**Do:** upload `agent/fixtures/04-acme-changed-bank.png` (Acme's invoice, but it says "pay the new address 0x…").
**See:** the payment is **held/Pending** with the on-chain reason `agent: invoice asks to pay a different address than the registry` — even though every field matches. The treasury can only ever pay the registry address; the new address is ignored.

### 3. Duplicate invoice — pay the same invoice twice
**Do:** re-upload `01-acme-normal.png` (or any previously processed fixture) once a payment for it already exists, or upload `agent/fixtures/05-acme-duplicate.png`.
**See:** the agent rejects it **before any transaction** (normalized invoice-number + amount + vendor already used); the treasury contract independently rejects a reused `invoice_hash` on-chain.

### 4. Over limit — bigger than the policy allows
**Do:** upload `agent/fixtures/06-acme-inflated.png` (a much larger amount), or call the treasury with an amount above `max_per_invoice` / the rolling 30-day vendor cap.
**See:** the contract **rejects the transaction** (visible on the explorer as a failed call): `Amount exceeds max_per_invoice` / vendor cap exceeded. Cross-chain payouts additionally never auto-pay (threshold 0) — they always require owner approval.

### 5. Unknown vendor — invoice from someone not registered
**Do:** upload `agent/fixtures/07-unknown-vendor.png`.
**See:** the agent holds it: no registry entry → no known payout → nothing is proposed.

### 6. The agent key cannot do anything but propose
**Do:** `cd agent && npm run prove-key-limits` (uses the live v4 testnet key).
**See:** 4/4 calls **refused by the network** with `InvalidAccessKeyError`: `set_limits`, treasury `withdraw`, token `ft_transfer`, and a plain NEAR transfer. The key's on-chain permission is receiver = treasury, method = `propose_payment` only, 0.25 NEAR allowance.

### 7. Vendors control their own payout (and can't change someone else's)
**Do:** open the vendor page (linked from the app), or run the registry e2e: `bash scripts/testnet-day5.sh` from a machine with the testnet keys.
**See:** `orvantra-acme.testnet` sets its own payout; `orvantra-bob.testnet` cannot modify Acme's entry (contract checks `predecessor_account_id`); payout changes bump the registry `version` and any payment referencing the old version is held; EVM addresses are validated (`0x` + 40 hex). New entries take a small **refundable storage deposit** so entries can't be spammed.

### 8. Tests
**Do:**
```bash
cd contracts && cargo test        # 209 tests (treasury 162 + vendor-registry 40 + test-token 7)
cd agent && npm ci && npm test    # 297 tests (extraction, checks, 1Click validation, flow)
cd web && npm ci && npm test      # 117 tests (Next.js app)
```
**See:** all green. Contract tests run the full policy engine with near-workspaces: auto-pay under threshold, Pending over threshold, duplicate-hash rejection, per-invoice cap, rolling 30-day vendor cap, payout-version holds, agent-flag holds, `max_open_payments`, `near_reserve` withdrawal floor.

---

## Architecture

```
 Invoice (image/PDF) ──► web app (Next.js) + Telegram bot
                              │
                              ▼
                 Agent (TypeScript / Node)
                 1. Extract: NEAR AI Cloud — TWO readers (Qwen3-VL + GLM-5.3),
                    each provider-TEE-attested, E2EE, response signatures verified.
                    Disagreement on a critical field → HOLD. Unverified reading → HOLD.
                    E2EE connection failure → HOLD (invoice is never read in plaintext).
                 2. Checks: vendor in registry? payout version current? duplicate key?
                    amount vs history & policy? vendor name on invoice = registry account?
                 3. Quote: 1Click API, signature verified with the SDK, every routing
                    field checked against the registry payout.
                 4. Call treasury.propose_payment(..., agent_flags) with a function-call
                    key limited to that one method.
                              │
        ┌─────────────────────┴──────────────────────┐
        ▼                                            ▼
 vendor-registry (Rust)                     treasury (Rust, one per business)
 vendor.near → {chain, token, address,      holds USDC (NEP-141)
   version, updated_at}                     policy: per-invoice cap, rolling 30-day
 only the vendor can edit its entry;        vendor cap, auto-pay threshold,
 1-yoctoNEAR attached deposit required      cross-chain auto-pay = 0 (always Pending),
 (browser keys can't change it free);       payout must match current registry version,
 gasless via relayer that pays only for     duplicate invoice_hash rejected,
 calls to our registry                      agent_flags can only add holds
        │                                            │
        └────────────── reads ───────────────────────┘
                              │
                              ▼
  Under threshold & same-chain & known & current → PAID:
    storage_deposit(dest, registration_only) then ft_transfer to the vendor
    (on NEAR) or to the 1Click deposit address (cross-chain), then NEAR
    Intents settles to e.g. USDC on Base / USDT on Tron.
  Anything else → PENDING: owner approves/rejects in their own wallet.
```

All decisions are enforced **in the contracts**, not the agent. The agent can only make the system *stricter* (hold flags); it cannot pay, approve, withdraw, or loosen policy.

### NEAR technologies used
- **NEAR AI Cloud (TEE)** — invoice content goes only to NEAR AI Cloud: two models from different families, provider TEE attestation, end-to-end encryption to the attested model key, per-response signature verification via `@nearai/inference-sdk`. No third-party LLM ever sees invoices.
- **Rust smart contracts** (`near-sdk 5.30`) — `vendor-registry` and `treasury`, each a normal NEAR contract.
- **Function-call access keys** — the agent key is scoped to `propose_payment` on one treasury with a 0.25 NEAR allowance; verified on-network (case 6).
- **Meta transactions + relayer** — vendors register/update payout gaslessly; the relayer's key is constrained to pay only for calls to our registry, with key/nonce/rate checks.
- **NEAR Intents (1Click)** — cross-chain stablecoin delivery; the agent verifies the quote signature and every routing field before proposing.
- **Named accounts** — invoices reference `acme.near`, not raw addresses.
- **NEP-141 tokens** — treasury holds USDC; test token `orvantra-tusdc.testnet` mirrors it.

---

## Honest limits (read these)

- **Testnet is primary.** The live demo runs on NEAR testnet with a test treasury (`orvantra-treasury-v4.testnet`), test funds, and a real restricted agent key. NEAR Intents is mainnet-only, so on testnet the cross-chain deposit is **simulated**: a real 1Click quote proves price and signature, but the tUSDC goes to a stand-in account. Same-chain payouts are fully real on-chain.
- **Two real mainnet 1Click swaps exist as a bonus (owner-wallet, not product payments):** the owner's wallet ran a genuine NEAR → Base swap (0.45 NEAR → 1.607589 USDC) and the reverse Base → NEAR swap (1.607589 USDC → ~0.45 NEAR), each a real 1Click quote with verified signature and a plain deposit to the quote address. They prove the cross-chain delivery primitive works on mainnet in both directions. No Orvantra contracts are deployed on mainnet and the automated AP flow (invoice → TEE readers → registry → treasury proposal → owner approval) is testnet-only. Details in `docs/DEPLOYMENTS.md`.
- **1Click deposit address verification is off-chain in v1.** The quote signature and recipient are verified off-chain; the contract caps a compromised agent's damage to the auto-pay limit (0 for cross-chain, so zero).
- **No fiat off-ramp.** Vendors receive stablecoins.
- **The 0.25 NEAR key allowance limits gas, not payments.** Payments are limited by treasury policy.

## What AI was used for

Built solo with AI coding assistance (Claude Code, plus Hermes Agent for orchestration and reviews); all code reviewed and tested as above. **Invoice content is processed exclusively by NEAR AI Cloud TEE models** (Qwen3-VL, GLM-5.3) — the AI that reads your invoices is the platform's own attested inference; no invoice data goes to any other AI service.

## Repository layout

```
contracts/vendor-registry/   Rust — vendor → payout mapping, self-service with storage deposit
contracts/treasury/          Rust — spending policy, propose/approve/reject, payout execution
contracts/test-token/        Rust — NEP-141 tUSDC for tests
agent/                       TypeScript — intake, TEE extraction, checks, 1Click, propose
  scripts/mainnet-quote.ts   one-off real mainnet 1Click quote (demo bonus)
  fixtures/                  demo invoices (incl. fraud cases) + EXPECTED.md
web/                         Next.js — upload, live stream, pending payments, owner approve
docs/ARCHITECTURE.md         design decisions and walkthrough
docs/DEPLOYMENTS.md          deployment log, live-verified runs, tx hashes
docs/security/REVIEW-2026-11-08.md   three-reviewer security audit + fixes
```

## Local run (optional)

```bash
cd contracts && cargo build && cargo test
cd agent && npm ci && npm run pay -- fixtures/01-acme-normal.png   # needs testnet keys + .env
cd web   && npm ci && npm run dev
```

Secrets live in `.env` only (NEAR AI API key, optional Fortytwo/1Click keys) and are never committed.

## License

MIT — see `LICENSE`.
