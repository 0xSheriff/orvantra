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

/// Set the caller and block time for the next calls.
fn as_caller(who: &str, ts: u64) {
    testing_env!(VMContextBuilder::new()
        .predecessor_account_id(acc(who))
        .block_timestamp(ts)
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

    as_caller("acme.near", 2);
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
    as_caller("acme.near", 1);
    let mut c = VendorRegistry::default();
    c.remove_vendor();
}

#[test]
fn re_register_after_remove_starts_fresh() {
    as_caller("acme.near", 1);
    let mut c = VendorRegistry::default();
    register_acme(&mut c);
    c.set_vendor("Acme".into(), "base".into(), USDC_BASE.into(), EVM_ADDR_2.into());
    c.remove_vendor();
    as_caller("acme.near", 50);
    let v = register_acme(&mut c);
    assert_eq!(v.version, 1);
    assert_eq!(v.created_at_ns.0, 50);
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
