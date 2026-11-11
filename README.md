# Orvantra

**AI accounts-payable agent that pays invoices in stablecoins on any chain — but can only pay the address each vendor registered on-chain, within limits the owner set in a NEAR contract.**

Live demo (testnet): **https://orvantra.up.railway.app**

An accounts-payable team gets an invoice. Orvantra reads it privately on NEAR AI Cloud (two independent TEE models must agree), checks it against the vendor's on-chain payout registration, and proposes a payment into a Rust treasury contract that enforces the owner's spending policy. The agent's key can only call `propose_payment` — it cannot withdraw, approve, or change anything. The owner approves in their own wallet. Cross-chain payouts settle via NEAR Intents (1Click) to the vendor's chosen token on the vendor's chosen chain.

---

## Do this → see this (for judges)

The live app talks to treasury **`orvantra-treasury-v6.testnet`** (owner `orvantra.testnet`) and registry **`orvantra-registry.testnet`**. Test invoices are in `agent/fixtures/` (15 numbered cases + 2 fresh happy-path files) with expected verdicts in `agent/fixtures/EXPECTED.md`; the site also serves the whole pack at https://orvantra.up.railway.app/judges/test-invoices.zip.

**One rule to know:** `propose_payment` burns each invoice's hash forever, so an invoice already proposed on the live treasury is rejected on re-upload — that is the duplicate guard working, not an error. The happy-path files below are the *fresh* ones; most numbered files #1–#5 are already on the live treasury and now double as the duplicate-guard demo.

### 1. Happy path — clean invoice, cross-chain
**Do:** open https://orvantra.up.railway.app, connect any testnet wallet, upload `rb-acme-normal.png` (a fresh $50 Acme invoice, hash not yet on-chain).
**See:** the NDJSON stream — two NEAR AI Cloud readers (Qwen3-VL + GLM-5.3, both **provider TEE-attested, E2EE**, response signatures verified) agree on vendor / invoice no. / total / currency / due date; the registry payout is matched version-checked; the 1Click quote is fetched and **its signature is verified**, every routing field checked against the registry payout; `propose_payment` is signed with the function-call key. The payment lands **Pending** with the on-chain reason `will be held by contract: cross-chain payout, you confirm the 1Click deposit address`.

### 2. Happy path — clean invoice, same-chain auto-pay
**Do:** upload `rb-bob-normal.png` (a fresh $20 Bob invoice; the auto-pay threshold is 100.00, Bob pays on NEAR).
**See:** same stream, then the treasury **pays immediately on-chain** — `ft_transfer` of tUSDC directly to `orvantra-bob.testnet`, payment marked **Paid** with the tx in the activity feed. No owner approval needed — that is the point of the threshold.

