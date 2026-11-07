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
//! # Full-access confirmation (1 yoctoNEAR)
//! `set_vendor` and `remove_vendor` require EXACTLY 1 yoctoNEAR attached. Function-call access keys
//! (the limited keys a browser dapp gets at sign-in) cannot attach deposits, so every payout change
//! needs a full-access key, i.e. an explicit confirmation in the vendor's wallet. A leaked or misused
//! limited key cannot silently redirect payments. The 1 yocto is kept (not refunded).
//!
//! # Storage
//! The contract pays for storage from its own balance; callers attach only the 1 yocto above. This
//! lets a relayer submit vendor updates without the vendor holding NEAR. Abuse is bounded because:
//! - there is at most one entry per NEAR account (creating accounts costs the attacker),
//! - every string field has a hard length limit (see the `MAX_*` constants), so one entry is a few
//!   hundred bytes at most (well under 0.01 NEAR of storage staking).
//!
//! The contract owner must keep enough NEAR on the contract account to cover storage.

use near_sdk::json_types::U64;
use near_sdk::serde_json::{self, json};
use near_sdk::store::IterableMap;
use near_sdk::{assert_one_yocto, env, near, require, AccountId, BorshStorageKey, Timestamp};

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

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Vendors,
}

#[near(contract_state)]
pub struct VendorRegistry {
    vendors: IterableMap<AccountId, Vendor>,
}

impl Default for VendorRegistry {
    fn default() -> Self {
        Self { vendors: IterableMap::new(StorageKey::Vendors) }
    }
}

#[near]
impl VendorRegistry {
    /// Create or update the caller's own entry.
    ///
    /// Changing `chain`, `asset_id` or `address` bumps `version` and `updated_at_ns` and emits
    /// `payout_updated`. Changing only `display_name` does neither.
    /// Requires exactly 1 yoctoNEAR attached (forces a full-access key; see the module docs).
    #[payable]
    pub fn set_vendor(
        &mut self,
        display_name: String,
        chain: String,
        asset_id: String,
        address: String,
    ) -> VendorView {
        assert_one_yocto();
        let payout = Payout { chain, asset_id, address };
        if let Err(e) = validate(&display_name, &payout) {
            env::panic_str(&e);
        }

        let account_id = env::predecessor_account_id();
        let now = env::block_timestamp();

        match self.vendors.get_mut(&account_id) {
            None => {
                let vendor = Vendor {
                    display_name,
                    payout,
                    created_at_ns: now,
                    updated_at_ns: now,
                    version: 1,
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
                self.vendors.insert(account_id, vendor);
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
                VendorView::new(account_id, vendor)
            }
        }
    }

    /// Delete the caller's own entry. Panics if the caller has no entry.
    /// Requires exactly 1 yoctoNEAR attached (forces a full-access key; see the module docs).
    #[payable]
    pub fn remove_vendor(&mut self) {
        assert_one_yocto();
        let account_id = env::predecessor_account_id();
        let removed = self.vendors.remove(&account_id);
        require!(removed.is_some(), "vendor not registered");
        emit("vendor_removed", json!({ "account_id": account_id }));
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
