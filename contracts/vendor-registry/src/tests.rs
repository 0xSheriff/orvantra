use super::*;
use near_sdk::serde_json::Value;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;

const USDC_NEAR: &str = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDC_BASE: &str = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const EVM_ADDR: &str = "0x1111111111111111111111111111111111111111";
const EVM_ADDR_2: &str = "0x2222222222222222222222222222222222222222";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

/// 0.01 NEAR: covers the storage of the largest possible entry (the excess is refunded).
const ENOUGH: u128 = 10_000_000_000_000_000_000_000;
const BYTE_COST: u128 = 10_000_000_000_000_000_000; // 1e19 yoctoNEAR per byte

/// Set the caller and block time for the next calls, attaching enough for a new entry.
fn as_caller(who: &str, ts: u64) {
    as_caller_with_deposit(who, ts, ENOUGH);
}

/// NEAR transfers (refunds) the last call created: (receiver, yoctoNEAR).
fn refunds() -> Vec<(String, u128)> {
    near_sdk::test_utils::get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let to = r.receiver_id.to_string();
            r.actions.into_iter().filter_map(move |a| match a {
                near_sdk::mock::MockAction::Transfer { deposit, .. } => Some((to.clone(), deposit.as_yoctonear())),
                _ => None,
            })
        })
        .collect()
}

fn as_caller_with_deposit(who: &str, ts: u64, yocto: u128) {
    testing_env!(VMContextBuilder::new()
        .predecessor_account_id(acc(who))
        .block_timestamp(ts)
        .attached_deposit(near_sdk::NearToken::from_yoctonear(yocto))
        .build());
}

fn events() -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| near_sdk::serde_json::from_str(j).unwrap())
        .collect()
}

fn register_acme(c: &mut VendorRegistry) -> VendorView {
    c.set_vendor("Acme Ltd".into(), "base".into(), USDC_BASE.into(), EVM_ADDR.into())
}

#[test]
fn register_creates_entry() {
    as_caller("acme.near", 1_000);
    let mut c = VendorRegistry::default();
    let v = register_acme(&mut c);

    assert_eq!(v.account_id, acc("acme.near"));
    assert_eq!(v.version, 1);
    assert_eq!(v.created_at_ns.0, 1_000);
    assert_eq!(v.updated_at_ns.0, 1_000);
    assert_eq!(c.count(), 1);
    assert_eq!(c.get_vendor(acc("acme.near")), Some(v));
    assert_eq!(c.get_vendor(acc("other.near")), None);
}

#[test]
fn register_on_near_chain() {
    as_caller("acme.near", 1);
    let mut c = VendorRegistry::default();
    let v = c.set_vendor("Acme".into(), "near".into(), USDC_NEAR.into(), "acme-payouts.near".into());
    assert_eq!(v.payout.address, "acme-payouts.near");
}

#[test]
fn payout_update_bumps_version_and_timestamp() {
    as_caller("acme.near", 1_000);
    let mut c = VendorRegistry::default();
    register_acme(&mut c);

    as_caller("acme.near", 5_000);
    let v = c.set_vendor("Acme Ltd".into(), "base".into(), USDC_BASE.into(), EVM_ADDR_2.into());
    assert_eq!(v.version, 2);
    assert_eq!(v.created_at_ns.0, 1_000);
    assert_eq!(v.updated_at_ns.0, 5_000);
    assert_eq!(v.payout.address, EVM_ADDR_2);

    // A chain/asset change is a payout change too.
    as_caller("acme.near", 9_000);
    let v = c.set_vendor(
        "Acme Ltd".into(),
        "near".into(),
        USDC_NEAR.into(),
        "acme.near".into(),
    );
    assert_eq!(v.version, 3);
    assert_eq!(v.updated_at_ns.0, 9_000);
    assert_eq!(c.count(), 1);
}

#[test]
fn name_only_update_does_not_bump() {
    as_caller("acme.near", 1_000);
    let mut c = VendorRegistry::default();
    register_acme(&mut c);

    as_caller("acme.near", 5_000);
    let v = c.set_vendor("Acme Inc".into(), "base".into(), USDC_BASE.into(), EVM_ADDR.into());
    assert_eq!(v.display_name, "Acme Inc");
    assert_eq!(v.version, 1);
    assert_eq!(v.updated_at_ns.0, 1_000);
    assert!(events().is_empty(), "name-only update must not emit payout_updated");
}

