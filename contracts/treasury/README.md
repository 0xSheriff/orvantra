# Orvantra treasury contract

One treasury per business. It holds a single NEP-141 token (USDC on mainnet, `tUSDC` from
`contracts/test-token` on testnet) and is the **only** place money leaves from. The AI agent can
*propose* payments; the contract decides, using the owner's policy and the vendor registry, whether a
payment executes now, waits for the owner, or is rejected.

```
agent ──propose_payment──► treasury ──get_vendor──► vendor-registry
                              │ policy + registry check (pure functions in src/policy.rs)
                              ├─► Rejected
                              ├─► Pending ──owner approve_payment──► registry re-check ──► ft_transfer
                              └─► ft_transfer(destination) ──► Paid / Failed
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
`new(owner, agent, registry, token, auto_pay_threshold: U128, monthly_cap: U128, min_payout_age_sec: u64)`
Amounts are strings in token base units (USDC: 6 decimals, so `"100000000"` = 100 USDC).

### Agent
`propose_payment(invoice_hash, vendor, amount, payout_version, deposit_address?, quote_hash?, memo?) -> Promise`
Attach **≥ 100 TGas**, no deposit. Returns (via the promise chain) the final `PaymentStatus`.

### Owner
| Method | Deposit | Notes |
|---|---|---|
| `set_vendor_policy(vendor, max_per_invoice, monthly_cap)` | 1 yocto | approves a vendor |
| `remove_vendor_policy(vendor)` | 1 yocto | vendor no longer payable by the agent |
| `set_agent(agent)` | 1 yocto | rotate the agent account |
| `set_limits(auto_pay_threshold, monthly_cap, min_payout_age_sec)` | 1 yocto | |
| `approve_payment(id)` | 1 yocto, ≥ 100 TGas | re-checks the registry, then pays |
| `withdraw(amount, receiver)` | 1 yocto | ft_transfer out of the treasury |
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
  `min_payout_age_sec` ago; no payment to this vendor has ever been Paid. All reasons are recorded.
- otherwise execute now.

**Execute**: `ft_transfer(destination, amount, memo)` with 1 yoctoNEAR → `on_payment_transferred`:
success → **Paid** (vendor becomes "known"); failure → **Failed** and the committed amount is released.

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
`withdrawal`, `paused`, `unpaused`.

## Gas
All cross-contract calls use explicit static gas (constants in `src/lib.rs`):

| Call | Static gas | Expected use |
|---|---|---|
| `registry.get_vendor` | 5 TGas | one map read, ~2-3 TGas |
| `token.ft_transfer` | 10 TGas | NEP-141 transfer, ~3-5 TGas |
| `on_payment_transferred` | 10 TGas | ~3 TGas |
| `on_proposal_checked` / `on_approval_checked` | 45 TGas | ~5 TGas own + 20 TGas for the nested ft_transfer + callback |

`propose_payment`/`approve_payment` attach 5 + 45 = 50 TGas statically (the nested 20 TGas is inside
the 45) plus their own ~5-10 TGas, so attach **100 TGas** for headroom (the e2e script uses 150).
These are budgets with ~2x margin, not measured values; check real usage in the testnet receipts. Unused gas is shared out to the calls by the runtime.

## Security model
- **Agent can't steal**: it can only call `propose_payment`. It cannot withdraw, change policy, approve
  or rotate itself. Its key should be a function-call key restricted to `propose_payment` on this
  contract (Day 4).
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
- `get_pending` returns at most 100 entries; `get_payments` pages through all.

## Build & test
```bash
cd contracts/treasury && cargo near build non-reproducible-wasm   # -> target/near/treasury/treasury.wasm
cargo test -p treasury                                             # unit tests (policy + callbacks)
```
The near-workspaces sandbox does not run on Intel macOS, so all decision logic is in pure functions
(`src/policy.rs`) and callbacks are unit-tested directly with mocked promise results.
End-to-end on testnet: `scripts/testnet-e2e.sh` (see the script header).