### 3. Fraud — "our payout address changed"
**Do:** upload `14-acme-implicit-redirect.png` (Acme's invoice, but it asks you to pay a 64-hex implicit account instead).
**See:** the payment is **proposed with a hold** — on-chain reason `agent: invoice asks to pay a different address — ignored; registry is the source of truth`. The treasury can only ever pay the registry address; the planted address is discarded. (Verified live against v6 on 2026-11-11.)

### 4. Duplicate — the same invoice twice
**Do:** upload `01-acme-normal.png` (already proposed on the live treasury by an earlier demo run).
**See:** rejected **before any transaction is signed**: `invoice_hash already used in the treasury (duplicate invoice)`. Steps 3–5 of the pipeline show skipped; nothing is sent. (The live UI shows exactly this: step 2 "Checking registry and limits → reject", steps 3–4 skipped, "Stopped. Nothing was sent.")

### 5. The proof page — every claim, with links
**Do:** open https://orvantra.up.railway.app/proof.
**See:** all 15 fixture verdicts fetched live from the eval's JSON (both-reader TEE/E2EE verification per row), the five on-chain contract refusals with explorer tx links, and the mainnet NEAR→Base proof. Nothing on the page is a screenshot.

### 6. Owner rules — three states of one page
**Do:** open https://orvantra.up.railway.app/rules three ways: with no wallet; with a non-owner testnet wallet; with the owner wallet `orvantra.testnet`.
**See:** (a) a "connect the owner wallet" prompt; (b) the current rules in read-only with `Only orvantra.testnet can change these rules`; (c) a full editor — `set_limits`, `set_vendor_policy`, `remove_vendor_policy` — where each save is signed in **the browser's own wallet** and the server never holds the signature. Enforcement is in the contract (`assert_owner_full_access`); the page is only the surface. The owner has used this live (the `orvantra.testnet` 200/200 vendor policy on v6 was set through it — see `docs/DEPLOYMENTS.md`).

### 7. Cross-chain delivery, proven on mainnet
**Do:** open the two transactions below.
**See:** 0.45 NEAR left `orvantra.near` (NEAR mainnet) and 1.607589 USDC arrived on Base via NEAR Intents (1Click): [NEAR tx](https://explorer.near.org/transactions/AD8QDvGKJTx8f3sjQM5XB9GYaiXrisAXRzYewAy4Lo7n) + [Base tx](https://basescan.org/tx/0x4abc3615397620258189036353e909f47044ba784461c8c8c0ed7003fdeac3fb). Intents is mainnet-only (Q-007), so the product flow itself is testnet (Q-010) — this proves the delivery primitive end to end.

### 8. The agent key can only propose
**Do:** `cd agent && npm run prove-key-limits` (no secrets needed; uses the agent's default treasury v4).
**See:** 4/4 attempts **refused by the network** with `InvalidAccessKeyError` — `set_limits`, treasury `withdraw`, token `ft_transfer`, plain NEAR transfer. The on-chain key permission is receiver = treasury, method = `propose_payment`, ~0.25 NEAR allowance (visible on the [agent account page](https://testnet.nearblocks.io/accounts/orvantra-agent.testnet)).

### 9. The contract refuses the agent — five real transactions
**Do:** read the Round B section of `docs/DEPLOYMENTS.md` (or the same table on the /proof page).
**See:** on the live treasury, real `propose_payment` transactions that **failed on-chain**: `over vendor monthly cap` ([tx](https://testnet.nearblocks.io/txns/Ak4forTB56S6DQsaZUaJNFWaDMfY37ah2jn3NgoPxSWt)), `over treasury monthly cap` ([tx](https://testnet.nearblocks.io/txns/H3XvhxzgPxYaEe8nb3pkdu82n4kWrSNb8yCzZsFQ45vL)), `treasury is paused` ([tx](https://testnet.nearblocks.io/txns/CkniDBhcZsfPygkNeFCaPPfcDK4sPV541s8RQhvVzQxd)), plus the payout-age hold prediction and an agent-side reject after `remove_vendor_policy` — every setting restored afterwards.

### 10. Reproduce the eval — 15 fixtures, real TEE readers
**Do:** `cd agent && npm i && npm run eval` (needs `NEARAI_API_KEY` in the repo `.env`).
**See:** `15/15 PASS` — every fixture through both attested readers + live chain views against the eval's target treasury `orvantra-treasury-v4.testnet` (the agent's default; a stable archive of demo state, separate from the live v6 app). Expected vs actual per fixture is printed, with the verdict reason that must match.

### 11. Vendors control their own payout
**Do:** register at https://orvantra.up.railway.app/register with any testnet wallet, or inspect the [registry account page](https://testnet.nearblocks.io/accounts/orvantra-registry.testnet).
**See:** vendors set their own payout (chain, token, address); a payout change bumps the registry `version` and any payment referencing the old version is held by the contract; entries carry a small refundable storage deposit so they can't be spammed; `orvantra-bob.testnet` cannot modify Acme's entry — the contract checks `predecessor_account_id`.

### 12. Tests
**Do:**
```bash
cd contracts && cargo test        # 209 tests (treasury 162 + vendor-registry 40 + test-token 7)
cd agent && npm ci && npm test    # 298 tests (extraction, checks, 1Click validation, flow)
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

**Verdict vocabulary:** `propose` = the agent signs `propose_payment` (the contract may still hold it). `hold` = proposed *with* agent flags — it lands Pending and the owner sees the reason before approving. `reject` = nothing is signed, nothing is proposed. All three are re-checked independently by the contract.

### NEAR technologies used
- **NEAR AI Cloud (TEE)** — invoice content goes only to NEAR AI Cloud: two models from different families, provider TEE attestation, end-to-end encryption to the attested model key, per-response signature verification via `@nearai/inference-sdk`. No third-party LLM ever sees invoices.
- **Rust smart contracts** (`near-sdk 5.30`) — `vendor-registry` and `treasury`, each a normal NEAR contract.
- **Function-call access keys** — the agent key is scoped to `propose_payment` on one treasury with a 0.25 NEAR allowance; verified on-network (case 8).
- **Meta transactions + relayer** — vendors register/update payout gaslessly; the relayer's key is constrained to pay only for calls to our registry, with key/nonce/rate checks.
- **NEAR Intents (1Click)** — cross-chain stablecoin delivery; the agent verifies the quote signature and every routing field before proposing.
- **Named accounts** — invoices reference `acme.near`, not raw addresses.
- **NEP-141 tokens** — treasury holds USDC; test token `orvantra-tusdc.testnet` mirrors it.

---

## Honest limits (read these)

- **Testnet is primary.** The live app runs on `orvantra-treasury-v6.testnet` with test funds and a real restricted agent key; the reproducible eval (case 10) targets `orvantra-treasury-v4.testnet`, a stable archive of earlier demo state. NEAR Intents has no testnet, so cross-chain payouts on testnet are **simulated at the last hop**: a real 1Click quote proves price and signature, but the tUSDC goes to a stand-in account. Same-chain payouts are fully real on-chain. Testnet-only projects are eligible (Q-010).
- **Two real mainnet 1Click swaps exist as a bonus (owner-wallet, not product payments):** NEAR → Base (0.45 NEAR → 1.607589 USDC) and the reverse Base → NEAR, each a real 1Click quote with verified signature and a plain deposit to the quote address. No Orvantra contracts are deployed on mainnet. Details in `docs/DEPLOYMENTS.md`.
- **1Click deposit address verification is off-chain in v1.** The quote signature and recipient are verified off-chain; the contract caps a compromised agent's damage to the auto-pay limit (0 for cross-chain, so zero).
- **No fiat off-ramp.** Vendors receive stablecoins.
- **The 0.25 NEAR key allowance limits gas, not payments.** Payments are limited by treasury policy.

## What AI was used for

Built solo with AI coding assistance (Claude Code + Hermes Agent for orchestration and reviews); all code reviewed and tested as above. **Invoice content is processed exclusively by NEAR AI Cloud TEE models** (Qwen3-VL, GLM-5.3) — the AI that reads your invoices is the platform's own attested inference; no invoice data goes to any other AI service.

## Repository layout

```
contracts/vendor-registry/   Rust — vendor → payout mapping, self-service with storage deposit
contracts/treasury/          Rust — spending policy, propose/approve/reject, payout execution
contracts/test-token/        Rust — NEP-141 tUSDC for tests
agent/                       TypeScript — intake, TEE extraction, checks, 1Click, propose
  fixtures/                  demo invoices (incl. fraud cases) + EXPECTED.md
  scripts/prove-key-limits.ts  live proof the agent key can only propose
  scripts/mainnet-quote.ts   one-off real mainnet 1Click quote (demo bonus)
web/                         Next.js — upload, live stream, pending approvals, rules editor, /judges, /proof
web/scripts/copy-eval-results.mjs  ships agent/eval-results.json to the /proof page
scripts/testnet-roundB.sh    the five on-chain contract-refusal demos (restore everything)
docs/ARCHITECTURE.md         design decisions and walkthrough
docs/DEPLOYMENTS.md          deployment log, live-verified runs, tx hashes
docs/security/REVIEW-2026-11-08.md   three-reviewer security audit + fixes
```

## Local run (optional)

```bash
cd contracts && cargo build && cargo test
cd agent && npm ci && npm run analyze -- fixtures/rb-acme-normal.png   # needs .env (read-only, signs nothing)
cd web && npm ci && npm run dev
```

Secrets live in `.env` only (NEAR AI API key, optional Fortytwo/1Click keys) and are never committed.

## License

MIT — see `LICENSE`.
