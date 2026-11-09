//! Integration test against a local NEAR sandbox (near-workspaces).
//!
//! The near-workspaces sandbox binary only exists for linux-x86_64, linux-aarch64 and
//! darwin-arm64, so this file (and the near-workspaces dev-dependency) is compiled out on
//! Intel macOS unless you pass `--cfg orvantra_sandbox` and your own `NEAR_SANDBOX_BIN_PATH`.
//! See README.md.
#![cfg(any(orvantra_sandbox, not(all(target_os = "macos", target_arch = "x86_64"))))]

use near_workspaces::types::NearToken;
use serde_json::{json, Value};

const USDC_BASE: &str = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const ALICE_ADDR: &str = "0x1111111111111111111111111111111111111111";
const BOB_ADDR: &str = "0x2222222222222222222222222222222222222222";
/// remove_vendor and same-size set_vendor updates need 1 yoctoNEAR (forces a full-access key).
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// Creating an entry: the vendor pays its storage (excess refunded). 0.01 NEAR covers any entry.
const STORAGE: NearToken = NearToken::from_millinear(10);

#[tokio::test]
async fn alice_registers_bob_cannot_change_it() -> anyhow::Result<()> {
    let wasm = near_workspaces::compile_project("./").await?;
    let sandbox = near_workspaces::sandbox().await?;
    let contract = sandbox.dev_deploy(&wasm).await?;

    let root = sandbox.root_account()?;
    let alice = root
        .create_subaccount("alice")
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    let bob = root
        .create_subaccount("bob")
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;

    // Alice registers her payout details.
    let res = alice
        .call(contract.id(), "set_vendor")
        .args_json(json!({
            "display_name": "Alice Supplies",
            "chain": "base",
            "asset_id": USDC_BASE,
            "address": ALICE_ADDR,
        }))
        .deposit(STORAGE)
        .transact()
        .await?;
    assert!(res.is_success(), "alice set_vendor failed: {res:?}");
    let paid: String = contract
        .view("storage_paid")
        .args_json(json!({ "account_id": alice.id() }))
        .await?
        .json()?;
    let estimate: String = contract
        .view("storage_cost_estimate")
        .args_json(json!({ "display_name_len": 14, "address_len": 42, "asset_len": USDC_BASE.len() }))
        .await?
        .json()?;
    let paid: u128 = paid.parse()?;
    assert!(paid > 0 && paid <= estimate.parse::<u128>()?, "paid {paid}, estimate {estimate}");
    assert!(res.logs().iter().any(|l| l.starts_with("EVENT_JSON:")
        && l.contains("\"event\":\"vendor_registered\"")));

    // Bob calls set_vendor with his own address. There is no way to name another account:
    // the entry is keyed by the caller, so this only creates bob's own entry.
    let res = bob
        .call(contract.id(), "set_vendor")
        .args_json(json!({
            "display_name": "Alice Supplies",
            "chain": "base",
            "asset_id": USDC_BASE,
            "address": BOB_ADDR,
        }))
        .deposit(STORAGE)
        .transact()
        .await?;
    assert!(res.is_success(), "bob set_vendor failed: {res:?}");

    // Creating an entry with only 1 yocto fails: the vendor must pay for its storage.
    let carol = root
        .create_subaccount("carol")
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    let res = carol
        .call(contract.id(), "set_vendor")
        .args_json(json!({ "display_name": "Carol", "chain": "base", "asset_id": USDC_BASE, "address": BOB_ADDR }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?;
    assert!(res.is_failure(), "set_vendor without storage deposit must fail");

    // Bob also cannot remove alice's entry: remove_vendor only removes the caller's own entry.
    // Without the 1 yoctoNEAR (as a function-call access key would send) the call fails.
    let res = bob.call(contract.id(), "remove_vendor").transact().await?;
    assert!(res.is_failure(), "remove_vendor without 1 yocto must fail");
    bob.call(contract.id(), "remove_vendor")
        .deposit(ONE_YOCTO)
        .transact()
        .await?
        .into_result()?;

    // Alice's entry is untouched.
    let a: Value = contract
        .view("get_vendor")
        .args_json(json!({ "account_id": alice.id() }))
        .await?
        .json()?;
    assert_eq!(a["account_id"], alice.id().to_string());
    assert_eq!(a["display_name"], "Alice Supplies");
    assert_eq!(a["payout"]["chain"], "base");
    assert_eq!(a["payout"]["asset_id"], USDC_BASE);
    assert_eq!(a["payout"]["address"], ALICE_ADDR);
    assert_eq!(a["version"], 1);

    // Bob's entry existed then was removed by bob.
    let b: Value = contract
        .view("get_vendor")
        .args_json(json!({ "account_id": bob.id() }))
        .await?
        .json()?;
    assert!(b.is_null());

    let count: u32 = contract.view("count").await?.json()?;
    assert_eq!(count, 1);

    let all: Vec<Value> = contract
        .view("get_vendors")
        .args_json(json!({ "from_index": 0, "limit": 10 }))
        .await?
        .json()?;
    assert_eq!(all.len(), 1);
    assert_eq!(all[0]["account_id"], alice.id().to_string());

    let age: Option<String> = contract
        .view("payout_age_ns")
        .args_json(json!({ "account_id": alice.id() }))
        .await?
        .json()?;
    assert!(age.is_some());

    // Alice updates her payout: version bumps and the event carries old + new address.
    let res = alice
        .call(contract.id(), "set_vendor")
        .args_json(json!({
            "display_name": "Alice Supplies",
            "chain": "base",
            "asset_id": USDC_BASE,
            "address": BOB_ADDR,
        }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?;
    assert!(res.is_success());
    let log = res
        .logs()
        .into_iter()
        .find(|l| l.contains("payout_updated"))
        .expect("payout_updated event");
    let ev: Value = serde_json::from_str(log.trim_start_matches("EVENT_JSON:"))?;
    assert_eq!(ev["data"][0]["old_address"], ALICE_ADDR);
    assert_eq!(ev["data"][0]["new_address"], BOB_ADDR);
    assert_eq!(ev["data"][0]["new_version"], 2);

    // Invalid input is rejected on-chain.
    let res = alice
        .call(contract.id(), "set_vendor")
        .args_json(json!({
            "display_name": "Alice Supplies",
            "chain": "base",
            "asset_id": USDC_BASE,
            "address": "0xBAD",
        }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?;
    assert!(res.is_failure());

    Ok(())
}
