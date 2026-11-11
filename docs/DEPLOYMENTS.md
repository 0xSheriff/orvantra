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
No contracts deployed on mainnet (testnet-only build; testnet-only is eligible per HACKATHON Q-010).
`orvantra.near` funded 2026-11-10 for one bonus real 1Click payment, run from the owner's
wallet as a demo extra — not a deployment.

### Bonus real 1Click payment (2026-11-10) — COMPLETED, verified on-chain
One real NEAR → Base cross-chain payment via NEAR Intents / 1Click, executed by the owner's
wallet (Meteor) — the demo extra that proves the cross-chain payout path works on mainnet.
- Origin: `orvantra.near` (NEAR mainnet), **0.45 NEAR**
- 1Click quote: origin `nep141:wrap.near` (native NEAR, wrapped-or-unwrapped) →
  destination `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near` (Base USDC),
  recipient `0x0533cda710e375b00d106e557da995b859e5bf94`, quote signature VERIFIED
- Deposit tx (owner-signed): `AD8QDvGKJTx8f3sjQM5XB9GYaiXrisAXRzYewAy4Lo7n`
- 1Click status: **SUCCESS** (0% slippage, no refund, withdraw fee 2400 units)
- **Verified delivery on Base: 1.607589 USDC** to the recipient (was 0.0 before);
  destination tx `0x4abc3615397620258189036353e909f47044ba784461c8c8c0ed7003fdeac3fb`
- Mechanism note (why a plain NEAR send works here): the wNEAR/NEAR-origin 1Click quote
  returns a `depositAddress` you pay with a **plain native-NEAR transfer** (see 1Click's own
  `near-intents-examples/1click-example/6-full-swap.ts`, which uses the same `nep141:wrap.near`
  origin and a plain `account.transfer`). The `ft_transfer_call` → `intents.near` route is the
  older Verifier-Contract path, not the 1Click one. A NEP-141 USDC origin, by contrast, needs
  the `ft_transfer_call` mechanism and fails as a plain token send (verified 2026-11-10).

### Reverse swap: Base USDC → NEAR (2026-11-10) — COMPLETED, verified on-chain
Same delivery primitive, reverse direction. A **manual owner wallet move** (not an Orvantra
product action — no invoice, vendor, treasury, or agent involved): the owner sent the USDC from
the bonus payment back to `orvantra.near`, proving 1Click settles EVM → NEAR too.
- Origin: `0x0533cda710e375b00d106e557da995b859e5bf94` (Base), **1.607589 USDC**
- 1Click quote: origin Base USDC → destination `nep141:wrap.near`, recipient `orvantra.near`,
  `refundTo` = the Base 0x address (EVM origin → EVM refund), quote signature VERIFIED
- Deposit = a **plain ERC20 transfer** to the quote's 0x depositAddress on Base (no memo;
  `orvantra.near` already had wrap.near storage, so no `storage_deposit` needed)
- Deposit tx (owner-signed, Base): `0x8af64471b091d9bb68c215e711ebefa3671792dd6bc0460405318c6e409b9a02`
- 1Click status: **SUCCESS** (4 settle txs, no refund; 0.450901 wNEAR delivered, auto-unwrapped)
- **Verified delivery on NEAR: `orvantra.near` 0.273425 → 0.71721163 native NEAR**
  (net +0.4438; ~0.007 NEAR gas across the 4 settle txs). Base USDC balance → 0.

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
Permanent demo: https://orvantra.up.railway.app (Railway project `orvantra`, service `web`, volume at
/app/agent/data). One container runs the Next.js app + Telegram notifier (`Dockerfile`, `deploy/entrypoint.sh`).
Secrets on Railway: NEAR AI key (capped), Telegram bot token/chat id, agent function-call key (propose_payment only,
treasury v4), relayer key (testnet, registry-only relay policy). NOT on Railway: Fortytwo key, 1Click JWT, any owner
or mainnet key. Railway had an env-var breach in Oct 2026 — rotate these if Railway reports another incident.
Container runs non-root; security headers set.

