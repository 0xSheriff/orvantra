use super::policy::*;
use super::*;
use near_sdk::serde_json::Value;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const TOKEN: &str = "tusdc.testnet";
const OWNER: &str = "owner.testnet";
const AGENT: &str = "agent.testnet";
const REGISTRY: &str = "registry.testnet";
const TREASURY: &str = "treasury.testnet";
const ACME: &str = "acme.testnet";
const DEPOSIT: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const EVM_ADDR: &str = "0x1111111111111111111111111111111111111111";

const DAY_NS: u64 = 24 * 3600 * NS_PER_SEC;
/// "Now" in most tests: day 100, well inside one 30-day bucket (bucket 3 = days 90..120).
const NOW: u64 = 100 * DAY_NS;
const THRESHOLD: u128 = 100_000_000; // 100 tUSDC
const TREASURY_CAP: u128 = 1_000_000_000; // 1000 tUSDC
const MIN_AGE_SEC: u64 = 3 * 24 * 3600; // 3 days

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx_builder(predecessor: &str, deposit: u128, ts: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(TREASURY))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(ts);
    b
}

fn as_caller(predecessor: &str, deposit: u128, ts: u64) {
    testing_env!(ctx_builder(predecessor, deposit, ts).build());
}

/// Context for a callback, with the given result of the previous promise.
fn as_callback(ts: u64, result: PromiseResult) {
    testing_env!(
        ctx_builder(TREASURY, 0, ts).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

fn events() -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| near_sdk::serde_json::from_str(j).unwrap())
        .collect()
}

fn event_names() -> Vec<String> {
    events().iter().map(|e| e["event"].as_str().unwrap().to_string()).collect()
}

fn near_vendor(version: u32, updated_at: u64) -> RegistryVendor {
    RegistryVendor {
        account_id: acc(ACME),
        display_name: "Acme".into(),
        payout: Payout {
            chain: "near".into(),
            asset_id: format!("nep141:{TOKEN}"),
            address: "acme-payouts.testnet".into(),
        },
        created_at_ns: U64(0),
        updated_at_ns: U64(updated_at),
        version,
    }
}

fn base_vendor(version: u32, updated_at: u64) -> RegistryVendor {
    RegistryVendor {
        payout: Payout {
            chain: "base".into(),
            asset_id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near".into(),
            address: EVM_ADDR.into(),
        },
        ..near_vendor(version, updated_at)
    }
}

/// Old payout (registered on day 1) so the age rule does not trigger.
fn old_near_vendor() -> RegistryVendor {
    near_vendor(1, DAY_NS)
}

fn setup() -> Treasury {
    as_caller(OWNER, 0, NOW);
    let mut t = Treasury::new(
        acc(OWNER),
        acc(AGENT),
        acc(REGISTRY),
        acc(TOKEN),
        U128(THRESHOLD),
        U128(TREASURY_CAP),
        MIN_AGE_SEC,
    );
    as_caller(OWNER, 1, NOW);
    t.set_vendor_policy(acc(ACME), U128(500_000_000), U128(800_000_000));
    t
}

fn propose(t: &mut Treasury, hash: &str, amount: u128) -> u64 {
    as_caller(AGENT, 0, NOW);
    let _ = t.propose_payment(hash.into(), acc(ACME), U128(amount), 1, None, None, None);
    t.get_config().payment_count - 1
}

fn propose_with_deposit(t: &mut Treasury, hash: &str, amount: u128) -> u64 {
    as_caller(AGENT, 0, NOW);
    let _ = t.propose_payment(
        hash.into(),
        acc(ACME),
        U128(amount),
        1,
        Some(DEPOSIT.into()),
        Some("quote-abc".into()),
        Some("inv 42".into()),
    );
    t.get_config().payment_count - 1
}

fn status_of(r: PromiseOrValue<PaymentStatus>) -> Option<PaymentStatus> {
    match r {
        PromiseOrValue::Value(s) => Some(s),
        PromiseOrValue::Promise(_) => None, // ft_transfer scheduled
    }
}

/// Registry callback succeeded with `entry`.
fn registry_answers(t: &mut Treasury, id: u64, entry: Option<RegistryVendor>) -> Option<PaymentStatus> {
    let bytes = near_sdk::serde_json::to_vec(&entry).unwrap();
    as_callback(NOW, PromiseResult::Successful(bytes));
    status_of(t.on_proposal_checked(id, Ok(entry)))
}