#[test]
fn payout_age() {
    as_caller("acme.near", 1_000);
    let mut c = VendorRegistry::default();
    register_acme(&mut c);
    as_caller("anyone.near", 61_000);
    assert_eq!(c.payout_age_ns(acc("acme.near")), Some(U64(60_000)));
    assert_eq!(c.payout_age_ns(acc("nobody.near")), None);
}

#[test]
#[should_panic(expected = "address must be 0x followed by 40 hex chars")]
fn rejects_bad_evm_address() {
    as_caller("acme.near", 1);
    let mut c = VendorRegistry::default();
    c.set_vendor("Acme".into(), "base".into(), USDC_BASE.into(), "0x1234".into());
}

#[test]
#[should_panic(expected = "display_name longer than 64 chars")]
fn rejects_too_long_name() {
    as_caller("acme.near", 1);
    let mut c = VendorRegistry::default();
    c.set_vendor("x".repeat(65), "base".into(), USDC_BASE.into(), EVM_ADDR.into());
}

#[test]
#[should_panic(expected = "unknown chain 'dogechain'")]
fn rejects_unknown_chain() {
    as_caller("acme.near", 1);
    let mut c = VendorRegistry::default();
    c.set_vendor("Acme".into(), "dogechain".into(), USDC_BASE.into(), EVM_ADDR.into());
}

#[test]
fn validation_rules() {
    let p = |chain: &str, asset: &str, addr: &str| Payout {
        chain: chain.into(),
        asset_id: asset.into(),
        address: addr.into(),
    };
    let ok = |name: &str, payout: Payout| validate(name, &payout).is_ok();

    // Accepted.
    assert!(ok("Acme", p("base", USDC_BASE, EVM_ADDR)));
    assert!(ok(&"é".repeat(64), p("eth", USDC_BASE, EVM_ADDR))); // 64 chars, >64 bytes
    assert!(ok("Acme", p("arbitrum", USDC_BASE, "0xABCDEFabcdef0123456789012345678901234567")));
    assert!(ok("Acme", p("near", USDC_NEAR, "acme.near")));
    assert!(ok("Acme", p("solana", "x", "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T")));
    assert!(ok("Acme", p("tron", "x", "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf")));

    // Empty / too long.
    assert!(!ok("", p("base", USDC_BASE, EVM_ADDR)));
    assert!(!ok("   ", p("base", USDC_BASE, EVM_ADDR)));
    assert!(!ok("a\nb", p("base", USDC_BASE, EVM_ADDR)));
    assert!(!ok("Acme", p("base", "", EVM_ADDR)));
    assert!(!ok("Acme", p("base", &"a".repeat(129), EVM_ADDR)));
    assert!(!ok("Acme", p("base", "has space", EVM_ADDR)));
    assert!(!ok("Acme", p("base", USDC_BASE, "")));
    assert!(!ok("Acme", p("solana", "x", &"a".repeat(129))));

    // Chain must be lowercase and known.
    assert!(!ok("Acme", p("Base", USDC_BASE, EVM_ADDR)));
    assert!(!ok("Acme", p("", USDC_BASE, EVM_ADDR)));

    // EVM format.
    assert!(!ok("Acme", p("eth", USDC_BASE, "1111111111111111111111111111111111111111")));
    assert!(!ok("Acme", p("eth", USDC_BASE, "0x111111111111111111111111111111111111111g")));
    assert!(!ok("Acme", p("eth", USDC_BASE, "0x11111111111111111111111111111111111111111")));

    // NEAR account id format.
    assert!(!ok("Acme", p("near", USDC_NEAR, "Not A Valid Account")));
    assert!(!ok("Acme", p("near", USDC_NEAR, "a")));

    // Other chains: 20..128 printable chars.
    assert!(!ok("Acme", p("solana", "x", "tooshort")));
    assert!(!ok("Acme", p("tron", "x", "TXYZopYRdj2D9XRtbG4 1XZZ3kM5VkAeBf")));
}

#[test]
fn remove_deletes_own_entry() {
    as_caller("acme.near", 1);
    let mut c = VendorRegistry::default();
    register_acme(&mut c);
    as_caller("bob.near", 1);
    register_acme(&mut c);
    assert_eq!(c.count(), 2);

    as_caller_with_deposit("acme.near", 2, 1);
    c.remove_vendor();
    assert_eq!(c.count(), 1);
    assert_eq!(c.get_vendor(acc("acme.near")), None);
    assert!(c.get_vendor(acc("bob.near")).is_some());

    let ev = events();
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["event"], "vendor_removed");
    assert_eq!(ev[0]["data"][0]["account_id"], "acme.near");
}