## Security hardening (2026-11-08, review `docs/security/REVIEW-2026-11-08.md`)
Three-reviewer audit confirmed: C-H1 cross-chain auto-pay to stolen-key address, C-M1 monthly cap double-spend at
day boundary, C-M2 storage drain, W-H1 relay accepted foreign/replayed keys, W-H2 unauthenticated uploads, A-H1
invoice vendor name not checked vs registry, A-H2 duplicate invoice-number tweaks.
Fixed in `90243f0` (contracts) and `727df00` (web+agent). Contract tests 199, web 117, agent 297 all pass.
Key behaviors now: cross-chain auto-pay threshold default 0 (cross-chain always Pending), rolling 30-day vendor cap,
`max_open_payments` 25 + `near_reserve` 0.5 NEAR + `withdraw_near`, relay key/nonce/rate checks, upload size+rate
limits, invoice vendor name must match registry account (else hold), normalized duplicate-invoice keys.

## 2026-11-10 — second-pass audit (Fable) + treasury v5 + agent ledger fix
Second independent audit of the contracts (Fable, `--model fable` via Claude Code, 2026-11-10,
read-only, report in session notes) confirmed the 2026-11-08 fixes (C-H1, C-M1, C-M2, C-M3) solid
under default config — no path for a stolen agent key to move funds or redirect a payout. It found
4 new Lows, all fixed in v5 (`7e5f558`):
- **stale cap escape**: a Pending payment older than the 30-day window fell out of the caps but
  could still be approved → `approve_payment` now auto-rejects with `REASON_STALE`.
- **cross-chain quote expiry**: a held cross-chain payment paid a 1Click deposit address whose quote
  expires off-chain → `Payment` gained `quote_deadline_ns` (v5: `created_at` + 24h for cross-chain,
  0 for direct; the agent may later pass the quote's real `valid_until`); `approve_payment` rejects
  past it with `REASON_QUOTE_EXPIRED`.
- **resolve_executing race**: owner could mark a still-in-flight transfer `paid=false` → refused for
  60s after the payment entered Executing (`RESOLVE_MIN_AGE_NS`).
- **phantom proposal event**: `payment_proposed` was emitted before the `near_reserve` check, so a
  reverted proposal left an event → moved after the `require!`.

| Contract / role | Account | Notes |
|---|---|---|
| treasury v5 (current) | `orvantra-treasury-v5.testnet` | owner `orvantra-owner.testnet`, agent `orvantra-agent.testnet`; same config as v4 (auto_pay 100, cross_chain_auto_pay 0, monthly_cap 1000, min_payout_age 120s, max_open_payments 25, near_reserve 0.5 NEAR); 500 tUSDC funded; wasm sha256 `0b0002cae9cb04…` |
| agent key (v5) | `ed25519:6jmrbRgycE1RqFEhn2kEp1um5c1eEUEzWLGhnAAs6nTS` | function-call only: `propose_payment` on v5, 0.25 NEAR; v4 key (GUs21A7m) superseded (keyfile overwritten by `--force` — v5 key backed up `orvantra-agent.testnet.v5.json`) |

v5 deploys to a FRESH account (Payment struct layout changed); v4 is untouched and was never
upgraded in place. v5 demo state: #0 Bob 45 Paid (warm-up), #1 Bob 12.50 Paid (direct, auto),
#2 Acme 120 Pending (threshold + first + cross-chain), #3 Acme 80 Pending (changed-bank hold,
agent flag, registry payout won), duplicate invoice rejected by the agent pre-contract.
`prove-key-limits` 4/4 refused against v5.

Agent bug found while re-running the demo (fixed, 1 new regression test, agent tests 298):
`upsert()` carried a previous treasury's `tx_hash`/`payment_id` over when the same invoice was
processed against a new treasury, so `alreadyProposed()` false-positived and silently skipped
sending. Now a treasury change clears the execution fields.

Tests (2026-11-10, re-run after each change): contracts 209 (treasury 162 + vendor-registry 40 +
test-token 7), agent 298, web 117.

