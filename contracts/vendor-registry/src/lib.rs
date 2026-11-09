//! Orvantra vendor registry.
//!
//! Each vendor (a NEAR account, e.g. `acme.near`) publishes its OWN payout details here. Only the
//! vendor account itself (`env::predecessor_account_id()`) can create, update or remove its entry.
//! Payers' agents read the registry instead of trusting addresses printed on invoices, so a
//! "please pay our new address" email cannot redirect a payment.
//!
//! Using `predecessor_account_id` (not `signer_account_id`) means the entry belongs to whoever
//! directly called the contract. With NEP-366 meta transactions the predecessor is still the vendor
//! (the relayer only pays gas), so registration can be gasless for the vendor later on.
//!
//! # Full-access confirmation (attached deposit)
//! `set_vendor` needs an attached deposit (>= 1 yoctoNEAR, see Storage) and `remove_vendor` exactly
//! 1 yoctoNEAR. Function-call access keys (the limited keys a browser dapp gets at sign-in) cannot
//! attach deposits, so every payout change needs a full-access key, i.e. an explicit confirmation
//! in the vendor's wallet. A leaked or misused limited key cannot silently redirect payments.
//!
//! # Storage (paid by the vendor)
//! Each vendor pays for its own entry, measured as the change in `env::storage_usage()`:
//! - creating an entry needs a deposit >= its storage cost; the excess is refunded;
//! - an update needs >= 1 yoctoNEAR plus the cost of any growth; the 1 yocto is kept, the excess
//!   refunded; if the entry shrinks, the freed part of what the vendor paid is refunded;
//! - `remove_vendor` refunds what the vendor paid for the entry. A small record per account stays
//!   (paid at creation): it keeps `version` monotonic if the vendor registers again.
//! So nobody can make the contract pay for storage. Entries from before this rule (migrated by
//! `migrate`) have `paid_storage = 0`: they stay removable, and removing them refunds nothing.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, BorshStorageKey, NearToken, Promise, Timestamp,
};

/// Max length of `display_name`, in characters.
pub const MAX_DISPLAY_NAME_CHARS: usize = 64;
/// Max length of `asset_id`, in bytes (ASCII only).
pub const MAX_ASSET_ID_LEN: usize = 128;
/// Max length of `address`, in bytes (ASCII only).
pub const MAX_ADDRESS_LEN: usize = 128;
/// Min length of an address on chains without a dedicated format check.
pub const MIN_OTHER_ADDRESS_LEN: usize = 20;
/// Max page size for `get_vendors`.
pub const MAX_PAGE_LIMIT: u32 = 100;

/// Chains whose addresses are EVM style (`0x` + 40 hex chars).
pub const EVM_CHAINS: &[&str] = &[
    "eth", "base", "arbitrum", "optimism", "polygon", "bsc", "avalanche", "gnosis",
];
/// Non-EVM chains other than NEAR. Addresses get a generic sanity check.
pub const OTHER_CHAINS: &[&str] = &["solana", "tron", "btc", "ton", "sui", "stellar"];

pub const EVENT_STANDARD: &str = "orvantra_registry";
pub const EVENT_VERSION: &str = "1.0.0";

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Payout {
    /// Lowercase chain name, e.g. "near", "base", "solana".
    pub chain: String,
    /// 1Click asset id, e.g. `nep141:17208628f8...` for USDC on NEAR.
    pub asset_id: String,
    /// Recipient address on `chain`.
    pub address: String,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Vendor {
    pub display_name: String,
    pub payout: Payout,
    pub created_at_ns: Timestamp,
    /// Time of the last PAYOUT change (not display-name changes).
    pub updated_at_ns: Timestamp,
    /// Starts at 1, +1 on every payout change.
    pub version: u32,
}

/// JSON view of a vendor. Timestamps are strings (`U64`) because nanosecond values exceed
/// JavaScript's safe integer range.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VendorView {
    pub account_id: AccountId,
    pub display_name: String,
    pub payout: Payout,
    pub created_at_ns: U64,
    pub updated_at_ns: U64,
    pub version: u32,
}

impl VendorView {
    fn new(account_id: AccountId, v: &Vendor) -> Self {
        Self {
            account_id,
            display_name: v.display_name.clone(),
            payout: v.payout.clone(),
            created_at_ns: v.created_at_ns.into(),
            updated_at_ns: v.updated_at_ns.into(),
            version: v.version,
        }
    }
}