fn transfer_result(t: &mut Treasury, ok: bool) -> PaymentStatus {
    let r = if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed };
    as_callback(NOW, r);
    let id = t.get_config().payment_count - 1;
    t.on_payment_transferred(id)
}

/// Make acme a known vendor (one Paid payment), so later payments are not "first payment".
fn pay_once(t: &mut Treasury) {
    let id = propose(t, "warmup", 1_000_000);
    assert_eq!(registry_answers(t, id, Some(old_near_vendor())), Some(PaymentStatus::Pending));
    as_caller(OWNER, 1, NOW);
    let _ = t.approve_payment(id);
    as_callback(NOW, PromiseResult::Successful(vec![]));
    assert_eq!(status_of(t.on_approval_checked(id, Ok(Some(old_near_vendor())))), None);
    assert_eq!(transfer_result(t, true), PaymentStatus::Paid);
}

// ======================================================================= pure: proposal check

fn policy(max: u128, cap: u128) -> VendorPolicy {
    VendorPolicy { max_per_invoice: U128(max), monthly_cap: U128(cap) }
}

fn ok_check(p: &VendorPolicy) -> ProposalCheck<'_> {
    ProposalCheck {
        paused: false,
        invoice_used: false,
        policy: Some(p),
        amount: 10,
        vendor_spent: 0,
        total_spent: 0,
        treasury_monthly_cap: 1_000,
    }
}

#[test]
fn check_accepts_valid_proposal() {
    let p = policy(100, 500);
    assert_eq!(check_proposal(&ok_check(&p)), Ok(()));
}

#[test]
fn check_rejects_paused() {
    let p = policy(100, 500);
    let c = ProposalCheck { paused: true, ..ok_check(&p) };
    assert_eq!(check_proposal(&c).unwrap_err(), "treasury is paused");
}

#[test]
fn check_rejects_duplicate_hash() {
    let p = policy(100, 500);
    let c = ProposalCheck { invoice_used: true, ..ok_check(&p) };
    assert_eq!(check_proposal(&c).unwrap_err(), "invoice already used");
}

#[test]
fn check_rejects_unapproved_vendor() {
    let p = policy(100, 500);
    let c = ProposalCheck { policy: None, ..ok_check(&p) };
    assert_eq!(check_proposal(&c).unwrap_err(), "vendor not approved (no policy)");
}

#[test]
fn check_rejects_zero_amount() {
    let p = policy(100, 500);
    let c = ProposalCheck { amount: 0, ..ok_check(&p) };
    assert_eq!(check_proposal(&c).unwrap_err(), "amount must be > 0");
}

#[test]
fn check_max_per_invoice_is_inclusive() {
    let p = policy(100, 500);
    assert!(check_proposal(&ProposalCheck { amount: 100, ..ok_check(&p) }).is_ok());
    let c = ProposalCheck { amount: 101, ..ok_check(&p) };
    assert_eq!(check_proposal(&c).unwrap_err(), "amount above vendor max_per_invoice");
}

#[test]
fn check_vendor_monthly_cap() {
    let p = policy(100, 500);
    assert!(check_proposal(&ProposalCheck { amount: 100, vendor_spent: 400, ..ok_check(&p) }).is_ok());
    let c = ProposalCheck { amount: 100, vendor_spent: 401, ..ok_check(&p) };
    assert_eq!(check_proposal(&c).unwrap_err(), "over vendor monthly cap");
}

#[test]
fn check_treasury_monthly_cap() {
    let p = policy(100, 500);
    assert!(check_proposal(&ProposalCheck { amount: 100, total_spent: 900, ..ok_check(&p) }).is_ok());
    let c = ProposalCheck { amount: 100, total_spent: 901, ..ok_check(&p) };
    assert_eq!(check_proposal(&c).unwrap_err(), "over treasury monthly cap");
}

#[test]
fn check_overflow_is_over_cap_not_panic() {
    let p = policy(u128::MAX, u128::MAX);
    let c = ProposalCheck { amount: 2, vendor_spent: u128::MAX - 1, ..ok_check(&p) };
    assert_eq!(check_proposal(&c).unwrap_err(), "over vendor monthly cap");
}

