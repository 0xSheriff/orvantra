# vendor-registry

Each vendor (a NEAR account such as `acme.near`) publishes **its own** payout details on-chain.
Only the vendor account itself (`env::predecessor_account_id()`) can create, update or remove its
entry. A payer's agent reads the registry instead of trusting the address printed on an invoice, so
a "we changed our bank details, please pay 0xBAD" email can't redirect a payment.

- Every payout change bumps `version` and `updated_at_ns`. The agent uses `payout_age_ns` to hold
  payments to payout details that changed recently.
- **Storage is paid by the vendor** (see [Storage deposits](#storage-deposits)): nobody can make the
  contract pay for entries, and removing an entry refunds what the vendor paid.
- The version never restarts: if a vendor removes its entry and registers again, `version` continues
  from the last one (with a fresh `updated_at_ns`), so one version number never names two payouts.
- No init call is needed for a fresh deploy: the contract starts with an empty registry. Upgrading the
  live registry needs `migrate` (see [Upgrade](#upgrade-from-the-previous-version)).

## Security: payout changes need a full-access wallet confirmation

`set_vendor` needs an attached deposit (≥ 1 yoctoNEAR, plus storage when the entry is created or grows) and
`remove_vendor` exactly 1 yoctoNEAR. Without a deposit `set_vendor` fails with
`Requires attached deposit of at least 1 yoctoNEAR ...`; `remove_vendor` with anything but 1 yocto fails with
`Requires attached deposit of exactly 1 yoctoNEAR`.

Why: when a vendor signs in to a dapp, the wallet usually hands the browser a **function-call
access key** limited to this contract. Such keys can call methods without a wallet prompt, but they
**cannot attach any deposit**. Requiring a deposit therefore means every payout change must be signed
with a full-access key, i.e. the vendor explicitly confirms it in their wallet. Malicious script on
a page (or a leaked limited key) cannot silently redirect a vendor's payouts.

This also applies to gasless updates: the NEP-366 delegate action carries the deposit itself (taken from
the vendor's balance) and is signed by the vendor's full-access key; the relayer only pays gas. A vendor
therefore needs a little NEAR to **create** an entry (≈ 0.004–0.009 NEAR); same-size updates and removal
still cost only 1 yocto.

## Storage deposits

Storage is measured as the change in `env::storage_usage()` during the call, at 1e19 yoctoNEAR per byte:

| Call | Must attach | Kept by the contract | Refunded to the caller |
|---|---|---|---|
| `set_vendor`, new entry | ≥ storage cost of the entry | the storage cost | the excess |
| `set_vendor`, update, same size | ≥ 1 yocto | 1 yocto | the excess |
| `set_vendor`, update that grows | ≥ 1 yocto + growth cost | 1 yocto + growth cost | the excess |
| `set_vendor`, update that shrinks | ≥ 1 yocto | 1 yocto | the excess + the freed storage the vendor paid for |
| `remove_vendor` | exactly 1 yocto | 1 yocto | the entry's storage (what the vendor paid for it) |

What a vendor paid is recorded (`storage_paid`). Each account also keeps a small record (65 bytes + account id,
paid at creation) that survives `remove_vendor`: it holds `paid_storage` and the last version.

Size of a new entry, in bytes: **`227 + 2 × account id + display_name (UTF-8 bytes) + chain + asset_id + address`**.
Examples (cost = bytes × 0.00001 NEAR):
- `acme.near`, `"Acme Ltd"`, USDC on Base, `0x…` address: 363 bytes = **0.00363 NEAR**
- `storage_cost_estimate(20, 42, 64)` (20-byte name, EVM address, USDC-on-Base asset id; assumes a 64-char account
  and the longest chain name): 490 bytes = **0.0049 NEAR**
- the largest possible entry (64-char account, 64 four-byte name characters, 128-byte asset and address): 876 bytes
  = 0.00876 NEAR, so **0.01 NEAR always suffices** (the excess comes back).

If a refund goes to an account that no longer exists, the transfer fails and the NEAR stays with the contract.

## Upgrade from the previous version

The previous version stored only the vendors map and paid for storage itself. This version adds the per-account
records, so the live registry must be migrated in the **same transaction** as the code deploy:

```bash
near contract deploy orvantra-registry.testnet use-file target/near/vendor_registry/vendor_registry.wasm \
  with-init-call migrate json-args '{}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-legacy-keychain send
```

`migrate` (`#[private]`, `#[init(ignore_state)]`) reads the old state and keeps every entry unchanged (payout,
timestamps, version). Existing entries get `paid_storage = 0`: they stay removable (no refund), a same-size update
still costs 1 yocto, and growth is charged like any other entry. Calling `migrate` again fails
(`Cannot deserialize the contract state`), so it can't reset the new records.

## Methods

| Method | Kind | Description |
|---|---|---|
| `set_vendor(display_name, chain, asset_id, address)` | call, **deposit** (see [Storage deposits](#storage-deposits)) | Create or update the **caller's** entry. A payout change (`chain`/`asset_id`/`address`) bumps `version` + `updated_at_ns` and emits `payout_updated`. A name-only change bumps neither and emits no event. Returns the `VendorView`. |
| `remove_vendor()` | call, **1 yoctoNEAR** | Delete the caller's own entry and refund its storage. Panics if the caller has no entry. Emits `vendor_removed`. |
| `migrate()` | private init | One-time upgrade from the previous state layout (see above). |
| `storage_cost_estimate(display_name_len, address_len, asset_len)` | view | yoctoNEAR (string) to attach when creating an entry; lengths in bytes. An upper bound (assumes a 64-char account id and the longest chain name). |
| `storage_paid(account_id)` | view | yoctoNEAR (string) the account paid for storage and has not had refunded. |
| `get_vendor(account_id)` | view | `VendorView` or `null`. |
| `get_vendors(from_index?, limit?)` | view | Page of `VendorView`. `limit` defaults to and is capped at 100. Removing an entry moves the last entry into its slot, so pages can shift. |
| `payout_age_ns(account_id)` | view | `now - updated_at_ns` as a string, or `null`. |
| `count()` | view | Number of registered vendors. |

`VendorView`:
```json
{ "account_id": "acme.testnet", "display_name": "Acme Ltd",
  "payout": { "chain": "base", "asset_id": "nep141:base-0x8335...omft.near", "address": "0x1111...1111" },
  "created_at_ns": "1793929452000000000", "updated_at_ns": "1793929452000000000", "version": 1 }
```
Timestamps are strings because nanosecond values are too large for JavaScript numbers.

### Validation
- `display_name`: 1..64 characters, not all whitespace, no control characters.
- `asset_id` (1Click asset id): 1..128 printable ASCII characters, no spaces.
- `chain`: lowercase, one of `near`, `eth`, `base`, `arbitrum`, `optimism`, `polygon`, `bsc`,
  `avalanche`, `gnosis`, `solana`, `tron`, `btc`, `ton`, `sui`, `stellar`.
- `address`: at most 128 characters, and
  - `near`: a valid NEAR account id;
  - EVM chains: `0x` followed by 40 hex characters;
  - other chains: 20..128 printable ASCII characters, no spaces.

### Events (NEP-297)
Logged as `EVENT_JSON:{"standard":"orvantra_registry","version":"1.0.0","event":...,"data":[{...}]}`:

| event | data fields |
|---|---|
| `vendor_registered` | `account_id, display_name, chain, asset_id, address, version` |
| `payout_updated` | `account_id, old_chain, old_asset_id, old_address, new_chain, new_asset_id, new_address, new_version` |
| `vendor_removed` | `account_id, storage_refund` (yoctoNEAR string) |

## Build

```bash
cd contracts/vendor-registry
cargo near build non-reproducible-wasm
# -> target/near/vendor_registry/vendor_registry.wasm (at the workspace root)
```

## Test

```bash
cargo test -p vendor-registry          # from the repo root
```

- **Unit tests** (`src/tests.rs`, `testing_env!`) run everywhere.
- **Integration test** (`tests/sandbox.rs`, near-workspaces) builds the wasm, starts a local
  sandbox node, deploys, and checks that alice registers (paying storage), creating with only 1 yocto
  fails, bob's calls only touch bob's own entry, and the views return the expected data. It runs on linux-x86_64, linux-aarch64 and darwin-arm64.
  Intel macOS has no published sandbox binary, so the test is compiled out there. If you have a
  `near-sandbox` binary you built yourself, run it with:

  ```bash
  RUSTFLAGS="--cfg orvantra_sandbox" NEAR_SANDBOX_BIN_PATH=/path/to/near-sandbox \
    cargo test -p vendor-registry --test sandbox
  ```

## Try it on testnet (do X -> see Y)

Assumes the wasm is built and you have testnet accounts `registry.orvantra.testnet` (contract) and
`acme-demo.testnet` (vendor) in your keychain. Uses near CLI (near-cli-rs).

1. **Deploy** to a fresh account (no init function needed; to upgrade an existing registry use `migrate`, see above):
   ```bash
   near contract deploy registry.orvantra.testnet \
     use-file target/near/vendor_registry/vendor_registry.wasm \
     without-init-call network-config testnet sign-with-keychain send
   ```
   -> The transaction succeeds and `count` returns `0`.

2. **Vendor registers its payout** (USDC on Base):
   ```bash
   near contract call-function as-transaction registry.orvantra.testnet set_vendor \
     json-args '{"display_name":"Acme Ltd","chain":"base","asset_id":"nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near","address":"0x1111111111111111111111111111111111111111"}' \
     prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' \
     sign-as acme-demo.testnet network-config testnet sign-with-keychain send
   ```
   -> The logs show `EVENT_JSON:{"standard":"orvantra_registry",...,"event":"vendor_registered",...}`.
   The entry's storage (379 bytes = 0.00379 NEAR for this account) is kept and the rest of the 0.01 NEAR is refunded;
   `storage_paid {"account_id":"acme-demo.testnet"}` shows what was kept. With `attached-deposit '1 yoctoNEAR'`
   the call fails with `attached deposit too small`.

3. **Read it back as a payer would**:
   ```bash
   near contract call-function as-read-only registry.orvantra.testnet get_vendor \
     json-args '{"account_id":"acme-demo.testnet"}' network-config testnet now
   ```
   -> `VendorView` with `"version": 1` and the address from step 2.

4. **Vendor changes its payout address**: repeat step 2 with
   `"address":"0x2222222222222222222222222222222222222222"` and `attached-deposit '1 yoctoNEAR'` (same size,
   so no storage is added).
   -> The logs show `payout_updated` with `old_address` `0x1111...` and `new_address` `0x2222...`.
   `get_vendor` now shows `"version": 2`, and `payout_age_ns` returns a small number. This is the
   signal the agent uses to force the payment to PENDING.

5. **Bad input is rejected**: repeat step 2 with `"address":"0xBAD"`.
   -> The transaction fails with `address must be 0x followed by 40 hex chars`.

6. **Nobody else can edit Acme's entry**: run step 2 signed by another account (`sign-as other.testnet`).
   -> This creates or updates `other.testnet`'s own entry. `get_vendor` for `acme-demo.testnet` is
   unchanged.

7. **A payout change needs a deposit** (so a limited function-call key can't do it): repeat
   step 4 with `attached-deposit '0 NEAR'`.
   -> The transaction fails with `Requires attached deposit of at least 1 yoctoNEAR`.

8. **Vendor removes its entry**:
   ```bash
   near contract call-function as-transaction registry.orvantra.testnet remove_vendor \
     json-args '{}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' \
     sign-as acme-demo.testnet network-config testnet sign-with-keychain send
   ```
   -> The logs show `vendor_removed` with `storage_refund` (the entry's storage comes back to
   `acme-demo.testnet`); `get_vendor` returns `null`. Registering again (step 2) gives `"version": 3`.