/// Per-account bookkeeping, kept after `remove_vendor` (tombstone).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VendorAccount {
    /// yoctoNEAR the vendor has paid for storage and not had refunded.
    pub paid_storage: u128,
    /// `version` of the entry when it was last removed (0 = never removed). Re-registering
    /// continues at `last_version + 1`, so a version number never means two different payouts.
    pub last_version: u32,
}

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Vendors,
    Accounts,
}

#[near(contract_state)]
pub struct VendorRegistry {
    vendors: IterableMap<AccountId, Vendor>,
    accounts: LookupMap<AccountId, VendorAccount>,
}

impl Default for VendorRegistry {
    fn default() -> Self {
        Self {
            vendors: IterableMap::new(StorageKey::Vendors),
            accounts: LookupMap::new(StorageKey::Accounts),
        }
    }
}

/// The state layout before vendors paid for storage (only the vendors map). Read by `migrate`.
#[near(serializers = [borsh])]
pub struct RegistryV1 {
    pub vendors: IterableMap<AccountId, Vendor>,
}

pub const ERR_NO_DEPOSIT: &str =
    "Requires attached deposit of at least 1 yoctoNEAR (plus storage, see storage_cost_estimate)";

/// Storage bytes of a new entry (vendor entry + per-account record):
/// `ENTRY_BASE_BYTES + 2 x account id + the payout/name strings`. The base covers borsh length
/// prefixes, timestamps, version, index and the runtime's 40-byte overhead per storage record.
/// Measured with `env::storage_usage()` in the unit tests.
pub const ENTRY_BASE_BYTES: u64 = 227;
/// Storage bytes of the per-account record alone: `TOMBSTONE_BASE_BYTES + account id`.
pub const TOMBSTONE_BASE_BYTES: u64 = 65;
/// Longest NEAR account id and longest supported chain name, used by `storage_cost_estimate`.
pub const MAX_ACCOUNT_ID_LEN: u64 = 64;
pub const MAX_CHAIN_LEN: u64 = 9;

pub fn entry_storage_bytes(account_len: u64, name_len: u64, chain_len: u64, asset_len: u64, address_len: u64) -> u64 {
    ENTRY_BASE_BYTES + 2 * account_len + name_len + chain_len + asset_len + address_len
}