#[test]
#[should_panic(expected = "vendor not registered")]
fn remove_without_entry_panics() {
    as_caller_with_deposit("acme.near", 1, 1);
    let mut c = VendorRegistry::default();
    c.remove_vendor();
}

/// L4: the version never restarts, so "version 1" can't mean two different payouts.
#[test]
fn re_register_after_remove_continues_version() {
    as_caller("acme.near", 1);
    let mut c = VendorRegistry::default();
    register_acme(&mut c);
    c.set_vendor("Acme".into(), "base".into(), USDC_BASE.into(), EVM_ADDR_2.into());
    as_caller_with_deposit("acme.near", 2, 1);
    c.remove_vendor();
    as_caller("acme.near", 50);
    let v = register_acme(&mut c);
    assert_eq!(v.version, 3);
    assert_eq!(v.created_at_ns.0, 50);
    assert_eq!(v.updated_at_ns.0, 50, "fresh updated_at, so the payout-age hold applies");
    assert_eq!(events()[0]["data"][0]["version"], 3);
}

#[test]
fn pagination() {
    let mut c = VendorRegistry::default();
    for i in 0..5 {
        as_caller(&format!("v{i}.near"), 1);
        register_acme(&mut c);
    }
    let ids = |page: Vec<VendorView>| -> Vec<String> {
        page.into_iter().map(|v| v.account_id.to_string()).collect()
    };
    assert_eq!(c.count(), 5);
    assert_eq!(ids(c.get_vendors(None, None)).len(), 5);
    assert_eq!(ids(c.get_vendors(Some(0), Some(2))), ["v0.near", "v1.near"]);
    assert_eq!(ids(c.get_vendors(Some(2), Some(2))), ["v2.near", "v3.near"]);
    assert_eq!(ids(c.get_vendors(Some(4), Some(2))), ["v4.near"]);
    assert!(c.get_vendors(Some(5), Some(2)).is_empty());
    assert!(c.get_vendors(Some(100), None).is_empty());
}

#[test]
fn pagination_limit_is_capped() {
    let mut c = VendorRegistry::default();
    for i in 0..(MAX_PAGE_LIMIT + 5) {
        as_caller(&format!("v{i}.near"), 1);
        register_acme(&mut c);
    }
    assert_eq!(c.get_vendors(None, Some(1_000)).len(), MAX_PAGE_LIMIT as usize);
}

#[test]
fn register_event_log() {
    as_caller("acme.near", 1);
    let mut c = VendorRegistry::default();
    register_acme(&mut c);

    let logs = get_logs();
    assert_eq!(logs.len(), 1);
    assert!(logs[0].starts_with("EVENT_JSON:{"));
    let ev = &events()[0];
    assert_eq!(ev["standard"], "orvantra_registry");
    assert_eq!(ev["version"], "1.0.0");
    assert_eq!(ev["event"], "vendor_registered");
    let d = &ev["data"][0];
    assert_eq!(d["account_id"], "acme.near");
    assert_eq!(d["display_name"], "Acme Ltd");
    assert_eq!(d["chain"], "base");
    assert_eq!(d["asset_id"], USDC_BASE);
    assert_eq!(d["address"], EVM_ADDR);
    assert_eq!(d["version"], 1);
}

#[test]
fn payout_updated_event_log() {
    as_caller("acme.near", 1);
    let mut c = VendorRegistry::default();
    register_acme(&mut c);

    as_caller("acme.near", 2); // fresh context clears logs
    c.set_vendor("Acme Ltd".into(), "base".into(), USDC_BASE.into(), EVM_ADDR_2.into());
    let ev = events();
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0]["standard"], "orvantra_registry");
    assert_eq!(ev[0]["version"], "1.0.0");
    assert_eq!(ev[0]["event"], "payout_updated");
    let d = &ev[0]["data"][0];
    assert_eq!(d["account_id"], "acme.near");
    assert_eq!(d["old_address"], EVM_ADDR);
    assert_eq!(d["new_address"], EVM_ADDR_2);
    assert_eq!(d["new_version"], 2);
}

#[test]
fn callers_only_touch_their_own_entry() {
    as_caller("acme.near", 1);
    let mut c = VendorRegistry::default();
    register_acme(&mut c);

    // bob "updates" with acme's name: this only creates bob's own entry.
    as_caller("bob.near", 2);
    c.set_vendor("Acme Ltd".into(), "base".into(), USDC_BASE.into(), EVM_ADDR_2.into());

    let acme = c.get_vendor(acc("acme.near")).unwrap();
    assert_eq!(acme.payout.address, EVM_ADDR);
    assert_eq!(acme.version, 1);
    assert_eq!(c.get_vendor(acc("bob.near")).unwrap().payout.address, EVM_ADDR_2);
}