#[test]
fn validate_inputs_bounds_strings() {
    assert!(validate_inputs("h", None, None, None).is_ok());
    assert!(validate_inputs("  ", None, None, None).unwrap_err().contains("empty"));
    let long = "x".repeat(MAX_INVOICE_HASH_LEN + 1);
    assert!(validate_inputs(&long, None, None, None).unwrap_err().contains("invoice_hash"));
    assert!(validate_inputs("h", Some(&long), None, None).unwrap_err().contains("deposit_address"));
    assert!(validate_inputs("h", None, Some(&long), None).unwrap_err().contains("quote_hash"));
    let memo = "m".repeat(MAX_MEMO_LEN + 1);
    assert!(validate_inputs("h", None, None, Some(&memo)).unwrap_err().contains("memo"));
}

// ======================================================================= pure: buckets

#[test]
fn bucket_math_30_days() {
    assert_eq!(BUCKET_NS, 2_592_000 * NS_PER_SEC);
    assert_eq!(bucket_of(0), 0);
    assert_eq!(bucket_of(BUCKET_NS - 1), 0);
    assert_eq!(bucket_of(BUCKET_NS), 1);
    assert_eq!(bucket_of(NOW), 3);
}

// ======================================================================= pure: registry/destination

#[test]
fn registry_missing_or_version_mismatch() {
    assert_eq!(check_registry(None, 1).unwrap_err(), REASON_NOT_IN_REGISTRY);
    let v = near_vendor(2, 0);
    assert_eq!(check_registry(Some(&v), 1).unwrap_err(), REASON_VERSION_CHANGED);
    assert_eq!(check_registry(Some(&v), 2).unwrap(), &v);
}

#[test]
fn destination_near_direct_ignores_deposit_address() {
    let v = near_vendor(1, 0);
    let d = select_destination(&v.payout, &acc(TOKEN), Some(DEPOSIT)).unwrap();
    assert_eq!(d, (acc("acme-payouts.testnet"), true));
}

#[test]
fn destination_near_but_other_token_uses_deposit_address() {
    let mut v = near_vendor(1, 0);
    v.payout.asset_id = "nep141:other-token.testnet".into();
    let d = select_destination(&v.payout, &acc(TOKEN), Some(DEPOSIT)).unwrap();
    assert_eq!(d, (acc(DEPOSIT), false));
}

#[test]
fn destination_cross_chain_uses_deposit_address() {
    let v = base_vendor(1, 0);
    let d = select_destination(&v.payout, &acc(TOKEN), Some(DEPOSIT)).unwrap();
    assert_eq!(d, (acc(DEPOSIT), false));
}

#[test]
fn destination_cross_chain_requires_deposit_address() {
    let v = base_vendor(1, 0);
    assert_eq!(select_destination(&v.payout, &acc(TOKEN), None).unwrap_err(), REASON_NO_DEPOSIT_ADDRESS);
}

#[test]
fn destination_rejects_invalid_deposit_address() {
    let v = base_vendor(1, 0);
    // (A 0x... EVM address would parse: it is a valid NEAR eth-implicit account id.)
    let e = select_destination(&v.payout, &acc(TOKEN), Some("Not A Valid Account!")).unwrap_err();
    assert_eq!(e, REASON_BAD_DEPOSIT_ADDRESS);
}

// ======================================================================= pure: needs-human

#[test]
fn human_needed_over_threshold() {
    let r = needs_human_reasons(101, 100, 0, NOW, 0, false);
    assert_eq!(r, vec![HOLD_OVER_THRESHOLD]);
    assert!(needs_human_reasons(100, 100, 0, NOW, 0, false).is_empty());
}

#[test]
fn human_needed_fresh_payout() {
    let changed = NOW - MIN_AGE_SEC * NS_PER_SEC + 1;
    assert_eq!(needs_human_reasons(1, 100, changed, NOW, MIN_AGE_SEC, false), vec![HOLD_FRESH_PAYOUT]);
    let old_enough = NOW - MIN_AGE_SEC * NS_PER_SEC;
    assert!(needs_human_reasons(1, 100, old_enough, NOW, MIN_AGE_SEC, false).is_empty());
}

