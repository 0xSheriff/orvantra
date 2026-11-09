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

/// "Now" in most tests: the start of day 100.
const NOW: u64 = 100 * DAY_NS;
const THRESHOLD: u128 = 100_000_000; // 100 tUSDC
const TREASURY_CAP: u128 = 1_000_000_000; // 1000 tUSDC
const MIN_AGE_SEC: u64 = 3 * 24 * 3600; // 3 days

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

/// A valid 64-hex invoice hash for a short label (hex of the label, zero-padded).
fn hx(label: &str) -> String {
    let s: String = label.bytes().map(|b| format!("{b:02x}")).collect();
    assert!(s.len() <= 64, "label too long: {label}");
    format!("{s:0<64}")
}

fn new_treasury(threshold: u128, cap: u128, min_age: u64, storage_deposit: Option<U128>) -> Treasury {
    Treasury::new(
        acc(OWNER),
        acc(AGENT),
        acc(REGISTRY),
        acc(TOKEN),
        U128(threshold),
        U128(cap),
        min_age,
        storage_deposit,
        None,
        None,
        None,
        None,
    )
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
    let mut t = new_treasury(THRESHOLD, TREASURY_CAP, MIN_AGE_SEC, None);
    as_caller(OWNER, 1, NOW);
    t.set_vendor_policy(acc(ACME), U128(500_000_000), U128(800_000_000));
    t
}

/// Propose `amount` to acme at `ts` (label -> 64-hex hash via `hx`).
fn propose_at(t: &mut Treasury, label: &str, amount: u128, ts: u64) -> u64 {
    as_caller(AGENT, 0, ts);
    let _ = t.propose_payment(hx(label), acc(ACME), U128(amount), 1, None, None, None, None);
    t.get_config().payment_count - 1
}

fn propose(t: &mut Treasury, label: &str, amount: u128) -> u64 {
    propose_at(t, label, amount, NOW)
}