// Deposit requirement: function-call access keys cannot attach deposits, so these calls always
// need a full-access key (an explicit wallet confirmation).

#[test]
#[should_panic(expected = "Requires attached deposit of at least 1 yoctoNEAR")]
fn set_vendor_rejects_zero_deposit() {
    as_caller_with_deposit("acme.near", 1, 0);
    let mut c = VendorRegistry::default();
    register_acme(&mut c);
}

/// C-M3: creating an entry with only the old 1-2 yocto no longer works: the vendor pays storage.
#[test]
#[should_panic(expected = "attached deposit too small")]
fn set_vendor_create_needs_storage_deposit() {
    as_caller_with_deposit("acme.near", 1, 2);
    let mut c = VendorRegistry::default();
    register_acme(&mut c);
}

#[test]
#[should_panic(expected = "Requires attached deposit of at least 1 yoctoNEAR")]
fn set_vendor_update_rejects_zero_deposit() {
    as_caller("acme.near", 1);
    let mut c = VendorRegistry::default();
    register_acme(&mut c);
    as_caller_with_deposit("acme.near", 2, 0);
    register_acme(&mut c);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn remove_vendor_rejects_zero_deposit() {
    as_caller("acme.near", 1);
    let mut c = VendorRegistry::default();
    register_acme(&mut c);
    as_caller_with_deposit("acme.near", 2, 0);
    c.remove_vendor();
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn remove_vendor_rejects_two_yocto() {
    as_caller("acme.near", 1);
    let mut c = VendorRegistry::default();
    register_acme(&mut c);
    as_caller_with_deposit("acme.near", 2, 2);
    c.remove_vendor();
}

#[test]
fn rejected_deposit_leaves_entry_unchanged() {
    as_caller("acme.near", 1);
    let mut c = VendorRegistry::default();
    register_acme(&mut c);

    as_caller_with_deposit("acme.near", 2, 0);
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.set_vendor("Acme Ltd".into(), "base".into(), USDC_BASE.into(), EVM_ADDR_2.into())
    }));
    let msg = res.unwrap_err();
    let msg = msg.downcast_ref::<String>().map(String::as_str).unwrap_or("");
    assert!(msg.contains(ERR_NO_DEPOSIT), "unexpected panic: {msg}");

    let v = c.get_vendor(acc("acme.near")).unwrap();
    assert_eq!(v.payout.address, EVM_ADDR);
    assert_eq!(v.version, 1);
}

// ======================================================================= C-M3: vendor-paid storage

/// Storage cost of acme's entry, as charged.
fn paid(c: &VendorRegistry, who: &str) -> u128 {
    c.storage_paid(acc(who)).0
}

#[test]
fn create_charges_storage_and_refunds_excess() {
    as_caller("acme.near", 1);
    let mut c = VendorRegistry::default();
    register_acme(&mut c);
    let cost = paid(&c, "acme.near");
    let bytes = entry_storage_bytes(9, 8, 4, USDC_BASE.len() as u64, 42); // acme.near, "Acme Ltd", base
    assert_eq!(cost, u128::from(bytes) * BYTE_COST, "charge = measured storage of the entry");
    assert_eq!(refunds(), vec![("acme.near".to_string(), ENOUGH - cost)]);
}

#[test]
fn create_with_exact_deposit_has_no_refund() {
    as_caller("acme.near", 1);
    let mut c = VendorRegistry::default();
    register_acme(&mut c);
    let cost = paid(&c, "acme.near");
    as_caller_with_deposit("abcd.near", 1, cost); // same length as acme.near
    register_acme(&mut c);
    assert_eq!(paid(&c, "abcd.near"), cost);
    assert!(refunds().is_empty());
}

#[test]
#[should_panic(expected = "attached deposit too small")]
fn create_with_one_yocto_less_fails() {
    as_caller("acme.near", 1);
    let mut c = VendorRegistry::default();
    register_acme(&mut c);
    let cost = paid(&c, "acme.near");
    as_caller_with_deposit("abcd.near", 1, cost - 1); // same length as acme.near
    register_acme(&mut c);
}

