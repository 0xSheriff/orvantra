# Orvantra treasury contract

One treasury per business. It holds a single NEP-141 token (USDC on mainnet, `tUSDC` from
`contracts/test-token` on testnet) and is the **only** place money leaves from. The AI agent can
*propose* payments; the contract decides, using the owner's policy and the vendor registry, whether a
payment executes now, waits for the owner, or is rejected.

```
agent ──propose_payment──► treasury ──get_vendor──► vendor-registry
                              │ policy + registry check (pure functions in src/policy.rs)
                              ├─► Rejected
                              ├─► Pending ──owner approve_payment──► registry re-check ──► payout
                              └─► payout ──► Paid / Failed

payout = token.storage_deposit(destination, registration_only) ──► on_payment_registered
         ──► token.ft_transfer(destination) ──► on_payment_transferred
```

## Roles
| Role | Who | Can do |
|---|---|---|
| `owner` | the human (wallet) | everything below |
| `agent` | separate account; its function-call key only allows `propose_payment` | `propose_payment` only |
| `token` | the configured NEP-141 contract | `ft_on_transfer` (deposits) |

`owner` and `agent` must be different accounts (enforced in `new` and `set_agent`).

## Methods

### Init
`new(owner, agent, registry, token, auto_pay_threshold: U128, monthly_cap: U128, min_payout_age_sec: u64, storage_deposit?: U128, initial_vendor_policies?: [InitialVendorPolicy], cross_chain_auto_pay_threshold?: U128, max_open_payments?: u32, near_reserve?: U128)`
Amounts are strings in token base units (USDC: 6 decimals, so `"100000000"` = 100 USDC).