fn propose_with_deposit(t: &mut Treasury, label: &str, amount: u128) -> u64 {
    as_caller(AGENT, 0, NOW);
    let _ = t.propose_payment(
        hx(label),
        acc(ACME),
        U128(amount),
        1,
        Some(DEPOSIT.into()),
        Some("quote-abc".into()),
        Some("inv 42".into()),
        None,
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
        open_payments: 0,
        max_open_payments: DEFAULT_MAX_OPEN_PAYMENTS,
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
fn check_rejects_too_many_open_payments() {
    let p = policy(100, 500);
    assert!(check_proposal(&ProposalCheck { open_payments: 24, max_open_payments: 25, ..ok_check(&p) }).is_ok());
    let c = ProposalCheck { open_payments: 25, max_open_payments: 25, ..ok_check(&p) };
    assert!(check_proposal(&c).unwrap_err().starts_with("too many open payments (max 25)"));
}

#[test]
fn validate_inputs_bounds_strings() {
    assert!(validate_inputs(None, None, None).is_ok());
    let long = "x".repeat(MAX_DEPOSIT_ADDRESS_LEN + 1);
    assert!(validate_inputs(Some(&long), None, None).unwrap_err().contains("deposit_address"));
    assert!(validate_inputs(None, Some(&long), None).unwrap_err().contains("quote_hash"));
    let memo = "m".repeat(MAX_MEMO_LEN + 1);
    assert!(validate_inputs(None, None, Some(&memo)).unwrap_err().contains("memo"));
}

#[test]
fn invoice_hash_must_be_64_hex_and_is_lowercased() {
    let upper = "AB".repeat(32);
    assert_eq!(normalize_invoice_hash(&upper).unwrap(), "ab".repeat(32));
    assert_eq!(normalize_invoice_hash(&hx("x")).unwrap(), hx("x"));
    for bad in ["", "h", &"a".repeat(63), &"a".repeat(65), &format!("{}g", "a".repeat(63))] {
        assert!(normalize_invoice_hash(bad).unwrap_err().contains("64 hex chars"), "{bad}");
    }
}

// ======================================================================= pure: rolling window

#[test]
fn day_and_window_math() {
    assert_eq!(DAY_NS, 86_400 * NS_PER_SEC);
    assert_eq!(day_of(0), 0);
    assert_eq!(day_of(DAY_NS - 1), 0);
    assert_eq!(day_of(DAY_NS), 1);
    assert_eq!(day_of(NOW), 100);
    assert_eq!(window_days(100), 71..=100);
    assert_eq!(window_days(100).count(), 30);
    assert_eq!(window_days(5), 0..=5, "early days do not underflow");
}

#[test]
fn available_near_math() {
    // 10 NEAR balance, 1 NEAR locked, 100 kB storage at 1e19 yocto/byte (= 1 NEAR).
    let near = 10u128.pow(24);
    assert_eq!(available_near(10 * near, near, 100_000, 10u128.pow(19)), 8 * near);
    assert_eq!(available_near(near, 0, 1_000_000, 10u128.pow(19)), 0, "saturates");
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
    let d = select_destination(&v.payout, &acc(TOKEN), Some(DEPOSIT), &[]).unwrap();
    assert_eq!(d, (acc("acme-payouts.testnet"), true));
}

#[test]
fn destination_near_but_other_token_uses_deposit_address() {
    let mut v = near_vendor(1, 0);
    v.payout.asset_id = "nep141:other-token.testnet".into();
    let d = select_destination(&v.payout, &acc(TOKEN), Some(DEPOSIT), &[]).unwrap();
    assert_eq!(d, (acc(DEPOSIT), false));
}

#[test]
fn destination_cross_chain_uses_deposit_address() {
    let v = base_vendor(1, 0);
    let d = select_destination(&v.payout, &acc(TOKEN), Some(DEPOSIT), &[]).unwrap();
    assert_eq!(d, (acc(DEPOSIT), false));
}

#[test]
fn destination_cross_chain_requires_deposit_address() {
    let v = base_vendor(1, 0);
    assert_eq!(select_destination(&v.payout, &acc(TOKEN), None, &[]).unwrap_err(), REASON_NO_DEPOSIT_ADDRESS);
}

#[test]
fn destination_rejects_invalid_deposit_address() {
    let v = base_vendor(1, 0);
    let e = select_destination(&v.payout, &acc(TOKEN), Some("Not A Valid Account!"), &[]).unwrap_err();
    assert_eq!(e, REASON_BAD_DEPOSIT_ADDRESS);
}

#[test]
fn destination_deposit_address_must_be_64_lowercase_hex() {
    let v = base_vendor(1, 0);
    let bad = [
        "agent.testnet".to_string(),                  // named account (e.g. the attacker's own)
        EVM_ADDR.to_string(),                         // eth-implicit account id
        DEPOSIT.to_uppercase(),                       // uppercase hex is not an account id
        DEPOSIT[..63].to_string(),                    // 63 chars
        format!("{DEPOSIT}0"),                        // 65 chars
        format!("{}g", &DEPOSIT[..63]),               // non-hex
    ];
    for b in &bad {
        let e = select_destination(&v.payout, &acc(TOKEN), Some(b), &[]).unwrap_err();
        assert_eq!(e, REASON_BAD_DEPOSIT_ADDRESS, "{b}");
    }
    assert!(is_implicit_account(DEPOSIT));
}

#[test]
fn destination_rejects_forbidden_deposit_address() {
    let v = base_vendor(1, 0);
    let me = acc(DEPOSIT);
    let other = acc(&"b".repeat(64));
    let e = select_destination(&v.payout, &acc(TOKEN), Some(DEPOSIT), &[&other, &me]).unwrap_err();
    assert_eq!(e, REASON_FORBIDDEN_DEPOSIT_ADDRESS);
    assert!(select_destination(&v.payout, &acc(TOKEN), Some(DEPOSIT), &[&other]).is_ok());
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
        forbidden_destinations: &[],
        amount: 10,
        auto_pay_threshold: THRESHOLD,
        cross_chain_auto_pay_threshold: 0,
        min_payout_age_sec: MIN_AGE_SEC,
        now_ns: NOW,
        first_payment: false,
        agent_reasons: &[],
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
    // Cross-chain: held by default (threshold 0), auto-pays only up to the cross-chain threshold.
    let via_1click = decide(&DecideInput { deposit_address: Some(DEPOSIT), ..decide_input(Some(&base), &token) });
    assert!(matches!(via_1click, Decision::Hold { direct: false, ref reasons, .. }
        if reasons == &vec![HOLD_CROSS_CHAIN.to_string()]));
    let small = DecideInput {
        deposit_address: Some(DEPOSIT),
        cross_chain_auto_pay_threshold: 10,
        ..decide_input(Some(&base), &token)
    };
    assert!(matches!(decide(&small), Decision::Execute { direct: false, .. }));
    let over = DecideInput { amount: 11, ..small.clone() };
    assert!(matches!(decide(&over), Decision::Hold { ref reasons, .. } if reasons == &vec![HOLD_CROSS_CHAIN.to_string()]));
    // Direct payouts ignore the cross-chain threshold.
    assert!(matches!(decide(&decide_input(Some(&old), &token)), Decision::Execute { direct: true, .. }));
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
    Treasury::new(
        acc(OWNER), acc(OWNER), acc(REGISTRY), acc(TOKEN), U128(1), U128(1), 0, None, None, None, None, None,
    );
}

#[test]
#[should_panic(expected = "only the agent can propose payments")]
fn non_agent_cannot_propose() {
    let mut t = setup();
    as_caller(OWNER, 0, NOW);
    let _ = t.propose_payment(hx("h"), acc(ACME), U128(1), 1, None, None, None, None);
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
    assert!(!event_names().contains(&"withdrawal".to_string()), "only emitted after success");
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
    assert!(t.is_invoice_used(hx("inv-1")));
    propose(&mut t, "inv-1", 1);
}

#[test]
#[should_panic(expected = "vendor not approved (no policy)")]
fn unknown_vendor_rejected() {
    let mut t = setup();
    as_caller(AGENT, 0, NOW);
    let _ = t.propose_payment(hx("h"), acc("bob.testnet"), U128(1), 1, None, None, None, None);
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
    let _ = t.propose_payment(hx("b"), acc("bob.testnet"), U128(500_000_001), 1, None, None, None, None);
}

#[test]
fn cap_frees_up_after_30_days() {
    let mut t = setup();
    propose(&mut t, "a", 500_000_000);
    propose(&mut t, "b", 300_000_000);
    // Day 129 is still in the window (days 100..=129).
    as_caller(AGENT, 0, NOW + 29 * DAY_NS);
    assert_eq!(t.monthly_spent(Some(acc(ACME))).0, 800_000_000);
    // Day 130: day 100 has left the window.
    as_caller(AGENT, 0, NOW + 30 * DAY_NS);
    assert_eq!(t.monthly_spent(Some(acc(ACME))).0, 0);
    let _ = t.propose_payment(hx("c"), acc(ACME), U128(500_000_000), 1, None, None, None, None);
    assert_eq!(t.monthly_spent(Some(acc(ACME))).0, 500_000_000);
}

/// C-M1: with fixed 30-day buckets the cap could be spent twice seconds apart at a bucket edge.
#[test]
#[should_panic(expected = "over vendor monthly cap")]
fn cap_cannot_be_spent_twice_across_a_day_boundary() {
    let mut t = setup();
    let end_of_day = NOW + DAY_NS - 1;
    propose_at(&mut t, "a", 500_000_000, end_of_day);
    propose_at(&mut t, "b", 300_000_000, end_of_day);
    propose_at(&mut t, "c", 1, end_of_day + 2 * NS_PER_SEC); // next day, 2 s later
}

#[test]
#[should_panic(expected = "over treasury monthly cap")]
fn treasury_cap_is_rolling_too() {
    let mut t = setup();
    as_caller(OWNER, 1, NOW);
    t.set_vendor_policy(acc("bob.testnet"), U128(TREASURY_CAP), U128(TREASURY_CAP));
    propose_at(&mut t, "a", 500_000_000, NOW); // acme, day 100
    as_caller(AGENT, 0, NOW + 15 * DAY_NS); // bob, day 115: 500 + 500 = cap
    let _ = t.propose_payment(hx("b"), acc("bob.testnet"), U128(500_000_000), 1, None, None, None, None);
    as_caller(AGENT, 0, NOW + 29 * DAY_NS); // day 129: both still count
    let _ = t.propose_payment(hx("c"), acc("bob.testnet"), U128(1), 1, None, None, None, None);
}

#[test]
fn release_uses_the_payments_own_day() {
    let mut t = setup();
    let id = propose_at(&mut t, "a", 50, NOW); // day 100
    propose_at(&mut t, "b", 7, NOW + 3 * DAY_NS); // day 103
    as_caller(OWNER, 0, NOW + 5 * DAY_NS);
    t.reject_payment(id, "no".into());
    assert_eq!(t.monthly_spent(None).0, 7);
    assert_eq!(t.vendor_spent.get(&(acc(ACME), 100)), None, "zero counters are deleted");
    assert_eq!(t.vendor_spent.get(&(acc(ACME), 103)), Some(&7));
}

// ======================================================================= contract: flows

#[test]
fn propose_records_verifying_and_commits() {
    let mut t = setup();
    let id = propose_with_deposit(&mut t, "inv-1", 7);
    let p = t.get_payment(id).unwrap();
    assert_eq!(p.status, PaymentStatus::Verifying);
    assert_eq!(p.quote_hash.as_deref(), Some("quote-abc"));
    assert_eq!(p.day, 100);
    assert_eq!(t.monthly_spent(Some(acc(ACME))).0, 7);
    assert_eq!(t.monthly_spent(None).0, 7);
    assert!(t.is_invoice_used(hx("inv-1")));
    assert_eq!(t.get_config().open_payments, 1);
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

/// Cross-chain payouts above `cross_chain_auto_pay_threshold`: always held for the owner.
fn allow_cross_chain_auto_pay(t: &mut Treasury, amount: u128) {
    as_caller(OWNER, 1, NOW);
    t.set_cross_chain_auto_pay_threshold(U128(amount));
}

/// C-H1: by default (threshold 0) a stolen agent key cannot auto-pay ANY cross-chain proposal.
#[test]
fn cross_chain_is_held_by_default() {
    let mut t = setup();
    pay_once(&mut t);
    assert_eq!(t.get_config().cross_chain_auto_pay_threshold.0, 0);
    let id = propose_with_deposit(&mut t, "inv-2", 50);
    assert_eq!(registry_answers(&mut t, id, Some(base_vendor(1, DAY_NS))), Some(PaymentStatus::Pending));
    let p = t.get_payment(id).unwrap();
    assert_eq!(p.reasons, vec![HOLD_CROSS_CHAIN]);
    assert_eq!(p.destination, Some(acc(DEPOSIT)));
    assert!(calls().is_empty(), "nothing executes");
}

#[test]
fn cross_chain_auto_pays_up_to_its_threshold() {
    let mut t = setup();
    pay_once(&mut t);
    allow_cross_chain_auto_pay(&mut t, 50);
    assert!(event_names().contains(&"cross_chain_threshold_changed".to_string()));
    let id = propose_with_deposit(&mut t, "inv-2", 50);
    assert_eq!(registry_answers(&mut t, id, Some(base_vendor(1, DAY_NS))), None);
    let p = t.get_payment(id).unwrap();
    assert_eq!(p.destination, Some(acc(DEPOSIT)));
    assert!(!p.direct);
    assert_eq!(p.payout.unwrap().chain, "base");
    let id = propose_with_deposit(&mut t, "inv-3", 51);
    assert_eq!(registry_answers(&mut t, id, Some(base_vendor(1, DAY_NS))), Some(PaymentStatus::Pending));
}

#[test]
fn cross_chain_threshold_can_be_set_at_init() {
    as_caller(OWNER, 0, NOW);
    let t = Treasury::new(
        acc(OWNER), acc(AGENT), acc(REGISTRY), acc(TOKEN), U128(1), U128(1), 0, None, None,
        Some(U128(42)), Some(3), Some(U128(7)),
    );
    let c = t.get_config();
    assert_eq!(c.cross_chain_auto_pay_threshold.0, 42);
    assert_eq!(c.max_open_payments, 3);
    assert_eq!(c.near_reserve.0, 7);
    let d = setup().get_config();
    assert_eq!((d.max_open_payments, d.near_reserve.0), (DEFAULT_MAX_OPEN_PAYMENTS, DEFAULT_NEAR_RESERVE));
}

/// C-H1: a stolen agent key cannot name the treasury, token, agent or owner as deposit address.
#[test]
fn deposit_address_cannot_be_a_treasury_role() {
    let agent_hex = "c".repeat(64);
    as_caller(OWNER, 0, NOW);
    let mut t = Treasury::new(
        acc(OWNER), acc(&agent_hex), acc(REGISTRY), acc(TOKEN), U128(THRESHOLD), U128(TREASURY_CAP),
        MIN_AGE_SEC, None, None, Some(U128(THRESHOLD)), None, None,
    );
    as_caller(OWNER, 1, NOW);
    t.set_vendor_policy(acc(ACME), U128(500), U128(800));
    as_caller(&agent_hex, 0, NOW);
    let _ = t.propose_payment(hx("a"), acc(ACME), U128(5), 1, Some(agent_hex.clone()), None, None, None);
    assert_eq!(registry_answers(&mut t, 0, Some(base_vendor(1, DAY_NS))), Some(PaymentStatus::Rejected));
    assert_eq!(t.get_payment(0).unwrap().reasons, vec![REASON_FORBIDDEN_DEPOSIT_ADDRESS]);
}

#[test]
fn named_deposit_address_is_rejected() {
    let mut t = setup();
    as_caller(AGENT, 0, NOW);
    let _ = t.propose_payment(hx("a"), acc(ACME), U128(5), 1, Some("attacker.testnet".into()), None, None, None);
    assert_eq!(registry_answers(&mut t, 0, Some(base_vendor(1, DAY_NS))), Some(PaymentStatus::Rejected));
    assert_eq!(t.get_payment(0).unwrap().reasons, vec![REASON_BAD_DEPOSIT_ADDRESS]);
    assert_eq!(t.monthly_spent(None).0, 0);
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

// ======================================================================= day 5: promise chains

/// A cross-contract call created by the contract under test (from the mocked blockchain).
#[derive(Debug)]
struct Call {
    receiver: String,
    method: String,
    args: Value,
    deposit: u128,
    gas_tgas: u64,
    /// Indices of receipts this one waits for (`.then`).
    after: Vec<u64>,
}

fn calls() -> Vec<Call> {
    near_sdk::test_utils::get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let receiver = r.receiver_id.to_string();
            let after: Vec<u64> = r.receipt_indices.iter().map(|i| *i as u64).collect();
            r.actions.into_iter().filter_map(move |a| match a {
                near_sdk::mock::MockAction::FunctionCallWeight {
                    method_name, args, attached_deposit, prepaid_gas, ..
                } => Some(Call {
                    receiver: receiver.clone(),
                    method: String::from_utf8(method_name).unwrap(),
                    args: near_sdk::serde_json::from_slice(&args).unwrap_or(Value::Null),
                    deposit: attached_deposit.as_yoctonear(),
                    gas_tgas: prepaid_gas.as_gas() / 1_000_000_000_000,
                    after: after.clone(),
                }),
                _ => None,
            })
        })
        .collect()
}

fn assert_register_chain(c: &[Call], dest: &str, id: u64, deposit: u128) {
    assert_eq!(c.len(), 2, "{c:?}");
    assert_eq!(c[0].receiver, TOKEN);
    assert_eq!(c[0].method, "storage_deposit");
    assert_eq!(c[0].args, json!({ "account_id": dest, "registration_only": true }));
    assert_eq!(c[0].deposit, deposit);
    assert_eq!(c[0].gas_tgas, 10);
    assert_eq!(c[1].receiver, TREASURY);
    assert_eq!(c[1].method, "on_payment_registered");
    assert_eq!(c[1].args, json!({ "id": id }));
    assert_eq!(c[1].deposit, 0);
    assert_eq!(c[1].gas_tgas, 30);
    assert_eq!(c[1].after, vec![0], "callback waits for storage_deposit");
}

fn registered_result(t: &mut Treasury, id: u64, ok: bool) -> PromiseOrValue<PaymentStatus> {
    let r = if ok {
        PromiseResult::Successful(br#"{"total":"1250000000000000000000","available":"0"}"#.to_vec())
    } else {
        PromiseResult::Failed
    };
    as_callback(NOW, r);
    t.on_payment_registered(id)
}

#[test]
fn execute_direct_registers_vendor_before_transfer() {
    let mut t = setup();
    pay_once(&mut t);
    let id = propose(&mut t, "inv-2", 50);
    assert_eq!(registry_answers(&mut t, id, Some(old_near_vendor())), None);
    assert_eq!(t.get_payment(id).unwrap().status, PaymentStatus::Executing);
    assert_register_chain(&calls(), "acme-payouts.testnet", id, DEFAULT_STORAGE_DEPOSIT);
}

#[test]
fn execute_cross_chain_registers_deposit_address() {
    let mut t = setup();
    pay_once(&mut t);
    allow_cross_chain_auto_pay(&mut t, THRESHOLD);
    let id = propose_with_deposit(&mut t, "inv-2", 50);
    assert_eq!(registry_answers(&mut t, id, Some(base_vendor(1, DAY_NS))), None);
    assert_register_chain(&calls(), DEPOSIT, id, DEFAULT_STORAGE_DEPOSIT);
}

#[test]
fn approve_path_also_registers_first() {
    let mut t = setup();
    let id = propose(&mut t, "inv", 50);
    registry_answers(&mut t, id, Some(old_near_vendor()));
    as_caller(OWNER, 1, NOW);
    let _ = t.approve_payment(id);
    as_callback(NOW, PromiseResult::Successful(vec![]));
    assert_eq!(status_of(t.on_approval_checked(id, Ok(Some(old_near_vendor())))), None);
    assert_register_chain(&calls(), "acme-payouts.testnet", id, DEFAULT_STORAGE_DEPOSIT);
}

#[test]
fn registered_ok_schedules_ft_transfer_then_callback() {
    let mut t = setup();
    pay_once(&mut t);
    allow_cross_chain_auto_pay(&mut t, THRESHOLD);
    let id = propose_with_deposit(&mut t, "inv-2", 50);
    registry_answers(&mut t, id, Some(base_vendor(1, DAY_NS)));
    assert!(matches!(registered_result(&mut t, id, true), PromiseOrValue::Promise(_)));
    let c = calls();
    assert_eq!(c.len(), 2, "{c:?}");
    assert_eq!((c[0].receiver.as_str(), c[0].method.as_str()), (TOKEN, "ft_transfer"));
    assert_eq!(c[0].args, json!({ "receiver_id": DEPOSIT, "amount": "50", "memo": "inv 42" }));
    assert_eq!((c[0].deposit, c[0].gas_tgas), (1, 10));
    assert_eq!((c[1].receiver.as_str(), c[1].method.as_str()), (TREASURY, "on_payment_transferred"));
    assert_eq!(c[1].args, json!({ "id": id }));
    assert_eq!((c[1].gas_tgas, c[1].after.clone()), (10, vec![0]));
    assert_eq!(t.get_payment(id).unwrap().status, PaymentStatus::Executing);
}

#[test]
fn registration_failure_fails_payment_and_releases_cap() {
    let mut t = setup();
    pay_once(&mut t);
    let before = t.monthly_spent(None).0;
    let id = propose(&mut t, "inv-2", 50);
    registry_answers(&mut t, id, Some(old_near_vendor()));
    assert_eq!(t.monthly_spent(None).0, before + 50);
    assert_eq!(status_of(registered_result(&mut t, id, false)), Some(PaymentStatus::Failed));
    let p = t.get_payment(id).unwrap();
    assert_eq!(p.reasons, vec![REASON_STORAGE_DEPOSIT_FAILED]);
    assert_eq!(t.monthly_spent(None).0, before);
    assert!(calls().is_empty(), "no ft_transfer after failed registration");
    assert_eq!(event_names(), vec!["payment_failed"]);
}

#[test]
fn registered_callback_ignores_non_executing() {
    let mut t = setup();
    let id = propose(&mut t, "inv", 50);
    assert_eq!(status_of(registered_result(&mut t, id, true)), Some(PaymentStatus::Verifying));
    assert!(calls().is_empty());
}

#[test]
fn full_chain_propose_register_transfer_paid() {
    let mut t = setup();
    pay_once(&mut t);
    let id = propose(&mut t, "inv-2", 50);
    registry_answers(&mut t, id, Some(old_near_vendor()));
    let _ = registered_result(&mut t, id, true);
    assert_eq!(transfer_result(&mut t, true), PaymentStatus::Paid);
    let p = t.get_payment(id).unwrap();
    assert_eq!(p.status, PaymentStatus::Paid);
    assert!(p.reasons.is_empty());
}

#[test]
fn transfer_failure_reason_after_registration() {
    let mut t = setup();
    pay_once(&mut t);
    let id = propose(&mut t, "inv-2", 50);
    registry_answers(&mut t, id, Some(old_near_vendor()));
    let _ = registered_result(&mut t, id, true);
    assert_eq!(transfer_result(&mut t, false), PaymentStatus::Failed);
    assert_eq!(t.get_payment(id).unwrap().reasons, vec![REASON_FT_TRANSFER_FAILED]);
}

#[test]
fn withdraw_registers_receiver_then_transfers() {
    let mut t = setup();
    as_caller(OWNER, 1, NOW);
    drop(t.withdraw(U128(10), acc(OWNER)));
    let c = calls();
    assert_eq!(c.len(), 3, "{c:?}");
    assert_eq!(c[0].method, "storage_deposit");
    assert_eq!(c[0].args["account_id"], OWNER);
    assert_eq!(c[0].deposit, DEFAULT_STORAGE_DEPOSIT);
    assert_eq!(c[1].method, "ft_transfer");
    assert_eq!(c[1].args["receiver_id"], OWNER);
    assert_eq!(c[1].args["amount"], "10");
    assert_eq!((c[1].deposit, c[1].after.clone()), (1, vec![0]));
    assert_eq!((c[2].receiver.as_str(), c[2].method.as_str()), (TREASURY, "on_withdrawn"));
    assert_eq!(c[2].args, json!({ "amount": "10", "receiver": OWNER, "near": false }));
    assert_eq!(c[2].gas_tgas, 5);
    assert!(!c[2].after.is_empty(), "callback waits for the transfer");
}

/// I1: `withdrawal` is emitted only once the transfer succeeded.
#[test]
fn withdrawal_event_only_after_success() {
    let mut t = setup();
    as_callback(NOW, PromiseResult::Successful(vec![]));
    assert!(t.on_withdrawn(U128(10), acc(OWNER), false));
    assert_eq!(event_names(), vec!["withdrawal"]);
    assert_eq!(events()[0]["data"][0], json!({ "amount": "10", "receiver": OWNER, "asset": "token" }));
    as_callback(NOW, PromiseResult::Failed);
    assert!(!t.on_withdrawn(U128(10), acc(OWNER), false));
    assert_eq!(event_names(), vec!["withdrawal_failed"]);
    as_callback(NOW, PromiseResult::Successful(vec![]));
    assert!(t.on_withdrawn(U128(3), acc(OWNER), true));
    assert_eq!(event_names(), vec!["near_withdrawal"]);
}

#[test]
fn gas_budget_is_consistent() {
    let tg = |g: Gas| g.as_tgas();
    // Each callback must pass on the static gas of what it schedules, plus its own work.
    assert!(tg(GAS_ON_REGISTERED) >= tg(GAS_FT_TRANSFER) + tg(GAS_ON_TRANSFERRED) + 5);
    assert!(tg(GAS_ON_CHECKED) >= tg(GAS_STORAGE_DEPOSIT) + tg(GAS_ON_REGISTERED) + 5);
    // propose/approve: 65 TGas static + own work fits in the documented 100 TGas minimum.
    assert_eq!(tg(GAS_GET_VENDOR) + tg(GAS_ON_CHECKED), 65);
    assert!(tg(GAS_GET_VENDOR) + tg(GAS_ON_CHECKED) + 20 <= 100);
}

// ======================================================================= day 5: storage deposit config

#[test]
fn storage_deposit_default_and_custom() {
    let t = setup();
    assert_eq!(t.get_config().storage_deposit.0, DEFAULT_STORAGE_DEPOSIT);
    assert_eq!(DEFAULT_STORAGE_DEPOSIT, 1_250_000_000_000_000_000_000, "0.00125 NEAR");
    as_caller(OWNER, 0, NOW);
    let t2 = new_treasury(1, 1, 0, Some(U128(42)));
    assert_eq!(t2.get_config().storage_deposit.0, 42);
}

#[test]
#[should_panic(expected = "storage_deposit must be in")]
fn storage_deposit_zero_rejected_at_init() {
    as_caller(OWNER, 0, NOW);
    new_treasury(1, 1, 0, Some(U128(0)));
}

// ======================================================================= initial vendor policies

fn ivp(vendor: &str, max: u128, cap: u128) -> InitialVendorPolicy {
    InitialVendorPolicy { vendor: acc(vendor), max_per_invoice: U128(max), monthly_cap: U128(cap) }
}

fn new_with_policies(list: Option<Vec<InitialVendorPolicy>>) -> Treasury {
    as_caller(OWNER, 0, NOW);
    Treasury::new(
        acc(OWNER),
        acc(AGENT),
        acc(REGISTRY),
        acc(TOKEN),
        U128(THRESHOLD),
        U128(TREASURY_CAP),
        MIN_AGE_SEC,
        None,
        list,
        None,
        None,
        None,
    )
}

#[test]
fn init_without_policies_has_none() {
    let t = new_with_policies(None);
    assert_eq!(t.get_vendor_policy(acc(ACME)), None);
    assert!(event_names().is_empty());
    let t = new_with_policies(Some(vec![]));
    assert_eq!(t.get_vendor_policy(acc(ACME)), None);
}

#[test]
fn init_sets_policies_and_emits_events() {
    let t = new_with_policies(Some(vec![ivp(ACME, 500, 800), ivp("globex.testnet", 7, 9)]));
    assert_eq!(t.get_vendor_policy(acc(ACME)), Some(policy(500, 800)));
    assert_eq!(t.get_vendor_policy(acc("globex.testnet")), Some(policy(7, 9)));
    let ev = events();
    assert_eq!(ev.len(), 2);
    assert_eq!(ev[0]["event"], "vendor_policy_set");
    assert_eq!(ev[0]["standard"], EVENT_STANDARD);
    assert_eq!(ev[0]["data"][0]["vendor"], ACME);
    assert_eq!(ev[0]["data"][0]["max_per_invoice"], "500");
    assert_eq!(ev[0]["data"][0]["monthly_cap"], "800");
    assert_eq!(ev[1]["data"][0]["vendor"], "globex.testnet");
}

#[test]
fn init_policies_event_matches_set_vendor_policy() {
    new_with_policies(Some(vec![ivp(ACME, 500, 800)]));
    let from_init = events();
    let mut t = new_with_policies(None);
    as_caller(OWNER, 1, NOW);
    t.set_vendor_policy(acc(ACME), U128(500), U128(800));
    assert_eq!(events(), from_init);
}

#[test]
fn init_policy_lets_agent_propose() {
    let mut t = new_with_policies(Some(vec![ivp(ACME, 500_000_000, 800_000_000)]));
    let id = propose(&mut t, "h1", 10_000_000);
    assert_eq!(t.get_payment(id).unwrap().status, PaymentStatus::Verifying);
}

#[test]
fn init_policy_can_be_changed_by_owner() {
    let mut t = new_with_policies(Some(vec![ivp(ACME, 500, 800)]));
    as_caller(OWNER, 1, NOW);
    t.set_vendor_policy(acc(ACME), U128(1), U128(2));
    assert_eq!(t.get_vendor_policy(acc(ACME)), Some(policy(1, 2)));
    t.remove_vendor_policy(acc(ACME));
    assert_eq!(t.get_vendor_policy(acc(ACME)), None);
}

#[test]
#[should_panic(expected = "limits must be > 0")]
fn init_policy_zero_max_rejected() {
    new_with_policies(Some(vec![ivp(ACME, 0, 800)]));
}

#[test]
#[should_panic(expected = "limits must be > 0")]
fn init_policy_zero_cap_rejected() {
    new_with_policies(Some(vec![ivp(ACME, 500, 0)]));
}

#[test]
#[should_panic(expected = "duplicate initial vendor policy: acme.testnet")]
fn init_policy_duplicate_rejected() {
    new_with_policies(Some(vec![ivp(ACME, 1, 1), ivp("globex.testnet", 1, 1), ivp(ACME, 2, 2)]));
}

#[test]
#[should_panic(expected = "too many initial vendor policies (max 50)")]
fn init_policy_over_max_rejected() {
    let list = (0..=MAX_INITIAL_VENDOR_POLICIES).map(|i| ivp(&format!("v{i}.testnet"), 1, 1)).collect();
    new_with_policies(Some(list));
}

#[test]
fn init_policy_exactly_max_accepted() {
    let list = (0..MAX_INITIAL_VENDOR_POLICIES).map(|i| ivp(&format!("v{i}.testnet"), 1, 1)).collect();
    let t = new_with_policies(Some(list));
    assert_eq!(t.get_vendor_policy(acc("v49.testnet")), Some(policy(1, 1)));
    assert_eq!(event_names().len(), MAX_INITIAL_VENDOR_POLICIES);
}

#[test]
fn initial_vendor_policies_pure_validation() {
    assert_eq!(validate_initial_vendor_policies(&[]), Ok(()));
    assert_eq!(validate_initial_vendor_policies(&[ivp(ACME, 1, 1)]), Ok(()));
    assert!(validate_initial_vendor_policies(&[ivp(ACME, 0, 1)]).is_err());
    assert!(validate_initial_vendor_policies(&[ivp(ACME, 1, 1), ivp(ACME, 1, 1)]).is_err());
    assert_eq!(validate_vendor_limits(1, 1), Ok(()));
    assert_eq!(validate_vendor_limits(0, 1), Err("limits must be > 0".into()));
}

#[test]
fn initial_vendor_policy_json_shape() {
    let v: InitialVendorPolicy = near_sdk::serde_json::from_str(
        r#"{"vendor":"acme.testnet","max_per_invoice":"500","monthly_cap":"800"}"#,
    )
    .unwrap();
    assert_eq!(v, ivp(ACME, 500, 800));
}

#[test]
fn owner_sets_storage_deposit_and_chain_uses_it() {
    let mut t = setup();
    as_caller(OWNER, 1, NOW);
    t.set_storage_deposit(U128(2_000_000_000_000_000_000_000));
    assert_eq!(t.get_config().storage_deposit.0, 2_000_000_000_000_000_000_000);
    assert!(event_names().contains(&"storage_deposit_changed".to_string()));
    pay_once(&mut t);
    let id = propose(&mut t, "inv-2", 50);
    registry_answers(&mut t, id, Some(old_near_vendor()));
    assert_register_chain(&calls(), "acme-payouts.testnet", id, 2_000_000_000_000_000_000_000);
}

#[test]
#[should_panic(expected = "storage_deposit must be in")]
fn storage_deposit_above_max_rejected() {
    let mut t = setup();
    as_caller(OWNER, 1, NOW);
    t.set_storage_deposit(U128(MAX_STORAGE_DEPOSIT + 1));
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn agent_cannot_set_storage_deposit() {
    let mut t = setup();
    as_caller(AGENT, 1, NOW);
    t.set_storage_deposit(U128(1));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn set_storage_deposit_requires_one_yocto() {
    let mut t = setup();
    as_caller(OWNER, 0, NOW);
    t.set_storage_deposit(U128(1));
}

// ======================================================================= day 5: agent flags

fn propose_flagged(t: &mut Treasury, label: &str, amount: u128, flags: Option<Vec<String>>) -> u64 {
    as_caller(AGENT, 0, NOW);
    let _ = t.propose_payment(hx(label), acc(ACME), U128(amount), 1, None, None, None, flags);
    t.get_config().payment_count - 1
}

fn flags(v: &[&str]) -> Option<Vec<String>> {
    Some(v.iter().map(|s| s.to_string()).collect())
}

#[test]
fn agent_flags_force_pending_for_known_small_payment() {
    let mut t = setup();
    pay_once(&mut t);
    let id = propose_flagged(&mut t, "inv-2", 50, flags(&["invoice names a different address"]));
    // C-M2: stored once, already as the hold reason.
    assert_eq!(t.get_payment(id).unwrap().reasons, vec!["agent: invoice names a different address"]);
    assert_eq!(registry_answers(&mut t, id, Some(old_near_vendor())), Some(PaymentStatus::Pending));
    let p = t.get_payment(id).unwrap();
    assert_eq!(p.reasons, vec!["agent: invoice names a different address"]);
    assert!(calls().is_empty(), "nothing executes");
    assert_eq!(t.get_pending().len(), 1);
}

#[test]
fn agent_flags_add_to_contract_reasons() {
    let mut t = setup();
    let id = propose_flagged(&mut t, "inv", 50, flags(&["a", "b"]));
    assert_eq!(registry_answers(&mut t, id, Some(old_near_vendor())), Some(PaymentStatus::Pending));
    assert_eq!(t.get_payment(id).unwrap().reasons, vec![HOLD_FIRST_PAYMENT, "agent: a", "agent: b"]);
}

#[test]
fn empty_agent_flags_do_not_hold() {
    let mut t = setup();
    pay_once(&mut t);
    let id = propose_flagged(&mut t, "inv-2", 50, Some(vec![]));
    assert_eq!(registry_answers(&mut t, id, Some(old_near_vendor())), None, "executes");
}

#[test]
fn agent_flags_do_not_override_registry_reject() {
    let mut t = setup();
    let id = propose_flagged(&mut t, "inv", 50, flags(&["x"]));
    assert_eq!(registry_answers(&mut t, id, None), Some(PaymentStatus::Rejected));
    assert_eq!(t.get_payment(id).unwrap().reasons, vec!["agent: x", REASON_NOT_IN_REGISTRY]);
}

#[test]
fn agent_flags_are_stored_once() {
    let mut t = setup();
    let id = propose_flagged(&mut t, "inv", 50, flags(&["a", "b"]));
    let p = t.get_payment(id).unwrap();
    assert_eq!(p.reasons, vec!["agent: a", "agent: b"]);
    let json = near_sdk::serde_json::to_value(&p).unwrap();
    assert!(json.get("agent_flags").is_none(), "no raw copy");
    // Max flags (8 x 200 chars) stay one copy: payment record borsh well under 2 kB.
    let id = propose_flagged(&mut t, "big", 1, Some(vec!["é".repeat(200); 8]));
    let size = near_sdk::borsh::to_vec(&t.get_payment(id).unwrap()).unwrap().len();
    assert!(size < 8 * (400 + 7 + 4) + 600, "record is {size} bytes");
}

#[test]
fn owner_can_approve_flagged_payment() {
    let mut t = setup();
    pay_once(&mut t);
    let id = propose_flagged(&mut t, "inv-2", 50, flags(&["x"]));
    registry_answers(&mut t, id, Some(old_near_vendor()));
    as_caller(OWNER, 1, NOW);
    let _ = t.approve_payment(id);
    as_callback(NOW, PromiseResult::Successful(vec![]));
    assert_eq!(status_of(t.on_approval_checked(id, Ok(Some(old_near_vendor())))), None);
    let _ = registered_result(&mut t, id, true);
    assert_eq!(transfer_result(&mut t, true), PaymentStatus::Paid);
}

#[test]
#[should_panic(expected = "at most 8 agent_flags")]
fn too_many_agent_flags_rejected() {
    let mut t = setup();
    propose_flagged(&mut t, "inv", 1, Some(vec!["x".to_string(); 9]));
}

#[test]
#[should_panic(expected = "agent_flag longer than 200 chars")]
fn long_agent_flag_rejected() {
    let mut t = setup();
    propose_flagged(&mut t, "inv", 1, Some(vec!["x".repeat(201)]));
}

#[test]
#[should_panic(expected = "agent_flags must not contain empty strings")]
fn blank_agent_flag_rejected() {
    let mut t = setup();
    propose_flagged(&mut t, "inv", 1, flags(&["ok", "  "]));
}

#[test]
fn agent_flag_limits_pure() {
    assert!(validate_agent_flags(&[]).is_ok());
    assert!(validate_agent_flags(&vec!["x".to_string(); 8]).is_ok());
    assert!(validate_agent_flags(&["x".repeat(200)]).is_ok());
    // The limit counts characters: 200 multi-byte chars are fine.
    assert!(validate_agent_flags(&["é".repeat(200)]).is_ok());
    assert!(validate_agent_flags(&["é".repeat(201)]).is_err());
    assert_eq!(agent_hold_reasons(&["a".into()]), vec!["agent: a"]);
}

#[test]
fn decide_with_agent_flags_holds() {
    let token = acc(TOKEN);
    let old = old_near_vendor();
    let f = agent_hold_reasons(&["models disagree".to_string()]);
    let d = decide(&DecideInput { agent_reasons: &f, ..decide_input(Some(&old), &token) });
    assert!(
        matches!(d, Decision::Hold { ref reasons, .. } if reasons == &vec!["agent: models disagree".to_string()])
    );
}

// ======================================================================= C-M2: open payments + NEAR reserve

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const BYTE_COST: u128 = 10_000_000_000_000_000_000; // 1e19 yocto per byte

fn as_caller_with_balance(predecessor: &str, deposit: u128, balance: u128, storage_bytes: u64) {
    testing_env!(ctx_builder(predecessor, deposit, NOW)
        .account_balance(NearToken::from_yoctonear(balance))
        .storage_usage(storage_bytes)
        .build());
}

#[test]
fn open_payments_are_capped() {
    let mut t = setup();
    as_caller(OWNER, 1, NOW);
    t.set_capacity(2, U128(DEFAULT_NEAR_RESERVE));
    assert!(event_names().contains(&"capacity_changed".to_string()));
    let a = propose(&mut t, "a", 1);
    propose(&mut t, "b", 1);
    assert_eq!(t.get_config().open_payments, 2);
    let third = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| propose(&mut t, "c", 1)));
    assert!(third.is_err(), "3rd open payment refused");
    as_caller(OWNER, 0, NOW);
    t.reject_payment(a, "no".into());
    assert_eq!(t.get_config().open_payments, 1);
    propose(&mut t, "c", 1);
    assert_eq!(t.get_config().open_payments, 2);
}

#[test]
#[should_panic(expected = "too many open payments (max 1)")]
fn open_payment_cap_message() {
    let mut t = setup();
    as_caller(OWNER, 1, NOW);
    t.set_capacity(1, U128(0));
    propose(&mut t, "a", 1);
    propose(&mut t, "b", 1);
}

#[test]
fn open_count_follows_the_lifecycle() {
    let mut t = setup();
    pay_once(&mut t);
    assert_eq!(t.get_config().open_payments, 0, "Paid is closed");
    let id = propose(&mut t, "inv-2", 50);
    registry_answers(&mut t, id, Some(old_near_vendor()));
    assert_eq!(t.get_config().open_payments, 1, "Executing is open");
    transfer_result(&mut t, false);
    assert_eq!(t.get_config().open_payments, 0, "Failed is closed");
    let id = propose(&mut t, "inv-3", THRESHOLD + 1);
    registry_answers(&mut t, id, Some(old_near_vendor()));
    assert_eq!(t.get_config().open_payments, 1, "Pending is open");
    as_caller(OWNER, 1, NOW);
    let _ = t.approve_payment(id);
    assert_eq!(t.get_config().open_payments, 1, "Verifying again: still one");
}

#[test]
#[should_panic(expected = "max_open_payments must be in 1..=100")]
fn set_capacity_rejects_zero() {
    let mut t = setup();
    as_caller(OWNER, 1, NOW);
    t.set_capacity(0, U128(0));
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn agent_cannot_set_capacity() {
    let mut t = setup();
    as_caller(AGENT, 1, NOW);
    t.set_capacity(100, U128(0));
}

#[test]
#[should_panic(expected = "treasury needs a NEAR top-up")]
fn propose_refuses_when_near_would_drop_below_reserve() {
    let mut t = setup();
    // Free NEAR = exactly the reserve before the payment record is written.
    let storage = 100_000;
    as_caller_with_balance(AGENT, 0, u128::from(storage) * BYTE_COST + DEFAULT_NEAR_RESERVE, storage);
    let _ = t.propose_payment(hx("a"), acc(ACME), U128(1), 1, None, None, None, None);
}

#[test]
fn propose_ok_with_enough_near() {
    let mut t = setup();
    let storage = 100_000;
    as_caller_with_balance(AGENT, 0, u128::from(storage) * BYTE_COST + DEFAULT_NEAR_RESERVE + NEAR / 10, storage);
    let _ = t.propose_payment(hx("a"), acc(ACME), U128(1), 1, None, None, None, None);
    assert_eq!(t.get_config().payment_count, 1);
}

#[test]
fn withdraw_near_keeps_the_reserve() {
    let mut t = setup();
    let storage = 100_000;
    as_caller_with_balance(OWNER, 1, u128::from(storage) * BYTE_COST + 2 * NEAR, storage);
    let free = t.get_config().available_near.0; // 2 NEAR (+ the attached yocto in the mock)
    assert!(free >= 2 * NEAR && free <= 2 * NEAR + 1, "{free}");
    let _ = t.withdraw_near(U128(free - DEFAULT_NEAR_RESERVE));
    let calls = near_sdk::test_utils::get_created_receipts();
    assert_eq!(calls[0].receiver_id, acc(OWNER));
    assert!(matches!(
        calls[0].actions[0],
        near_sdk::mock::MockAction::Transfer { deposit, .. } if deposit.as_yoctonear() == free - DEFAULT_NEAR_RESERVE
    ));
    assert!(event_names().is_empty(), "near_withdrawal comes from the callback");
}

#[test]
#[should_panic(expected = "withdrawal would go below the NEAR reserve")]
fn withdraw_near_refuses_to_cut_into_the_reserve() {
    let mut t = setup();
    let storage = 100_000;
    as_caller_with_balance(OWNER, 1, u128::from(storage) * BYTE_COST + 2 * NEAR, storage);
    let free = t.get_config().available_near.0;
    let _ = t.withdraw_near(U128(free - DEFAULT_NEAR_RESERVE + 1));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn withdraw_near_requires_one_yocto() {
    let mut t = setup();
    as_caller(OWNER, 0, NOW);
    let _ = t.withdraw_near(U128(1));
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn agent_cannot_withdraw_near() {
    let mut t = setup();
    as_caller(AGENT, 1, NOW);
    let _ = t.withdraw_near(U128(1));
}

// ======================================================================= L1: stuck Executing

fn executing_payment(t: &mut Treasury) -> u64 {
    pay_once(t);
    let id = propose(t, "inv-2", 50);
    registry_answers(t, id, Some(old_near_vendor()));
    assert_eq!(t.get_payment(id).unwrap().status, PaymentStatus::Executing);
    id
}

#[test]
fn owner_resolves_stuck_payment_as_paid() {
    let mut t = setup();
    let id = executing_payment(&mut t);
    let spent = t.monthly_spent(None).0;
    as_caller(OWNER, 1, NOW);
    assert_eq!(t.resolve_executing(id, true), PaymentStatus::Paid);
    let p = t.get_payment(id).unwrap();
    assert_eq!(p.status, PaymentStatus::Paid);
    assert_eq!(p.reasons, vec![REASON_OWNER_PAID]);
    assert_eq!(event_names(), vec!["payment_resolved", "payment_paid"]);
    assert_eq!(events()[0]["data"][0], json!({ "id": id, "paid": true }));
    assert_eq!(t.monthly_spent(None).0, spent, "paid stays committed");
    assert_eq!(t.get_config().open_payments, 0);
    // A late callback is a no-op.
    assert_eq!(transfer_result(&mut t, false), PaymentStatus::Paid);
}

#[test]
fn owner_resolves_stuck_payment_as_not_paid() {
    let mut t = setup();
    let id = executing_payment(&mut t);
    let spent = t.monthly_spent(None).0;
    as_caller(OWNER, 1, NOW);
    assert_eq!(t.resolve_executing(id, false), PaymentStatus::Failed);
    let p = t.get_payment(id).unwrap();
    assert_eq!(p.reasons, vec![REASON_OWNER_UNPAID]);
    assert_eq!(t.monthly_spent(None).0, spent - 50, "cap released");
    assert_eq!(event_names(), vec!["payment_resolved", "payment_failed"]);
    as_callback(NOW, PromiseResult::Successful(vec![]));
    assert_eq!(status_of(t.on_payment_registered(id)), Some(PaymentStatus::Failed), "late callback no-op");
    assert!(calls().is_empty());
}

#[test]
#[should_panic(expected = "payment is not executing")]
fn resolve_only_executing() {
    let mut t = setup();
    let id = propose(&mut t, "a", 1);
    as_caller(OWNER, 1, NOW);
    t.resolve_executing(id, true);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn resolve_requires_one_yocto() {
    let mut t = setup();
    let id = executing_payment(&mut t);
    as_caller(OWNER, 0, NOW);
    t.resolve_executing(id, false);
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn agent_cannot_resolve() {
    let mut t = setup();
    let id = executing_payment(&mut t);
    as_caller(AGENT, 1, NOW);
    t.resolve_executing(id, true);
}

// ======================================================================= L2: no id aliasing

#[test]
fn ids_above_u32_do_not_alias() {
    let mut t = setup();
    propose(&mut t, "a", 1);
    let alias = 1u64 << 32; // `as u32` would turn this into 0
    assert!(t.get_payment(0).is_some());
    assert_eq!(t.get_payment(alias), None);
    assert!(t.get_payments(Some(alias), None).is_empty());
    as_caller(OWNER, 0, NOW);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.reject_payment(alias, "x".into())));
    assert!(r.is_err());
    assert_eq!(t.get_payment(0).unwrap().status, PaymentStatus::Verifying, "payment 0 untouched");
}

#[test]
#[should_panic(expected = "payment not found")]
fn callback_with_aliased_id_panics_cleanly() {
    let mut t = setup();
    propose(&mut t, "a", 1);
    as_callback(NOW, PromiseResult::Successful(vec![]));
    t.on_payment_transferred(1u64 << 32);
}

// ======================================================================= L3 / A-M4: invoice hashes

#[test]
fn invoice_hash_is_lowercased_on_propose() {
    let mut t = setup();
    as_caller(AGENT, 0, NOW);
    let _ = t.propose_payment(hx("inv").to_uppercase(), acc(ACME), U128(1), 1, None, None, None, None);
    assert_eq!(t.get_payment(0).unwrap().invoice_hash, hx("inv"));
    assert!(t.is_invoice_used(hx("inv")));
    assert!(t.is_invoice_used(hx("inv").to_uppercase()));
    assert!(!t.is_invoice_used("not-a-hash".into()));
}

#[test]
#[should_panic(expected = "invoice already used")]
fn uppercase_copy_of_used_hash_is_a_duplicate() {
    let mut t = setup();
    propose(&mut t, "inv", 1);
    as_caller(AGENT, 0, NOW);
    let _ = t.propose_payment(hx("inv").to_uppercase(), acc(ACME), U128(1), 1, None, None, None, None);
}

#[test]
#[should_panic(expected = "invoice_hash must be 64 hex chars")]
fn non_hex_invoice_hash_rejected() {
    let mut t = setup();
    as_caller(AGENT, 0, NOW);
    let _ = t.propose_payment("inv-1".into(), acc(ACME), U128(1), 1, None, None, None, None);
}

#[test]
fn owner_releases_hash_of_rejected_payment() {
    let mut t = setup();
    let id = propose(&mut t, "inv", 1); // e.g. a forged copy
    as_caller(OWNER, 0, NOW);
    t.reject_payment(id, "forged".into());
    as_caller(OWNER, 1, NOW);
    t.release_invoice_hash(id);
    assert_eq!(event_names(), vec!["invoice_hash_released"]);
    assert_eq!(events()[0]["data"][0], json!({ "id": id, "invoice_hash": hx("inv") }));
    assert!(!t.is_invoice_used(hx("inv")));
    let again = propose(&mut t, "inv", 1); // the genuine invoice
    assert_eq!(t.get_payment(again).unwrap().status, PaymentStatus::Verifying);
}

#[test]
fn owner_releases_hash_of_failed_payment() {
    let mut t = setup();
    let id = executing_payment(&mut t);
    transfer_result(&mut t, false);
    as_caller(OWNER, 1, NOW);
    t.release_invoice_hash(id);
    assert!(!t.is_invoice_used(hx("inv-2")));
}

#[test]
#[should_panic(expected = "only Rejected or Failed payments can release their invoice hash")]
fn cannot_release_hash_of_open_payment() {
    let mut t = setup();
    let id = propose(&mut t, "inv", 1);
    as_caller(OWNER, 1, NOW);
    t.release_invoice_hash(id);
}

#[test]
#[should_panic(expected = "only Rejected or Failed payments can release their invoice hash")]
fn cannot_release_hash_of_paid_payment() {
    let mut t = setup();
    pay_once(&mut t);
    as_caller(OWNER, 1, NOW);
    t.release_invoice_hash(0);
}

/// An old rejected payment must not free a hash that a later (paid) payment now holds.
#[test]
#[should_panic(expected = "invoice hash is not held by this payment")]
fn stale_release_cannot_free_a_reused_hash() {
    let mut t = setup();
    let old = propose(&mut t, "inv", 1);
    as_caller(OWNER, 0, NOW);
    t.reject_payment(old, "forged".into());
    as_caller(OWNER, 1, NOW);
    t.release_invoice_hash(old);
    propose(&mut t, "inv", 1); // genuine one now holds the hash
    as_caller(OWNER, 1, NOW);
    t.release_invoice_hash(old);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn release_hash_requires_one_yocto() {
    let mut t = setup();
    let id = propose(&mut t, "inv", 1);
    as_caller(OWNER, 0, NOW);
    t.reject_payment(id, "x".into());
    t.release_invoice_hash(id);
}

// ======================================================================= L5: pause / policy re-checks

#[test]
fn pause_while_verifying_rejects_in_callback() {
    let mut t = setup();
    let id = propose(&mut t, "inv", 50);
    as_caller(OWNER, 0, NOW);
    t.pause();
    assert_eq!(registry_answers(&mut t, id, Some(old_near_vendor())), Some(PaymentStatus::Rejected));
    assert_eq!(t.get_payment(id).unwrap().reasons, vec![REASON_PAUSED]);
    assert_eq!(t.monthly_spent(None).0, 0);
    assert!(calls().is_empty());
}

#[test]
fn policy_removed_while_verifying_rejects_in_callback() {
    let mut t = setup();
    pay_once(&mut t);
    let id = propose(&mut t, "inv-2", 50);
    as_caller(OWNER, 1, NOW);
    t.remove_vendor_policy(acc(ACME));
    assert_eq!(registry_answers(&mut t, id, Some(old_near_vendor())), Some(PaymentStatus::Rejected));
    assert_eq!(t.get_payment(id).unwrap().reasons, vec![REASON_NO_POLICY]);
    assert!(calls().is_empty(), "nothing executes");
}

#[test]
#[should_panic(expected = "treasury is paused")]
fn approve_while_paused_panics() {
    let mut t = setup();
    let id = propose(&mut t, "inv", 50);
    registry_answers(&mut t, id, Some(old_near_vendor()));
    as_caller(OWNER, 0, NOW);
    t.pause();
    as_caller(OWNER, 1, NOW);
    let _ = t.approve_payment(id);
}

#[test]
fn approve_after_policy_removed_rejects() {
    let mut t = setup();
    let id = propose(&mut t, "inv", 50);
    registry_answers(&mut t, id, Some(old_near_vendor()));
    as_caller(OWNER, 1, NOW);
    t.remove_vendor_policy(acc(ACME));
    assert_eq!(status_of(t.approve_payment(id)), Some(PaymentStatus::Rejected));
    let p = t.get_payment(id).unwrap();
    assert_eq!(p.reasons.last().unwrap(), REASON_NO_POLICY);
    assert!(!p.approved_by_owner);
    assert!(calls().is_empty(), "no registry call");
    assert_eq!(t.monthly_spent(None).0, 0);
}

fn change_after_approval_rejects_in_callback(remove_policy: bool) {
    let mut t = setup();
    let id = propose(&mut t, "inv", 50);
    registry_answers(&mut t, id, Some(old_near_vendor()));
    as_caller(OWNER, 1, NOW);
    let _ = t.approve_payment(id);
    if remove_policy {
        t.remove_vendor_policy(acc(ACME));
    } else {
        t.pause();
    }
    as_callback(NOW, PromiseResult::Successful(vec![]));
    assert_eq!(status_of(t.on_approval_checked(id, Ok(Some(old_near_vendor())))), Some(PaymentStatus::Rejected));
    let want = if remove_policy { REASON_NO_POLICY } else { REASON_PAUSED };
    assert_eq!(t.get_payment(id).unwrap().reasons.last().unwrap(), want);
    assert!(calls().is_empty());
}

#[test]
fn pause_after_approval_rejects_in_callback() {
    change_after_approval_rejects_in_callback(false);
}

#[test]
fn policy_removal_after_approval_rejects_in_callback() {
    change_after_approval_rejects_in_callback(true);
}