#[test]
fn human_needed_first_payment() {
    assert_eq!(needs_human_reasons(1, 100, 0, NOW, 0, true), vec![HOLD_FIRST_PAYMENT]);
}

#[test]
fn human_needed_collects_all_reasons() {
    let r = needs_human_reasons(101, 100, NOW, NOW, MIN_AGE_SEC, true);
    assert_eq!(r, vec![HOLD_OVER_THRESHOLD, HOLD_FRESH_PAYOUT, HOLD_FIRST_PAYMENT]);
}

fn decide_input<'a>(entry: Option<&'a RegistryVendor>, token: &'a AccountId) -> DecideInput<'a> {
    DecideInput {
        registry: entry,
        expected_version: 1,
        token,
        deposit_address: None,
        amount: 10,
        auto_pay_threshold: THRESHOLD,
        min_payout_age_sec: MIN_AGE_SEC,
        now_ns: NOW,
        first_payment: false,
    }
}

#[test]
fn decide_paths() {
    let token = acc(TOKEN);
    let old = old_near_vendor();
    let exec = decide(&decide_input(Some(&old), &token));
    assert!(matches!(exec, Decision::Execute { direct: true, .. }));

    let hold = decide(&DecideInput { first_payment: true, ..decide_input(Some(&old), &token) });
    assert!(matches!(hold, Decision::Hold { ref reasons, .. } if reasons == &vec![HOLD_FIRST_PAYMENT.to_string()]));

    assert_eq!(decide(&decide_input(None, &token)), Decision::Reject(REASON_NOT_IN_REGISTRY.into()));

    let base = base_vendor(1, DAY_NS);
    assert_eq!(decide(&decide_input(Some(&base), &token)), Decision::Reject(REASON_NO_DEPOSIT_ADDRESS.into()));
    let via_1click = decide(&DecideInput { deposit_address: Some(DEPOSIT), ..decide_input(Some(&base), &token) });
    assert!(matches!(via_1click, Decision::Execute { direct: false, .. }));
}

#[test]
fn ft_refund_amount_by_token() {
    assert_eq!(ft_refund_amount(&acc(TOKEN), &acc(TOKEN), 50), 0);
    assert_eq!(ft_refund_amount(&acc("evil.testnet"), &acc(TOKEN), 50), 50);
}

// ======================================================================= contract: access control

#[test]
#[should_panic(expected = "agent must be a different account from owner")]
fn init_rejects_agent_equal_owner() {
    as_caller(OWNER, 0, NOW);
    Treasury::new(acc(OWNER), acc(OWNER), acc(REGISTRY), acc(TOKEN), U128(1), U128(1), 0);
}