#[test]
fn estimate_matches_the_largest_entry_and_bounds_others() {
    let longest = "a".repeat(64);
    let name = "é".repeat(64); // 128 bytes
    let asset = "x".repeat(MAX_ASSET_ID_LEN);
    as_caller(&longest, 1);
    let mut c = VendorRegistry::default();
    c.set_vendor(name.clone(), "avalanche".into(), asset.clone(), EVM_ADDR.into());
    let est = c.storage_cost_estimate(name.len() as u32, 42, asset.len() as u32).0;
    assert_eq!(paid(&c, &longest), est, "exact for a 64-char account on the longest chain name");
    assert!(est <= ENOUGH);

    as_caller("acme.near", 1);
    register_acme(&mut c);
    assert!(paid(&c, "acme.near") < c.storage_cost_estimate(8, 42, USDC_BASE.len() as u32).0);
}

#[test]
fn estimate_for_a_typical_entry() {
    // Display name 20 bytes, EVM address, USDC-on-Base asset id: the number the UI shows.
    as_caller("anyone.near", 1);
    let c = VendorRegistry::default();
    let est = c.storage_cost_estimate(20, 42, USDC_BASE.len() as u32).0;
    let bytes = ENTRY_BASE_BYTES + 2 * 64 + 20 + 9 + USDC_BASE.len() as u64 + 42;
    assert_eq!(est, u128::from(bytes) * BYTE_COST);
}

#[test]
fn update_same_size_costs_one_yocto() {
    as_caller("acme.near", 1);
    let mut c = VendorRegistry::default();
    register_acme(&mut c);
    let cost = paid(&c, "acme.near");
    as_caller_with_deposit("acme.near", 2, 1);
    let v = c.set_vendor("Acme Ltd".into(), "base".into(), USDC_BASE.into(), EVM_ADDR_2.into());
    assert_eq!(v.version, 2);
    assert_eq!(paid(&c, "acme.near"), cost);
    assert!(refunds().is_empty(), "the 1 yocto is kept");
}

#[test]
fn update_with_extra_deposit_refunds_all_but_one_yocto() {
    as_caller("acme.near", 1);
    let mut c = VendorRegistry::default();
    register_acme(&mut c);
    as_caller_with_deposit("acme.near", 2, 2);
    register_acme(&mut c);
    assert_eq!(refunds(), vec![("acme.near".to_string(), 1)]);
}

#[test]
fn update_growth_is_charged_and_shrink_refunded() {
    as_caller("acme.near", 1);
    let mut c = VendorRegistry::default();
    register_acme(&mut c); // "Acme Ltd"
    let cost = paid(&c, "acme.near");
    as_caller("acme.near", 2);
    c.set_vendor("Acme Ltd International".into(), "base".into(), USDC_BASE.into(), EVM_ADDR.into());
    let growth = 14 * BYTE_COST;
    assert_eq!(paid(&c, "acme.near"), cost + growth);
    assert_eq!(refunds(), vec![("acme.near".to_string(), ENOUGH - 1 - growth)]);

    as_caller_with_deposit("acme.near", 3, 1);
    c.set_vendor("Acme".into(), "base".into(), USDC_BASE.into(), EVM_ADDR.into());
    assert_eq!(paid(&c, "acme.near"), cost - 4 * BYTE_COST);
    assert_eq!(refunds(), vec![("acme.near".to_string(), growth + 4 * BYTE_COST)]);
}

#[test]
#[should_panic(expected = "attached deposit too small")]
fn update_growth_needs_deposit() {
    as_caller("acme.near", 1);
    let mut c = VendorRegistry::default();
    register_acme(&mut c);
    as_caller_with_deposit("acme.near", 2, 1);
    c.set_vendor("Acme Ltd International".into(), "base".into(), USDC_BASE.into(), EVM_ADDR.into());
}

#[test]
fn remove_refunds_entry_storage_and_keeps_tombstone() {
    as_caller("acme.near", 1);
    let mut c = VendorRegistry::default();
    register_acme(&mut c);
    let cost = paid(&c, "acme.near");
    as_caller_with_deposit("acme.near", 2, 1);
    c.remove_vendor();
    let tombstone = TOMBSTONE_BASE_BYTES + 9;
    let refund = cost - u128::from(tombstone) * BYTE_COST;
    assert_eq!(refunds(), vec![("acme.near".to_string(), refund)]);
    assert_eq!(paid(&c, "acme.near"), cost - refund, "the tombstone stays paid for");
    assert_eq!(events()[0]["data"][0]["storage_refund"], refund.to_string());

    // Re-adding charges only the entry again.
    as_caller("acme.near", 3);
    register_acme(&mut c);
    assert_eq!(paid(&c, "acme.near"), cost);
}

