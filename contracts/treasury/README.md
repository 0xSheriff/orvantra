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
`new(owner, agent, registry, token, auto_pay_threshold: U128, monthly_cap: U128, min_payout_age_sec: u64, storage_deposit?: U128)`
Amounts are strings in token base units (USDC: 6 decimals, so `"100000000"` = 100 USDC).
`storage_deposit` (yoctoNEAR, optional, default `"1250000000000000000000"` = 0.00125 NEAR, max 0.1 NEAR) is attached to
`token.storage_deposit` before every payout (see [Payout registration](#payout-registration-storage_deposit)).
Callers of the Day 3 signature (without `storage_deposit`) still work.

### Agent
`propose_payment(invoice_hash, vendor, amount, payout_version, deposit_address?, quote_hash?, memo?, agent_flags?) -> Promise`
Attach **≥ 100 TGas** (150 recommended), no deposit. Returns (via the promise chain) the final `PaymentStatus`.

`agent_flags: Option<Vec<String>>` — the agent's own hold reasons (≤ 8 items, each 1–200 **characters**, no blank
strings; violations panic). Non-empty flags mean the payment can **never auto-execute**: it goes **Pending** with
reasons `"agent: <flag>"` (added after any contract reasons) and only the owner can approve it in their own wallet.
Flags never override a contract rejection (e.g. not in registry). The raw flags are stored in `Payment.agent_flags`.

### Owner
| Method | Deposit | Notes |
|---|---|---|
| `set_vendor_policy(vendor, max_per_invoice, monthly_cap)` | 1 yocto | approves a vendor |
| `remove_vendor_policy(vendor)` | 1 yocto | vendor no longer payable by the agent |
| `set_agent(agent)` | 1 yocto | rotate the agent account |
| `set_limits(auto_pay_threshold, monthly_cap, min_payout_age_sec)` | 1 yocto | |
| `set_storage_deposit(amount)` | 1 yocto | yoctoNEAR attached to `storage_deposit` before payouts (1 ..= 0.1 NEAR) |
| `approve_payment(id)` | 1 yocto, ≥ 100 TGas (150 rec.) | re-checks the registry, then pays |
| `withdraw(amount, receiver)` | 1 yocto, ≥ 50 TGas | registers `receiver` on the token, then ft_transfer out |
| `unpause()` | 1 yocto | |
| `reject_payment(id, reason)` | none | Pending (or stuck Verifying) → Rejected |
| `pause()` | none | agent can no longer propose |

Requiring exactly 1 yoctoNEAR means these calls need a **full-access key** (function-call keys
cannot attach deposits), so a leaked owner login/function-call key cannot move money. `pause` and
`reject_payment` don't require it because they can only make things safer.

### Token
`ft_on_transfer(sender_id, amount, msg)`: called by the token contract on `ft_transfer_call`.
Returns `"0"` (keep all) if the caller is the configured token, otherwise the full amount (refund).

### Views
`get_payment(id)`, `get_payments(from_index?, limit?)` (max 100), `get_pending()` (max 100),
`get_config()`, `get_vendor_policy(vendor)`, `monthly_spent(vendor?)` (current 30-day bucket;
`null` = whole treasury), `is_invoice_used(hash)`.

## Policy rules

**Synchronous checks in `propose_payment`** (violations panic, nothing is stored):
1. caller is `agent`; strings within length limits (`invoice_hash` ≤ 128, `deposit_address` ≤ 128,
   `quote_hash` ≤ 128, `memo` ≤ 256 bytes)
2. not paused
3. `invoice_hash` never proposed before (every hash is kept forever, even for rejected payments)
4. vendor has a policy (= approved by the owner)
5. `amount > 0` and `amount ≤ max_per_invoice`
6. vendor's committed spend this month + amount ≤ vendor `monthly_cap`
7. treasury's committed spend this month + amount ≤ treasury `monthly_cap`

If all pass, the payment is stored as **Verifying**, the hash is burned and the amount is committed to
this month's caps *before* the registry call, so concurrent proposals can't overshoot the caps.

**After the registry answers** (`on_proposal_checked`):
- registry call failed → Rejected("registry call failed")
- vendor not in registry → Rejected("not in registry")
- registry `version != payout_version` → Rejected("payout changed since agent checked")
- destination:
  - `payout.chain == "near"` and `payout.asset_id == "nep141:<token>"` → pay `payout.address`
    directly (`direct = true`); any `deposit_address` is ignored.
  - otherwise → pay `deposit_address` (the 1Click deposit address; required and must be a valid NEAR
    account id, else Rejected). The payout snapshot and `quote_hash` are stored with the payment.
- **Pending** (needs the owner) if any of: `amount > auto_pay_threshold`; payout changed less than
  `min_payout_age_sec` ago; no payment to this vendor has ever been Paid; the agent sent `agent_flags`.
  All reasons are recorded (agent ones as `"agent: ..."`).
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

**Approve**: Pending → Verifying → registry re-checked (version *and* payout must be unchanged) →
execute, or Rejected("payout changed since agent checked").

**Monthly accounting**: 30-day buckets, `bucket = block_timestamp / (30 days)`, per vendor and in
total. Verifying, Pending, Executing and Paid count as committed; Rejected and Failed release. A
payment stays in the bucket it was proposed in, even if approved later.

## Events (NEP-297)
`EVENT_JSON:{"standard":"orvantra_treasury","version":"1.0.0","event":...,"data":[...]}`

Payment events (data = id, invoice_hash, vendor, amount, status, destination, direct, quote_hash,
reasons): `payment_proposed`, `payment_pending`, `payment_approved`, `payment_paid`,
`payment_rejected`, `payment_failed`.
Admin events: `vendor_policy_set`, `vendor_policy_removed`, `agent_changed`, `limits_changed`,
`storage_deposit_changed`, `withdrawal`, `paused`, `unpaused`.

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
`withdraw` attaches 10 + 10 = 20 TGas statically: attach ≥ 50 TGas. A unit test (`gas_budget_is_consistent`)
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
quote signature and that `quote.recipient == registry payout` off-chain. A compromised agent could
therefore send cross-chain payments to an address it controls. The damage is bounded by the caps above:
at most `auto_pay_threshold` per invoice without the owner, within vendor and treasury monthly caps,
only for approved vendors, and only for vendors already paid once. The `quote_hash` and payout snapshot
are stored with every payment for audit. Same-chain payouts (`direct = true`) are fully verified
on-chain.

### Other limits
- The treasury pays storage for payment records from its own NEAR balance. Records are bounded in
  size; only the agent can create them and each costs it a transaction.
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
restricted key, 1Click quotes, fresh treasury `orvantra-treasury-v2.testnet`).