#[test]
#[should_panic(expected = "only the agent can propose payments")]
fn non_agent_cannot_propose() {
    let mut t = setup();
    as_caller(OWNER, 0, NOW);
    let _ = t.propose_payment("h".into(), acc(ACME), U128(1), 1, None, None, None);
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn non_owner_cannot_set_policy() {
    let mut t = setup();
    as_caller(AGENT, 1, NOW);
    t.set_vendor_policy(acc(ACME), U128(1), U128(1));
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn agent_cannot_approve() {
    let mut t = setup();
    let id = propose(&mut t, "h", 1);
    registry_answers(&mut t, id, Some(old_near_vendor()));
    as_caller(AGENT, 1, NOW);
    let _ = t.approve_payment(id);
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn agent_cannot_withdraw() {
    let mut t = setup();
    as_caller(AGENT, 1, NOW);
    let _ = t.withdraw(U128(1), acc(AGENT));
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn agent_cannot_unpause_or_change_limits() {
    let mut t = setup();
    as_caller(AGENT, 1, NOW);
    t.set_limits(U128(u128::MAX), U128(u128::MAX), 0);
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn agent_cannot_set_agent() {
    let mut t = setup();
    as_caller(AGENT, 1, NOW);
    t.set_agent(acc("other.testnet"));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn withdraw_requires_one_yocto() {
    let mut t = setup();
    as_caller(OWNER, 0, NOW);
    let _ = t.withdraw(U128(1), acc(OWNER));
}

#[test]
#[should_panic(expected = "agent must be a different account from owner")]
fn set_agent_rejects_owner() {
    let mut t = setup();
    as_caller(OWNER, 1, NOW);
    t.set_agent(acc(OWNER));
}

#[test]
fn owner_admin_methods_work() {
    let mut t = setup();
    as_caller(OWNER, 1, NOW);
    t.set_agent(acc("agent2.testnet"));
    t.set_limits(U128(5), U128(6), 7);
    let c = t.get_config();
    assert_eq!(c.agent, acc("agent2.testnet"));
    assert_eq!((c.auto_pay_threshold.0, c.monthly_cap.0, c.min_payout_age_sec), (5, 6, 7));
    t.remove_vendor_policy(acc(ACME));
    assert_eq!(t.get_vendor_policy(acc(ACME)), None);
    let _ = t.withdraw(U128(10), acc(OWNER));
    assert!(event_names().contains(&"withdrawal".to_string()));
}

// ======================================================================= contract: propose rejects

#[test]
#[should_panic(expected = "treasury is paused")]
fn paused_blocks_agent() {
    let mut t = setup();
    as_caller(OWNER, 0, NOW);
    t.pause();
    assert!(t.get_config().paused);
    propose(&mut t, "h", 1);
}

#[test]
fn unpause_restores_agent() {
    let mut t = setup();
    as_caller(OWNER, 0, NOW);
    t.pause();
    as_caller(OWNER, 1, NOW);
    t.unpause();
    propose(&mut t, "h", 1);
    assert_eq!(t.get_config().payment_count, 1);
}

#[test]
#[should_panic(expected = "invoice already used")]
fn duplicate_invoice_rejected() {
    let mut t = setup();
    propose(&mut t, "inv-1", 1);
    propose(&mut t, "inv-1", 1);
}

#[test]
#[should_panic(expected = "invoice already used")]
fn rejected_invoice_hash_stays_used() {
    let mut t = setup();
    let id = propose(&mut t, "inv-1", 1);
    assert_eq!(registry_answers(&mut t, id, None), Some(PaymentStatus::Rejected));
    assert!(t.is_invoice_used("inv-1".into()));
    propose(&mut t, "inv-1", 1);
}

#[test]
#[should_panic(expected = "vendor not approved (no policy)")]
fn unknown_vendor_rejected() {
    let mut t = setup();
    as_caller(AGENT, 0, NOW);
    let _ = t.propose_payment("h".into(), acc("bob.testnet"), U128(1), 1, None, None, None);
}

#[test]
#[should_panic(expected = "amount above vendor max_per_invoice")]
fn over_max_per_invoice_rejected() {
    let mut t = setup();
    propose(&mut t, "h", 500_000_001);
}

#[test]
#[should_panic(expected = "over vendor monthly cap")]
fn over_vendor_monthly_cap_rejected() {
    let mut t = setup();
    propose(&mut t, "a", 500_000_000); // Verifying counts as committed
    propose(&mut t, "b", 300_000_001); // 800_000_001 > 800_000_000
}

#[test]
#[should_panic(expected = "over treasury monthly cap")]
fn over_treasury_monthly_cap_rejected() {
    let mut t = setup();
    as_caller(OWNER, 1, NOW);
    t.set_vendor_policy(acc("bob.testnet"), U128(TREASURY_CAP), U128(TREASURY_CAP));
    propose(&mut t, "a", 500_000_000); // acme
    as_caller(AGENT, 0, NOW);
    let _ = t.propose_payment("b".into(), acc("bob.testnet"), U128(500_000_001), 1, None, None, None);
}

#[test]
fn cap_resets_in_next_bucket() {
    let mut t = setup();
    propose(&mut t, "a", 500_000_000);
    propose(&mut t, "b", 300_000_000);
    as_caller(AGENT, 0, NOW + BUCKET_NS);
    assert_eq!(t.monthly_spent(Some(acc(ACME))).0, 0);
    let _ = t.propose_payment("c".into(), acc(ACME), U128(500_000_000), 1, None, None, None);
    assert_eq!(t.monthly_spent(Some(acc(ACME))).0, 500_000_000);
}

// ======================================================================= contract: flows

#[test]
fn propose_records_verifying_and_commits() {
    let mut t = setup();
    let id = propose_with_deposit(&mut t, "inv-1", 7);
    let p = t.get_payment(id).unwrap();
    assert_eq!(p.status, PaymentStatus::Verifying);
    assert_eq!(p.quote_hash.as_deref(), Some("quote-abc"));
    assert_eq!(p.bucket, 3);
    assert_eq!(t.monthly_spent(Some(acc(ACME))).0, 7);
    assert_eq!(t.monthly_spent(None).0, 7);
    assert!(t.is_invoice_used("inv-1".into()));
    let ev = events();
    assert_eq!(ev[0]["standard"], "orvantra_treasury");
    assert_eq!(ev[0]["version"], "1.0.0");
    assert_eq!(ev[0]["event"], "payment_proposed");
    assert_eq!(ev[0]["data"][0]["amount"], "7");
}

#[test]
fn not_in_registry_rejects_and_releases() {
    let mut t = setup();
    let id = propose(&mut t, "h", 50);
    assert_eq!(registry_answers(&mut t, id, None), Some(PaymentStatus::Rejected));
    let p = t.get_payment(id).unwrap();
    assert_eq!(p.reasons, vec![REASON_NOT_IN_REGISTRY]);
    assert_eq!(t.monthly_spent(None).0, 0);
    assert_eq!(event_names(), vec!["payment_rejected"]);
}

#[test]
fn version_mismatch_rejects() {
    let mut t = setup();
    let id = propose(&mut t, "h", 50);
    assert_eq!(registry_answers(&mut t, id, Some(near_vendor(2, DAY_NS))), Some(PaymentStatus::Rejected));
    assert_eq!(t.get_payment(id).unwrap().reasons, vec![REASON_VERSION_CHANGED]);
}

#[test]
fn registry_call_failure_rejects() {
    let mut t = setup();
    let id = propose(&mut t, "h", 50);
    as_callback(NOW, PromiseResult::Failed);
    let r = t.on_proposal_checked(id, Err(PromiseError::Failed));
    assert_eq!(status_of(r), Some(PaymentStatus::Rejected));
    assert_eq!(t.get_payment(id).unwrap().reasons, vec![REASON_REGISTRY_FAILED]);
    assert_eq!(t.monthly_spent(None).0, 0);
}

#[test]
fn missing_deposit_address_rejects() {
    let mut t = setup();
    let id = propose(&mut t, "h", 50);
    assert_eq!(registry_answers(&mut t, id, Some(base_vendor(1, DAY_NS))), Some(PaymentStatus::Rejected));
    assert_eq!(t.get_payment(id).unwrap().reasons, vec![REASON_NO_DEPOSIT_ADDRESS]);
}

#[test]
fn first_payment_goes_pending() {
    let mut t = setup();
    let id = propose(&mut t, "h", 50);
    assert_eq!(registry_answers(&mut t, id, Some(old_near_vendor())), Some(PaymentStatus::Pending));
    let p = t.get_payment(id).unwrap();
    assert_eq!(p.reasons, vec![HOLD_FIRST_PAYMENT]);
    assert_eq!(p.destination, Some(acc("acme-payouts.testnet")));
    assert!(p.direct);
    assert_eq!(t.get_pending().len(), 1);
    assert_eq!(t.monthly_spent(None).0, 50, "pending stays committed");
    assert_eq!(event_names(), vec!["payment_pending"]);
}

#[test]
fn small_payment_to_known_vendor_auto_pays_direct() {
    let mut t = setup();
    pay_once(&mut t);
    let id = propose(&mut t, "inv-2", 50);
    assert_eq!(registry_answers(&mut t, id, Some(old_near_vendor())), None, "ft_transfer scheduled");
    assert_eq!(t.get_payment(id).unwrap().status, PaymentStatus::Executing);
    assert_eq!(transfer_result(&mut t, true), PaymentStatus::Paid);
    assert_eq!(event_names(), vec!["payment_paid"]);
    assert_eq!(t.monthly_spent(Some(acc(ACME))).0, 1_000_000 + 50);
}

#[test]
fn cross_chain_auto_pays_to_deposit_address() {
    let mut t = setup();
    pay_once(&mut t);
    let id = propose_with_deposit(&mut t, "inv-2", 50);
    assert_eq!(registry_answers(&mut t, id, Some(base_vendor(1, DAY_NS))), None);
    let p = t.get_payment(id).unwrap();
    assert_eq!(p.destination, Some(acc(DEPOSIT)));
    assert!(!p.direct);
    assert_eq!(p.payout.unwrap().chain, "base");
}

#[test]
fn over_threshold_goes_pending() {
    let mut t = setup();
    pay_once(&mut t);
    let id = propose(&mut t, "big", THRESHOLD + 1);
    assert_eq!(registry_answers(&mut t, id, Some(old_near_vendor())), Some(PaymentStatus::Pending));
    assert_eq!(t.get_payment(id).unwrap().reasons, vec![HOLD_OVER_THRESHOLD]);
}

#[test]
fn fresh_payout_goes_pending() {
    let mut t = setup();
    pay_once(&mut t);
    let id = propose(&mut t, "inv", 50);
    let fresh = near_vendor(1, NOW - DAY_NS); // changed 1 day ago, min age is 3 days
    assert_eq!(registry_answers(&mut t, id, Some(fresh)), Some(PaymentStatus::Pending));
    assert_eq!(t.get_payment(id).unwrap().reasons, vec![HOLD_FRESH_PAYOUT]);
}

#[test]
fn transfer_failure_marks_failed_and_releases() {
    let mut t = setup();
    pay_once(&mut t);
    let before = t.monthly_spent(None).0;
    let id = propose(&mut t, "inv", 50);
    registry_answers(&mut t, id, Some(old_near_vendor()));
    assert_eq!(t.monthly_spent(None).0, before + 50);
    assert_eq!(transfer_result(&mut t, false), PaymentStatus::Failed);
    assert_eq!(t.monthly_spent(None).0, before);
    assert_eq!(t.monthly_spent(Some(acc(ACME))).0, before);
    assert_eq!(event_names(), vec!["payment_failed"]);
}

#[test]
fn failed_first_payment_does_not_mark_vendor_known() {
    let mut t = setup();
    let id = propose(&mut t, "a", 50);
    registry_answers(&mut t, id, Some(old_near_vendor()));
    as_caller(OWNER, 1, NOW);
    let _ = t.approve_payment(id);
    let _ = t.on_approval_checked(id, Ok(Some(old_near_vendor())));
    assert_eq!(transfer_result(&mut t, false), PaymentStatus::Failed);
    let id2 = propose(&mut t, "b", 50);
    assert_eq!(registry_answers(&mut t, id2, Some(old_near_vendor())), Some(PaymentStatus::Pending));
}

#[test]
fn approve_flow_pending_to_paid() {
    let mut t = setup();
    let id = propose(&mut t, "inv", 50);
    registry_answers(&mut t, id, Some(old_near_vendor()));
    as_caller(OWNER, 1, NOW);
    let _ = t.approve_payment(id);
    let p = t.get_payment(id).unwrap();
    assert_eq!(p.status, PaymentStatus::Verifying);
    assert!(p.approved_by_owner);
    assert!(t.get_pending().is_empty());
    assert_eq!(event_names(), vec!["payment_approved"]);

    as_callback(NOW, PromiseResult::Successful(vec![]));
    assert_eq!(status_of(t.on_approval_checked(id, Ok(Some(old_near_vendor())))), None);
    assert_eq!(t.get_payment(id).unwrap().status, PaymentStatus::Executing);
    assert_eq!(transfer_result(&mut t, true), PaymentStatus::Paid);
}

#[test]
fn approve_rechecks_registry_version() {
    let mut t = setup();
    let id = propose(&mut t, "inv", 50);
    registry_answers(&mut t, id, Some(old_near_vendor()));
    as_caller(OWNER, 1, NOW);
    let _ = t.approve_payment(id);
    as_callback(NOW, PromiseResult::Successful(vec![]));
    let changed = near_vendor(2, NOW);
    assert_eq!(status_of(t.on_approval_checked(id, Ok(Some(changed)))), Some(PaymentStatus::Rejected));
    assert_eq!(t.get_payment(id).unwrap().reasons, vec![HOLD_FIRST_PAYMENT, REASON_VERSION_CHANGED]);
    assert_eq!(t.monthly_spent(None).0, 0);
}

#[test]
fn approve_rejects_if_vendor_removed_from_registry() {
    let mut t = setup();
    let id = propose(&mut t, "inv", 50);
    registry_answers(&mut t, id, Some(old_near_vendor()));
    as_caller(OWNER, 1, NOW);
    let _ = t.approve_payment(id);
    assert_eq!(status_of(t.on_approval_checked(id, Ok(None))), Some(PaymentStatus::Rejected));
}

#[test]
#[should_panic(expected = "payment is not pending")]
fn cannot_approve_twice() {
    let mut t = setup();
    let id = propose(&mut t, "inv", 50);
    registry_answers(&mut t, id, Some(old_near_vendor()));
    as_caller(OWNER, 1, NOW);
    let _ = t.approve_payment(id);
    let _ = t.approve_payment(id);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn approve_requires_one_yocto() {
    let mut t = setup();
    let id = propose(&mut t, "inv", 50);
    registry_answers(&mut t, id, Some(old_near_vendor()));
    as_caller(OWNER, 0, NOW);
    let _ = t.approve_payment(id);
}

#[test]
fn owner_rejects_pending() {
    let mut t = setup();
    let id = propose(&mut t, "inv", 50);
    registry_answers(&mut t, id, Some(old_near_vendor()));
    as_caller(OWNER, 0, NOW);
    t.reject_payment(id, "looks wrong".into());
    let p = t.get_payment(id).unwrap();
    assert_eq!(p.status, PaymentStatus::Rejected);
    assert_eq!(p.reasons.last().unwrap(), "owner: looks wrong");
    assert!(t.get_pending().is_empty());
    assert_eq!(t.monthly_spent(None).0, 0);
}

#[test]
fn callback_after_owner_reject_is_noop() {
    let mut t = setup();
    let id = propose(&mut t, "inv", 50);
    as_caller(OWNER, 0, NOW);
    t.reject_payment(id, "stuck".into()); // still Verifying
    assert_eq!(registry_answers(&mut t, id, Some(old_near_vendor())), Some(PaymentStatus::Rejected));
    assert_eq!(t.monthly_spent(None).0, 0, "released only once");
}

#[test]
#[should_panic(expected = "payment is not pending")]
fn cannot_reject_paid() {
    let mut t = setup();
    pay_once(&mut t);
    as_caller(OWNER, 0, NOW);
    t.reject_payment(0, "too late".into());
}

#[test]
fn transfer_callback_ignores_non_executing() {
    let mut t = setup();
    let id = propose(&mut t, "inv", 50);
    as_callback(NOW, PromiseResult::Successful(vec![]));
    assert_eq!(t.on_payment_transferred(id), PaymentStatus::Verifying);
}

// ======================================================================= ft_on_transfer + views

#[test]
fn ft_on_transfer_keeps_configured_token() {
    let mut t = setup();
    as_caller(TOKEN, 0, NOW);
    match t.ft_on_transfer(acc(OWNER), U128(1_000), String::new()) {
        PromiseOrValue::Value(v) => assert_eq!(v.0, 0),
        _ => panic!("expected value"),
    }
}

#[test]
fn ft_on_transfer_refunds_wrong_token() {
    let mut t = setup();
    as_caller("fake-usdc.testnet", 0, NOW);
    match t.ft_on_transfer(acc(OWNER), U128(1_000), String::new()) {
        PromiseOrValue::Value(v) => assert_eq!(v.0, 1_000),
        _ => panic!("expected value"),
    }
}

#[test]
fn get_payments_pagination() {
    let mut t = setup();
    for i in 0..5 {
        propose(&mut t, &format!("inv-{i}"), 1);
    }
    assert_eq!(t.get_payments(None, None).len(), 5);
    let page: Vec<u64> = t.get_payments(Some(1), Some(2)).iter().map(|p| p.id).collect();
    assert_eq!(page, vec![1, 2]);
    assert!(t.get_payments(Some(10), None).is_empty());
    assert_eq!(t.get_payment(99), None);
}

#[test]
fn config_and_policy_views() {
    let t = setup();
    let c = t.get_config();
    assert_eq!(c.owner, acc(OWNER));
    assert_eq!(c.agent, acc(AGENT));
    assert_eq!(c.registry, acc(REGISTRY));
    assert_eq!(c.token, acc(TOKEN));
    assert!(!c.paused);
    assert_eq!(t.get_vendor_policy(acc(ACME)), Some(policy(500_000_000, 800_000_000)));
}