## 2026-11-10 — treasury v4 + registry migrate
| Contract / role | Account | Notes |
|---|---|---|
| treasury v4 (current) | `orvantra-treasury-v4.testnet` | owner `orvantra.testnet`, agent `orvantra-agent.testnet`; auto_pay 100, cross_chain_auto_pay 0, monthly_cap 1000 (rolling 30d), min_payout_age 120s, max_open_payments 25, near_reserve 0.5 NEAR; 500 tUSDC funded |
| agent key (v4) | `ed25519:GUs21A7mLiQoC62JWjHhsc3PZxvvvUtYoQVBT2M9GF1u` | function-call only: `propose_payment` on v4, 0.25 NEAR; old v3 key backed up `orvantra-agent.testnet.v3-backup.json` |
| registry | `orvantra-registry.testnet` | code upgraded in place via `migrate` (state kept: Acme v2, Bob v2); new `storage_cost_estimate` (~0.0045 NEAR refundable deposit on new entries) |

Verified live (2026-11-10, through https://orvantra.up.railway.app, commit 727df00 build):
- `01-acme-normal.png` -> both readers VERIFIED (provider TEE, e2ee=on), agree on critical fields -> PROPOSE ->
  1Click dry quote (signature VALID, recipient matches registry v2, simulated testnet path) -> `propose_payment`
  signed with the function-call key -> tx 5JRMF8W2xKQMPVdgHf6xA5MNPCjZsLAGs48PrGNzvxEm -> **payment #1 Pending**
  with reasons: amount above auto-pay threshold, first payment to this vendor, cross-chain payout (owner confirms
  the 1Click deposit address).
- Agent key refusal check: 4/4 refused (non-propose methods).
Note: E2EE reader connection failed from the local Mac (hotspot can't reach NVIDIA attestation) and correctly HELD
the invoice ("end-to-end encryption failed") instead of reading plaintext; from Railway the same run goes e2ee=on.

## 2026-11-11 — Round B (v6.2): 8 new fixtures + contract refusals on the live v6 treasury

No new deploy. Treasury `orvantra-treasury-v6.testnet` (owner `orvantra.testnet`, agent `orvantra-agent.testnet`),
registry `orvantra-registry.testnet`, token `orvantra-tusdc.testnet`.

### Agent fixtures 08–15 (`npm run eval`, 2026-11-11, default treasury v4, both readers `provider_tee`)

`npm run fixtures` regenerates all 17 files (01–15 plus the unnumbered `rb-acme-normal.png` / `rb-bob-normal.png`).
`npm run eval` ran 15/15 PASS. New rows (expected = actual):

| File | Expected | Actual reason |
|------|----------|---------------|
| `08-acme-credit-note.png` | reject | document is a credit note, not a request for payment |
| `09-acme-over-max.png` | reject | amount 400.00 USDC is above the vendor max_per_invoice 300.00 USDC (+ hold: > 3x median) |
| `10-unapproved-vendor.png` | reject | vendor orvantra.testnet is not approved in the treasury policy |
| `11-acme-name-mismatch.png` | hold | invoice says Web Design Studio, but orvantra-acme.testnet is registered as Acme Design |
| `12-bob-possible-duplicate.png` | hold | possible duplicate of B-0008 (Paid) |
| `13-acme-bank-details.png` | hold | invoice contains bank/payment details — ignored; registry is the source of truth |
| `14-acme-implicit-redirect.png` | hold | invoice asks to pay a different address — ignored; registry is the source of truth (invoice says: aaaa…64 a's) |
| `15-near-less-invoice.png` | reject | no vendor NEAR account on the invoice |

Existing rows: 02, 04, 05, 06, 07 as in `agent/fixtures/EXPECTED.md`; 01 and 03 are now **reject (hash used)**
because those invoices were already proposed on v4 (the eval encodes that duplicate-guard rule; see EXPECTED.md).
Fixture 12 uses B-0008 (Paid on every demo treasury) rather than B-0007 (never proposed on v4).

### On-chain Round B (`bash scripts/testnet-roundB.sh`, 2026-11-11, second run — the first run stopped at B4 because
`pause()` takes no deposit; it had already restored B1–B3, and the fix is in the script)

Baseline before: auto_pay 100.00, monthly_cap 1000.00, min_payout_age 120 s, paused=false, 4 payments; Bob policy
300.00 / 200.00, Acme 300.00 / 600.00; monthly_spent Bob 57.50, total 177.50; Acme registry v4.

| Step | What | Txs (https://testnet.nearblocks.io/txns/<hash>) | Actual |
|------|------|------|--------|
| B1 | owner `set_limits(100, 1000, 3600)`; Acme `set_vendor` address `…3334` (v5); `npm run analyze -- fixtures/rb-acme-normal.png` | `8FjKUyLjjWLroaAHWLar4JoPhNapLDxDmLXRiKLCXeZG`, `E3RbWQmTHrYYp53GQyRrVoSKSHjRunvDedXSXbFuRVb1` | agent PROPOSE with `[contract] will be held by contract: payout changed less than 3600s ago` (payout_age_ns 1715588350) |
| B1 restore | Acme `set_vendor` back to `…3333` (v6); `set_limits(100, 1000, 120)` | `4WVa7oCPpnkXojucQ6AWXMe5Po5mWWNeN2Th1HsrZvxM`, `9CDXsyhSA16xe9zcZcC3kCSWaySyU43jQF3UgXVBhyUX` | restored |
| B2 | owner `set_vendor_policy(bob, 300, 60)`; agent `propose_payment(bob, 10.00, memo RB-01)` with the function-call key | `2pPdHBRUibxWXtCGzZBSdH7bmCcjCPeAy3XfwiUb7Dc6`, propose `Ak4forTB56S6DQsaZUaJNFWaDMfY37ah2jn3NgoPxSWt` | tx FAILED: `Smart contract panicked: over vendor monthly cap` |
| B2 restore | `set_vendor_policy(bob, 300, 200)` | `6uKX4fbhjkXDyN8LC3rdKSw1khbDSUEn8y66xSTM62gD` | restored |
| B3 | owner `set_limits(100, 180, 120)`; agent `propose_payment(bob, 10.00, RB-02)` | `2nzAqNdNwn3ssgpvuGwkHbvHo95bP5NryXhzbbvjxhxE`, propose `H3XvhxzgPxYaEe8nb3pkdu82n4kWrSNb8yCzZsFQ45vL` | tx FAILED: `Smart contract panicked: over treasury monthly cap` |
| B3 restore | `set_limits(100, 1000, 120)` | `AquFjeyj4GbzoYtiA8eb1ygMt59VEQEnYPuEmMuu5w9g` | restored |
| B4 | owner `pause()`; agent `propose_payment(bob, 10.00, RB-03)` | `FXnwTZBvRAoggFDm28oPnBMxnkeiiE5nsmZwvBXWwWtu`, propose `CkniDBhcZsfPygkNeFCaPPfcDK4sPV541s8RQhvVzQxd` | tx FAILED: `Smart contract panicked: treasury is paused` |
| B4 restore | `unpause()` | `BokTiwu4vLaF4vvz2iynjPxoBxBokLQmrZHfnyDh976Z` | restored |
| B5 | owner `remove_vendor_policy(bob)`; `npm run analyze -- fixtures/rb-bob-normal.png` | `5gv91hLrWGVgTsSxyAoa3szqAUtykgskWCJ8F783qNcx` | agent REJECT: `vendor orvantra-bob.testnet is not approved in the treasury policy` (nothing signed) |
| B5 restore | `set_vendor_policy(bob, 300, 200)` | `9ynoyD7ZT8aX4ZkBfuYzxdRsbx1bL3Hjn4pD7v7hr3TG` | restored |

Restored-state proof (script's final views): config auto_pay 100.00 / monthly_cap 1000.00 / min_payout_age 120 /
paused=false / payment_count 4 (refused proposals create nothing; RB-01..03 never appear in `get_payments`);
Bob 300.00 / 200.00, Acme 300.00 / 600.00; registry Bob v2 unchanged, Acme v4 → v6 (same payout as before, the version
bumped on the way out and back — by design). The first (B4-interrupted) run did the same B1–B3 cycle earlier
(Acme v2 → v4; txs in the script log), which is why the baseline above shows v4.

Agent proposals in this round use `agent/scripts/propose-raw.ts` (`npm run propose-raw`): one `propose_payment` signed
with the same restricted function-call key as `npm run pay`, invoice_hash = sha256(memo:run id), no invoice.