Safety settings (all optional):
- `cross_chain_auto_pay_threshold` (token units, default `"0"`): cross-chain payouts above it always wait for the
  owner. With the default, **every** cross-chain payout waits (see [Cross-chain payouts](#honest-limit-cross-chain-payouts)).
- `max_open_payments` (default 25, 1..=100): at most this many payments can be Verifying + Pending + Executing at
  once; `propose_payment` panics when it is reached.
- `near_reserve` (yoctoNEAR, default `"500000000000000000000000"` = 0.5 NEAR): free NEAR (balance − locked − storage)
  that must remain after a new payment record is stored, else `propose_payment` panics `treasury needs a NEAR top-up`.
  `withdraw_near` never goes below it either.
`storage_deposit` (yoctoNEAR, optional, default `"1250000000000000000000"` = 0.00125 NEAR, max 0.1 NEAR) is attached to
`token.storage_deposit` before every payout (see [Payout registration](#payout-registration-storage_deposit)).

`initial_vendor_policies` (optional) lets the **deployer** approve vendors at init, so the owner (a human wallet) does
not have to sign setup transactions. Each entry is a JSON object
`{"vendor": "acme.testnet", "max_per_invoice": "500000000", "monthly_cap": "2000000000"}`.
Validated like `set_vendor_policy` (both limits > 0), plus: at most 50 entries and no vendor twice (violations panic,
so the contract is not initialized). Each entry emits the same `vendor_policy_set` event as `set_vendor_policy`.
The owner can later change or remove these policies as usual.

Callers of the Day 3 or Day 5 JSON signature (without the optional arguments) still work.

### Agent
`propose_payment(invoice_hash, vendor, amount, payout_version, deposit_address?, quote_hash?, memo?, agent_flags?) -> Promise`
Attach **≥ 100 TGas** (150 recommended), no deposit. Returns (via the promise chain) the final `PaymentStatus`.

`invoice_hash` must be **64 hex characters** (the agent's sha256); it is stored lowercase, so `AB..` and `ab..` are
the same invoice.

`agent_flags: Option<Vec<String>>` — the agent's own hold reasons (≤ 8 items, each 1–200 **characters**, no blank
strings; violations panic). Non-empty flags mean the payment can **never auto-execute**: it goes **Pending** with
reasons `"agent: <flag>"` (after any contract reasons) and only the owner can approve it in their own wallet.
Flags never override a contract rejection (e.g. not in registry; the reasons are then the agent ones plus the
rejection). Flags are stored **once**, as those `"agent: ..."` entries in `Payment.reasons` (there is no separate
`agent_flags` field any more).

### Owner
| Method | Deposit | Notes |
|---|---|---|
| `set_vendor_policy(vendor, max_per_invoice, monthly_cap)` | 1 yocto | approves a vendor (or set at init, see above) |
| `remove_vendor_policy(vendor)` | 1 yocto | vendor no longer payable by the agent |
| `set_agent(agent)` | 1 yocto | rotate the agent account |
| `set_limits(auto_pay_threshold, monthly_cap, min_payout_age_sec)` | 1 yocto | |
| `set_cross_chain_auto_pay_threshold(amount)` | 1 yocto | cross-chain payouts above it wait for the owner (0 = all) |
| `set_capacity(max_open_payments, near_reserve)` | 1 yocto | open-payment cap (1..=100) and NEAR kept free |
| `set_storage_deposit(amount)` | 1 yocto | yoctoNEAR attached to `storage_deposit` before payouts (1 ..= 0.1 NEAR) |
| `approve_payment(id)` | 1 yocto, ≥ 100 TGas (150 rec.) | panics while paused; Rejected if the vendor's policy was removed; else re-checks the registry, then pays |
| `resolve_executing(id, paid: bool)` | 1 yocto | for a payment stuck in Executing: `true` → Paid, `false` → Failed (cap released). Check the transfer on the explorer first |
| `release_invoice_hash(id)` | 1 yocto | Rejected/Failed payments only: frees the hash so the genuine invoice can be proposed again |
| `withdraw(amount, receiver)` | 1 yocto, ≥ 50 TGas | registers `receiver` on the token, then ft_transfer out; `withdrawal` event after success |
| `withdraw_near(amount)` | 1 yocto | NEAR to the owner, never below `near_reserve`; `near_withdrawal` event after success |
| `unpause()` | 1 yocto | |
| `reject_payment(id, reason)` | none | Pending (or stuck Verifying) → Rejected |
| `pause()` | none | agent can no longer propose, owner can no longer approve, Verifying payments are Rejected when their registry answer arrives |

Requiring exactly 1 yoctoNEAR means these calls need a **full-access key** (function-call keys
cannot attach deposits), so a leaked owner login/function-call key cannot move money. `pause` and
`reject_payment` don't require it because they can only make things safer.

### Token
`ft_on_transfer(sender_id, amount, msg)`: called by the token contract on `ft_transfer_call`.
Returns `"0"` (keep all) if the caller is the configured token, otherwise the full amount (refund).

### Views
`get_payment(id)`, `get_payments(from_index?, limit?)` (max 100), `get_pending()` (max 100),
`get_config()` (also `cross_chain_auto_pay_threshold`, `open_payments`, `max_open_payments`, `near_reserve`,
`available_near`), `get_vendor_policy(vendor)`, `monthly_spent(vendor?)` (rolling 30 days, today included —
exactly what the caps are checked against; `null` = whole treasury), `is_invoice_used(hash)` (case-insensitive).

## Policy rules

**Synchronous checks in `propose_payment`** (violations panic, nothing is stored):
1. caller is `agent`; `invoice_hash` is 64 hex chars; strings within length limits (`deposit_address` ≤ 128,
   `quote_hash` ≤ 128, `memo` ≤ 256 bytes); agent flags as above
2. not paused
3. `invoice_hash` not held by another payment (kept even for rejected payments, unless the owner releases it)
4. fewer than `max_open_payments` payments are open (Verifying + Pending + Executing)
5. vendor has a policy (= approved by the owner)
6. `amount > 0` and `amount ≤ max_per_invoice`
7. vendor's committed spend in the rolling 30 days + amount ≤ vendor `monthly_cap`
8. treasury's committed spend in the rolling 30 days + amount ≤ treasury `monthly_cap`
9. after the record is stored, free NEAR ≥ `near_reserve` (else `treasury needs a NEAR top-up`)

If all pass, the payment is stored as **Verifying**, the hash is burned and the amount is committed to
today's spend counters *before* the registry call, so concurrent proposals can't overshoot the caps.

**After the registry answers** (`on_proposal_checked`):
- treasury paused meanwhile → Rejected("treasury paused before the payment was decided")
- vendor's policy removed meanwhile → Rejected("vendor no longer approved (policy removed)")
- registry call failed → Rejected("registry call failed")
- vendor not in registry → Rejected("not in registry")
- registry `version != payout_version` → Rejected("payout changed since agent checked")
- destination:
  - `payout.chain == "near"` and `payout.asset_id == "nep141:<token>"` → pay `payout.address`
    directly (`direct = true`); any `deposit_address` is ignored.
  - otherwise → pay `deposit_address` (the 1Click deposit address). Required, and it must be a
    **64-char lowercase hex implicit account** that is not the treasury, the token, the agent or the owner;
    else Rejected. The payout snapshot and `quote_hash` are stored with the payment.
- **Pending** (needs the owner) if any of: `amount > auto_pay_threshold`; payout changed less than
  `min_payout_age_sec` ago; no payment to this vendor has ever been Paid; cross-chain payout with
  `amount > cross_chain_auto_pay_threshold` (reason `"cross-chain payout: owner confirms the 1Click deposit address"`);
  the agent sent `agent_flags`. All reasons are recorded (agent ones as `"agent: ..."`).
- otherwise execute now.

**Execute** (status Executing):
1. `token.storage_deposit({account_id: destination, registration_only: true})` attaching `storage_deposit`
   yoctoNEAR from the treasury's NEAR balance → `on_payment_registered`:
   failure → **Failed** (`"storage_deposit failed"`), committed amount released, nothing transferred.
2. `token.ft_transfer(destination, amount, memo)` with 1 yoctoNEAR → `on_payment_transferred`:
   success → **Paid** (vendor becomes "known"); failure → **Failed** (`"ft_transfer failed"`), amount released.

### Payout registration (`storage_deposit`)
A 1Click deposit address for USDC on NEAR is a fresh 64-hex implicit account that is **not registered on the USDC
contract** (`storage_balance_of` = `null`, verified on mainnet), so a bare `ft_transfer` to it fails. The treasury
therefore registers every destination first, direct vendor payouts included:
- NEP-145 `registration_only: true` makes the token take exactly the minimum (0.00125 NEAR on USDC and tUSDC) and
  **refund the excess** to the caller, i.e. the treasury. If the account is already registered, the **whole deposit
  is refunded**. So a payout to a known account costs only gas; a fresh deposit address costs 0.00125 NEAR.
- If the attached amount is below the token's minimum, `storage_deposit` panics, its deposit is refunded with the
  failed receipt, and the payment is **Failed** (cap released). The owner can raise it with `set_storage_deposit`.
- The treasury must keep some NEAR (it also pays storage for payment records). Watch its NEAR balance.

**Approve**: (not paused, vendor still has a policy) Pending → Verifying → pause/policy and registry re-checked
(version *and* payout must be unchanged) → execute, or Rejected with the reason.

**Stuck Executing**: if a payout callback never completes (e.g. out of gas), the owner checks the token transfer on
the explorer and calls `resolve_executing(id, paid)`. Later callbacks for that payment are no-ops. Marking a payment
"not paid" that was in fact paid would free its cap (and, with `release_invoice_hash`, its hash): only resolve after
the transfer receipts have finished.

**Invoice hashes**: every proposal burns its hash. If a forged copy burned the hash of a genuine invoice, the owner
rejects it and calls `release_invoice_hash(id)` (Rejected/Failed only, and only while that payment still holds the
hash), then the genuine invoice can be proposed.

**Monthly accounting — rolling 30 days**: spend is counted per day (`day = block_timestamp / 86400 s`), per vendor
and in total. A cap check sums the last 30 days, today included. Verifying, Pending, Executing and Paid count as
committed; Rejected and Failed release (from the day stored on the payment, even if approved later). An amount stops
counting on the 30th day after it was committed, i.e. 29–30 days later depending on the hour; there is no calendar
boundary at which the cap can be spent twice. Counters that drop to 0 are deleted.

## Events (NEP-297)
`EVENT_JSON:{"standard":"orvantra_treasury","version":"1.0.0","event":...,"data":[...]}`

Payment events (data = id, invoice_hash, vendor, amount, status, destination, direct, quote_hash,
reasons): `payment_proposed`, `payment_pending`, `payment_approved`, `payment_paid`,
`payment_rejected`, `payment_failed`.
`payment_resolved` (`{id, paid}`) precedes the `payment_paid`/`payment_failed` of `resolve_executing`;
`invoice_hash_released` (`{id, invoice_hash}`).
Admin events: `vendor_policy_set` (also emitted at init for each `initial_vendor_policies` entry), `vendor_policy_removed`, `agent_changed`, `limits_changed`,
`cross_chain_threshold_changed`, `capacity_changed`, `storage_deposit_changed`, `paused`, `unpaused`.
Withdrawal events are emitted by the `on_withdrawn` callback, **only after the transfer succeeded**:
`withdrawal` (token) / `near_withdrawal` (NEAR), data `{amount, receiver, asset}`; `withdrawal_failed` otherwise.

## Gas
All cross-contract calls use explicit static gas (constants in `src/lib.rs`):

| Call | Static gas | Expected use |
|---|---|---|
| `registry.get_vendor` | 5 TGas | one map read, ~2-3 TGas |
| `token.storage_deposit` (registration_only) | 10 TGas | one map write + maybe a refund transfer, ~3-5 TGas |
| `on_payment_registered` | 30 TGas | ~3 TGas own + 20 TGas passed on (ft_transfer 10 + on_payment_transferred 10) |
| `token.ft_transfer` | 10 TGas | NEP-141 transfer, ~3-5 TGas |
| `on_payment_transferred` | 10 TGas | ~3 TGas |
| `on_proposal_checked` / `on_approval_checked` | 60 TGas | ~5 TGas own + 40 TGas passed on (storage_deposit 10 + on_payment_registered 30) |

`propose_payment`/`approve_payment` attach 5 + 60 = **65 TGas** statically (everything nested is inside the 60)
plus their own ~5-10 TGas, so attach **≥ 100 TGas; 150 recommended** (the agent and the scripts use 150).
`propose_payment` also reads 2 × 30 daily spend counters (a few TGas). `withdraw` attaches 10 + 10 + 5
(`on_withdrawn`) = 25 TGas statically: attach ≥ 50 TGas. A unit test (`gas_budget_is_consistent`)
checks that each callback's budget covers what it passes on. These are budgets with ~2x margin, not measured
values; check real usage in the testnet receipts. Unused gas is shared out to the calls by the runtime.

## Security model
- **Agent can't steal**: it can only call `propose_payment`. It cannot withdraw, change policy, approve
  or rotate itself. Its key is a function-call key restricted to `propose_payment` on this contract
  (`agent/` `npm run setup-agent-key`; `npm run prove-key-limits` shows everything else is refused).
- **The agent can only make things stricter**: `agent_flags` can force a payment to wait for the owner, never
  make one execute.
- **Invoices can't redirect money**: the destination comes from the vendor registry, which only the
  vendor's own account can edit. A "please pay our new address" email has no effect.
- **Payout changes are slowed down**: a payout newer than `min_payout_age_sec`, a version mismatch, or
  a change while a payment is pending all stop automatic payment.
- **Damage is bounded**: auto-pay only up to `auto_pay_threshold`, per-invoice and monthly caps per
  vendor and per treasury, first payment to any vendor needs the owner, duplicate hashes rejected.
- **Callbacks never panic**, so state changes in callbacks always persist; a stale callback (e.g. after
  the owner rejected a stuck Verifying payment) is a no-op.

### Honest limit: cross-chain payouts
For payouts not in our token on NEAR (e.g. USDC on Base), the treasury pays a **1Click deposit
address** supplied by the agent. The contract **cannot verify on-chain** that this deposit address
belongs to a quote that delivers to the vendor's registry address: the agent verifies the 1Click
quote signature and that `quote.recipient == registry payout` off-chain. A stolen agent key could
propose cross-chain payments to an address its holder controls. What the contract does about it:
- **Default: the owner confirms every cross-chain payout.** `cross_chain_auto_pay_threshold` is 0 unless the owner
  raises it, so such a proposal can only go Pending; nothing moves without the owner's wallet.
- The deposit address must look like a 1Click deposit address (64-hex implicit account) and can't be the
  treasury, token, agent or owner.
- If the owner raises the threshold, auto-paid cross-chain payouts are bounded by it per invoice, by the
  rolling vendor/treasury caps, approved vendors only, vendors already paid once.

**Residual risk**: the owner's approval is only as good as what the owner checks. An implicit account the attacker
controls is also "64 hex". The web UI must show the signed 1Click quote evidence for each held cross-chain payment —
quote signature verified, `quote.recipient` equal to the registry payout, `depositAddress` equal to the payment's
destination, amount — and the owner must not approve without it. The `quote_hash` and payout snapshot are stored with
every payment for audit. Same-chain payouts (`direct = true`) are fully verified on-chain.

### Other limits
- The treasury pays storage for payment records from its own NEAR balance. Records are bounded in
  size (flags stored once: worst case ≈ 7.5 kB with 8 flags of 200 four-byte characters), only the agent can create them (each costs it a
  transaction), at most `max_open_payments` can be open at once, and a proposal is refused once free NEAR
  would drop below `near_reserve`, so payouts and their callbacks stay funded. Daily spend counters are kept
  (≈ 1 per vendor per day with payments); counters released to 0 are deleted.
- Each executed payout to an unregistered account costs the treasury 0.00125 NEAR (token storage). Only payouts that
  pass all policy checks execute, so this is bounded by the same caps as the tokens themselves.
- `get_pending` returns at most 100 entries; `get_payments` pages through all.

## Build & test
```bash
cd contracts/treasury && cargo near build non-reproducible-wasm   # -> target/near/treasury/treasury.wasm
cargo test -p treasury                                             # unit tests (policy + callbacks)
```
The near-workspaces sandbox does not run on Intel macOS, so all decision logic is in pure functions
(`src/policy.rs`) and callbacks are unit-tested directly with mocked promise results.
Promise chains are unit-tested by inspecting the receipts the contract creates (`test_utils::get_created_receipts`):
receiver, method, JSON args, attached deposit, static gas and the `.then` dependency of every call.
End-to-end on testnet: `scripts/testnet-e2e.sh` (Day 3 flow) and `scripts/testnet-day5.sh` (Day 5: agent with a
restricted key, 1Click quotes). Both default to a fresh treasury `orvantra-treasury-v4.testnet` (override with
`TREASURY=...`): this version's state layout is not compatible with earlier treasuries, so deploy it to a new account.