/// C-M3: the create -> remove cycle leaves the contract no poorer (the abuse in the review).
#[test]
fn create_remove_cycle_costs_the_contract_nothing() {
    as_caller("spam.near", 1);
    let mut c = VendorRegistry::default();
    c.set_vendor("x".repeat(64), "base".into(), "a".repeat(128), EVM_ADDR.into());
    let charged = ENOUGH - refunds()[0].1;
    as_caller_with_deposit("spam.near", 2, 1);
    c.remove_vendor();
    let refunded = refunds()[0].1;
    // The vendor keeps paying for exactly the bytes that stay (its 74-byte tombstone record).
    let stays = u128::from(TOMBSTONE_BASE_BYTES + 9) * BYTE_COST;
    assert_eq!(charged - refunded, stays);
    assert_eq!(paid(&c, "spam.near"), stays);
}

// ======================================================================= migration from the old layout

fn old_vendor(version: u32) -> Vendor {
    Vendor {
        display_name: "Old Acme".into(),
        payout: Payout { chain: "base".into(), asset_id: USDC_BASE.into(), address: EVM_ADDR.into() },
        created_at_ns: 10,
        updated_at_ns: 20,
        version,
    }
}

/// Write a `RegistryV1` state with acme (v3) and bob (v1), as the live registry has.
fn write_old_state() {
    as_caller("registry.near", 100);
    let mut vendors = IterableMap::new(StorageKey::Vendors);
    vendors.insert(acc("acme.near"), old_vendor(3));
    vendors.insert(acc("bob.near"), old_vendor(1));
    let old = RegistryV1 { vendors };
    env::state_write(&old);
}

#[test]
fn migrate_keeps_entries_and_versions() {
    write_old_state();
    let c = VendorRegistry::migrate();
    assert_eq!(c.count(), 2);
    let a = c.get_vendor(acc("acme.near")).unwrap();
    assert_eq!((a.version, a.created_at_ns.0, a.updated_at_ns.0), (3, 10, 20));
    assert_eq!(a.payout.address, EVM_ADDR);
    assert_eq!(a.display_name, "Old Acme");
    assert_eq!(c.storage_paid(acc("acme.near")).0, 0);
    let ids: Vec<String> = c.get_vendors(None, None).into_iter().map(|v| v.account_id.to_string()).collect();
    assert_eq!(ids, ["acme.near", "bob.near"]);
}

#[test]
fn migrated_entry_is_removable_and_version_continues() {
    write_old_state();
    let mut c = VendorRegistry::migrate();
    as_caller_with_deposit("acme.near", 200, 1);
    c.remove_vendor();
    assert!(refunds().is_empty(), "nothing was paid, nothing is refunded");
    assert_eq!(c.count(), 1);
    as_caller("acme.near", 300);
    let v = register_acme(&mut c);
    assert_eq!(v.version, 4);
    assert!(c.storage_paid(acc("acme.near")).0 > 0, "the new entry is paid for");
}

#[test]
fn migrated_entry_same_size_update_costs_one_yocto() {
    write_old_state();
    let mut c = VendorRegistry::migrate();
    as_caller_with_deposit("acme.near", 200, 1);
    let v = c.set_vendor("Old Acme".into(), "base".into(), USDC_BASE.into(), EVM_ADDR_2.into());
    assert_eq!(v.version, 4);
    assert!(refunds().is_empty());
}

#[test]
fn migrated_entry_growth_is_charged() {
    write_old_state();
    let mut c = VendorRegistry::migrate();
    as_caller("acme.near", 200);
    c.set_vendor("Old Acme Holdings".into(), "base".into(), USDC_BASE.into(), EVM_ADDR.into());
    let p = c.storage_paid(acc("acme.near")).0;
    // 9 more name bytes + the new per-account record.
    let record = TOMBSTONE_BASE_BYTES + 9;
    assert_eq!(p, u128::from(9 + record) * BYTE_COST);
}

#[test]
#[should_panic(expected = "Cannot deserialize the contract state")]
fn migrate_twice_fails() {
    write_old_state();
    let c = VendorRegistry::migrate();
    env::state_write(&c);
    VendorRegistry::migrate();
}

#[test]
#[should_panic(expected = "no registry state to migrate")]
fn migrate_without_state_fails() {
    as_caller("registry.near", 1);
    VendorRegistry::migrate();
}