#[near]
impl VendorRegistry {
    /// One-time upgrade from the `RegistryV1` layout: keeps every entry (and its version) and adds
    /// the per-account records (`paid_storage = 0` for existing entries). Fails if the state is
    /// already in the new layout. Call it in the same transaction as the code deploy.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: RegistryV1 =
            env::state_read().unwrap_or_else(|| env::panic_str("no registry state to migrate"));
        Self { vendors: old.vendors, accounts: LookupMap::new(StorageKey::Accounts) }
    }

    /// Create or update the caller's own entry.
    ///
    /// Changing `chain`, `asset_id` or `address` bumps `version` and `updated_at_ns` and emits
    /// `payout_updated`. Changing only `display_name` does neither.
    /// Deposit: creating needs >= the entry's storage cost (see `storage_cost_estimate`), updating
    /// needs >= 1 yoctoNEAR plus any storage growth. The excess is refunded (see the module docs).
    #[payable]
    pub fn set_vendor(
        &mut self,
        display_name: String,
        chain: String,
        asset_id: String,
        address: String,
    ) -> VendorView {
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= 1, ERR_NO_DEPOSIT);
        let payout = Payout { chain, asset_id, address };
        if let Err(e) = validate(&display_name, &payout) {
            env::panic_str(&e);
        }

        let account_id = env::predecessor_account_id();
        let now = env::block_timestamp();
        let before = self.storage_used();
        let created = !self.vendors.contains_key(&account_id);

        let view = match self.vendors.get_mut(&account_id) {
            None => {
                let version = match self.accounts.get(&account_id) {
                    Some(a) => a.last_version + 1,
                    None => {
                        let record = VendorAccount { paid_storage: 0, last_version: 0 };
                        self.accounts.insert(account_id.clone(), record);
                        1
                    }
                };
                let vendor = Vendor {
                    display_name,
                    payout,
                    created_at_ns: now,
                    updated_at_ns: now,
                    version,
                };
                emit(
                    "vendor_registered",
                    json!({
                        "account_id": account_id,
                        "display_name": vendor.display_name,
                        "chain": vendor.payout.chain,
                        "asset_id": vendor.payout.asset_id,
                        "address": vendor.payout.address,
                        "version": vendor.version,
                    }),
                );
                let view = VendorView::new(account_id.clone(), &vendor);
                self.vendors.insert(account_id.clone(), vendor);
                view
            }
            Some(vendor) => {
                vendor.display_name = display_name;
                if vendor.payout != payout {
                    let old = std::mem::replace(&mut vendor.payout, payout);
                    vendor.version += 1;
                    vendor.updated_at_ns = now;
                    emit(
                        "payout_updated",
                        json!({
                            "account_id": account_id,
                            "old_chain": old.chain,
                            "old_asset_id": old.asset_id,
                            "old_address": old.address,
                            "new_chain": vendor.payout.chain,
                            "new_asset_id": vendor.payout.asset_id,
                            "new_address": vendor.payout.address,
                            "new_version": vendor.version,
                        }),
                    );
                }
                VendorView::new(account_id.clone(), vendor)
            }
        };

        // Entries from before vendors paid for storage have no record yet; if such an entry
        // grows, start one so the vendor's payment is tracked (and refundable).
        let mut after = self.storage_used();
        if after > before && !self.accounts.contains_key(&account_id) {
            let record = VendorAccount { paid_storage: 0, last_version: 0 };
            self.accounts.insert(account_id.clone(), record);
            after = self.storage_used();
        }

        let byte_cost = env::storage_byte_cost().as_yoctonear();
        let refund = if after >= before {
            let charge = u128::from(after - before) * byte_cost;
            // Creating: pay the storage. Updating: 1 yocto (kept) + any growth.
            let required = if created { charge } else { charge + 1 };
            if deposit < required {
                env::panic_str(&format!(
                    "attached deposit too small: this needs {required} yoctoNEAR ({} bytes of storage), got {deposit}",
                    after - before
                ));
            }
            if charge > 0 {
                self.change_paid(&account_id, |paid| paid + charge);
            }
            deposit - required
        } else {
            // Shrunk: give back the freed part of what this vendor paid.
            let freed = u128::from(before - after) * byte_cost;
            let back = self.release_paid(&account_id, freed);
            deposit - 1 + back
        };
        refund_to(&account_id, refund);
        view
    }

    /// Delete the caller's own entry and refund the storage the vendor paid for it. A small
    /// per-account record stays so a later re-registration continues the version numbering.
    /// Panics if the caller has no entry. Requires exactly 1 yoctoNEAR attached (full-access key).
    #[payable]
    pub fn remove_vendor(&mut self) {
        assert_one_yocto();
        let account_id = env::predecessor_account_id();
        let before = self.storage_used();
        let removed = self.vendors.remove(&account_id);
        let Some(removed) = removed else { env::panic_str("vendor not registered") };
        let mut record = self
            .accounts
            .get(&account_id)
            .cloned()
            .unwrap_or(VendorAccount { paid_storage: 0, last_version: 0 });
        record.last_version = removed.version;
        self.accounts.insert(account_id.clone(), record);
        let after = self.storage_used();
        let freed = u128::from(before.saturating_sub(after)) * env::storage_byte_cost().as_yoctonear();
        let refund = self.release_paid(&account_id, freed);
        refund_to(&account_id, refund);
        emit(
            "vendor_removed",
            json!({ "account_id": account_id, "storage_refund": U128(refund) }),
        );
    }

    /// yoctoNEAR to attach to `set_vendor` when creating an entry with these lengths (in bytes)
    /// of `display_name` (UTF-8), `address` and `asset_id`. Assumes the longest account id and
    /// chain name, so it is an upper bound; the excess is refunded.
    pub fn storage_cost_estimate(&self, display_name_len: u32, address_len: u32, asset_len: u32) -> U128 {
        let bytes = entry_storage_bytes(
            MAX_ACCOUNT_ID_LEN,
            u64::from(display_name_len),
            MAX_CHAIN_LEN,
            u64::from(asset_len),
            u64::from(address_len),
        );
        U128(u128::from(bytes) * env::storage_byte_cost().as_yoctonear())
    }

    /// yoctoNEAR the account has paid for storage and not had refunded (0 if none).
    pub fn storage_paid(&self, account_id: AccountId) -> U128 {
        U128(self.accounts.get(&account_id).map(|a| a.paid_storage).unwrap_or(0))
    }

    pub fn get_vendor(&self, account_id: AccountId) -> Option<VendorView> {
        self.vendors.get(&account_id).map(|v| VendorView::new(account_id, v))
    }

    /// Page through vendors. `limit` defaults to and is capped at `MAX_PAGE_LIMIT`.
    /// Note: order is insertion order, except that removing an entry moves the last entry into
    /// its slot, so pages can shift between calls if vendors are removed.
    pub fn get_vendors(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<VendorView> {
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(MAX_PAGE_LIMIT).min(MAX_PAGE_LIMIT) as usize;
        self.vendors
            .iter()
            .skip(from)
            .take(limit)
            .map(|(id, v)| VendorView::new(id.clone(), v))
            .collect()
    }

    /// Nanoseconds since the vendor's payout last changed (`now - updated_at_ns`).
    /// Agents use this to hold payments to recently changed payout details.
    pub fn payout_age_ns(&self, account_id: AccountId) -> Option<U64> {
        self.vendors
            .get(&account_id)
            .map(|v| env::block_timestamp().saturating_sub(v.updated_at_ns).into())
    }

    pub fn count(&self) -> u32 {
        self.vendors.len()
    }
}

impl VendorRegistry {
    /// Write cached collection changes so `env::storage_usage()` is current.
    fn storage_used(&mut self) -> u64 {
        self.vendors.flush();
        self.accounts.flush();
        env::storage_usage()
    }

    /// Update the account's `paid_storage` (the record exists whenever storage was charged).
    fn change_paid(&mut self, account_id: &AccountId, f: impl FnOnce(u128) -> u128) {
        if let Some(record) = self.accounts.get_mut(account_id) {
            record.paid_storage = f(record.paid_storage);
        }
    }

    /// Take up to `amount` back out of what the account paid; returns what was taken.
    fn release_paid(&mut self, account_id: &AccountId, amount: u128) -> u128 {
        let paid = self.accounts.get(account_id).map(|a| a.paid_storage).unwrap_or(0);
        let back = paid.min(amount);
        self.change_paid(account_id, |p| p - back);
        back
    }
}

/// Send `amount` yoctoNEAR back to `to` (nothing if 0). If the account no longer exists, the
/// transfer fails and the NEAR returns to this contract.
fn refund_to(to: &AccountId, amount: u128) {
    if amount > 0 {
        Promise::new(to.clone()).transfer(NearToken::from_yoctonear(amount)).detach();
    }
}

/// Emit a NEP-297 event: `EVENT_JSON:{"standard","version","event","data":[...]}`.
fn emit(event: &str, data: serde_json::Value) {
    let log = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{log}"));
}

/// Validate all user input. Returns a human-readable error.
pub fn validate(display_name: &str, payout: &Payout) -> Result<(), String> {
    validate_display_name(display_name)?;
    validate_asset_id(&payout.asset_id)?;
    validate_address(&payout.chain, &payout.address)
}

fn validate_display_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("display_name must not be empty".into());
    }
    if name.chars().count() > MAX_DISPLAY_NAME_CHARS {
        return Err(format!("display_name longer than {MAX_DISPLAY_NAME_CHARS} chars"));
    }
    if name.chars().any(char::is_control) {
        return Err("display_name contains control characters".into());
    }
    Ok(())
}

fn validate_asset_id(asset_id: &str) -> Result<(), String> {
    if asset_id.is_empty() {
        return Err("asset_id must not be empty".into());
    }
    if asset_id.len() > MAX_ASSET_ID_LEN {
        return Err(format!("asset_id longer than {MAX_ASSET_ID_LEN} chars"));
    }
    if !asset_id.bytes().all(|b| b.is_ascii_graphic()) {
        return Err("asset_id must be printable ASCII without spaces".into());
    }
    Ok(())
}

fn validate_address(chain: &str, address: &str) -> Result<(), String> {
    if address.is_empty() {
        return Err("address must not be empty".into());
    }
    if address.len() > MAX_ADDRESS_LEN {
        return Err(format!("address longer than {MAX_ADDRESS_LEN} chars"));
    }
    if chain == "near" {
        address
            .parse::<AccountId>()
            .map(|_| ())
            .map_err(|_| "address is not a valid NEAR account id".to_string())
    } else if EVM_CHAINS.contains(&chain) {
        let ok = address.len() == 42
            && address.starts_with("0x")
            && address[2..].bytes().all(|b| b.is_ascii_hexdigit());
        if ok {
            Ok(())
        } else {
            Err("address must be 0x followed by 40 hex chars".into())
        }
    } else if OTHER_CHAINS.contains(&chain) {
        let ok = address.len() >= MIN_OTHER_ADDRESS_LEN
            && address.bytes().all(|b| b.is_ascii_graphic());
        if ok {
            Ok(())
        } else {
            Err(format!(
                "address must be {MIN_OTHER_ADDRESS_LEN}..{MAX_ADDRESS_LEN} printable chars"
            ))
        }
    } else {
        Err(format!(
            "unknown chain '{chain}' (must be lowercase: near, {}, {})",
            EVM_CHAINS.join(", "),
            OTHER_CHAINS.join(", ")
        ))
    }
}

#[cfg(test)]
mod tests;
