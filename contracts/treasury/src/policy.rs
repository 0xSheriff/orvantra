//! Pure decision logic for the treasury. No `env::` calls here, so everything is unit-testable
//! without a NEAR runtime. The contract in `lib.rs` only gathers inputs and applies results.

use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

pub const NS_PER_SEC: u64 = 1_000_000_000;
/// Spend is recorded per day: `day = block_timestamp / DAY_NS`.
pub const DAY_NS: u64 = 24 * 60 * 60 * NS_PER_SEC;
/// Monthly caps cover a rolling window of this many days, today included. An amount committed on
/// day `d` stops counting on day `d + WINDOW_DAYS` (29 to 30 days later, depending on the hour).
pub const WINDOW_DAYS: u64 = 30;
/// A held cross-chain payment pays a 1Click deposit address whose quote expires off-chain. Until
/// the agent passes the quote's real `valid_until`, the treasury assumes this lifetime (v5).
pub const QUOTE_DEADLINE_DEFAULT_NS: u64 = 24 * 60 * 60 * NS_PER_SEC;
/// `resolve_executing` is refused this long after the payment entered Executing, so the owner
/// cannot settle a transfer that is still in flight.
pub const RESOLVE_MIN_AGE_NS: u64 = 60 * NS_PER_SEC;

/// `invoice_hash` is a sha256 hex digest: exactly 64 hex chars, stored lowercase.
pub const INVOICE_HASH_LEN: usize = 64;
pub const MAX_DEPOSIT_ADDRESS_LEN: usize = 128;
pub const MAX_QUOTE_HASH_LEN: usize = 128;
pub const MAX_MEMO_LEN: usize = 256;
pub const MAX_REASON_LEN: usize = 256;
pub const MAX_AGENT_FLAGS: usize = 8;
/// Characters (not bytes) per agent flag.
pub const MAX_AGENT_FLAG_LEN: usize = 200;
pub const AGENT_FLAG_PREFIX: &str = "agent: ";
/// Upper bound for `max_open_payments` (also the page size of `get_pending`).
pub const MAX_OPEN_PAYMENTS_LIMIT: u32 = 100;

pub const REASON_NOT_IN_REGISTRY: &str = "not in registry";
pub const REASON_VERSION_CHANGED: &str = "payout changed since agent checked";
pub const REASON_REGISTRY_FAILED: &str = "registry call failed";
pub const REASON_NO_DEPOSIT_ADDRESS: &str = "deposit_address required for non-NEAR-direct payout";
pub const REASON_BAD_DEPOSIT_ADDRESS: &str =
    "deposit_address must be a 64-char lowercase hex implicit account (1Click deposit address)";
pub const REASON_FORBIDDEN_DEPOSIT_ADDRESS: &str =
    "deposit_address must not be the treasury, token, agent or owner";
pub const REASON_BAD_PAYOUT_ADDRESS: &str = "registry payout address is not a valid NEAR account id";
pub const REASON_PAUSED: &str = "treasury paused before the payment was decided";
pub const REASON_NO_POLICY: &str = "vendor no longer approved (policy removed)";
pub const HOLD_OVER_THRESHOLD: &str = "amount above auto-pay threshold";
pub const HOLD_FRESH_PAYOUT: &str = "payout changed recently";
pub const HOLD_FIRST_PAYMENT: &str = "first payment to this vendor";
pub const HOLD_CROSS_CHAIN: &str = "cross-chain payout: owner confirms the 1Click deposit address";
pub const REASON_STORAGE_DEPOSIT_FAILED: &str = "storage_deposit failed";
pub const REASON_FT_TRANSFER_FAILED: &str = "ft_transfer failed";
pub const REASON_OWNER_UNPAID: &str = "owner: resolved as not paid";
pub const REASON_OWNER_PAID: &str = "owner: confirmed paid";
pub const REASON_STALE: &str = "stale: proposed before the 30-day cap window; propose it again";
pub const REASON_QUOTE_EXPIRED: &str = "1Click quote expired before approval; propose it again";

/// Payout details, same shape as the vendor registry's `Payout`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Payout {
    pub chain: String,
    pub asset_id: String,
    pub address: String,
}

/// JSON shape returned by `vendor-registry.get_vendor`. Mirrored here (not imported) so the
/// registry's contract methods are not linked into the treasury wasm.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegistryVendor {
    pub account_id: AccountId,
    pub display_name: String,
    pub payout: Payout,
    pub created_at_ns: U64,
    pub updated_at_ns: U64,
    pub version: u32,
}

/// Per-vendor limits set by the owner. A vendor without a policy is not approved.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VendorPolicy {
    pub max_per_invoice: U128,
    pub monthly_cap: U128,
}

/// Maximum number of vendor policies that can be set in `new`.
pub const MAX_INITIAL_VENDOR_POLICIES: usize = 50;

/// One vendor policy set by the deployer at init (so the owner's wallet signs no setup transaction).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InitialVendorPolicy {
    pub vendor: AccountId,
    pub max_per_invoice: U128,
    pub monthly_cap: U128,
}

/// Same limit rule as `set_vendor_policy` (both > 0).
pub fn validate_vendor_limits(max_per_invoice: u128, monthly_cap: u128) -> Result<(), String> {
    if max_per_invoice == 0 || monthly_cap == 0 {
        return Err("limits must be > 0".into());
    }
    Ok(())
}

/// At most `MAX_INITIAL_VENDOR_POLICIES` entries, limits > 0, no vendor twice.
pub fn validate_initial_vendor_policies(list: &[InitialVendorPolicy]) -> Result<(), String> {
    if list.len() > MAX_INITIAL_VENDOR_POLICIES {
        return Err(format!(
            "too many initial vendor policies (max {MAX_INITIAL_VENDOR_POLICIES})"
        ));
    }
    for (i, p) in list.iter().enumerate() {
        validate_vendor_limits(p.max_per_invoice.0, p.monthly_cap.0)?;
        if list[..i].iter().any(|q| q.vendor == p.vendor) {
            return Err(format!("duplicate initial vendor policy: {}", p.vendor));
        }
    }
    Ok(())
}

pub fn day_of(ts_ns: u64) -> u64 {
    ts_ns / DAY_NS
}

/// Days counted for the monthly caps on `today`: the last `WINDOW_DAYS` days, today included.
pub fn window_days(today: u64) -> std::ops::RangeInclusive<u64> {
    today.saturating_sub(WINDOW_DAYS - 1)..=today
}

/// A payment committed on `payment_day` has dropped out of the caps' window on `today`, so
/// approving it now would spend outside the cap. Mirrors `window_days`.
pub fn is_stale(payment_day: u64, today: u64) -> bool {
    today.saturating_sub(payment_day) >= WINDOW_DAYS
}

/// Deadline for executing a held payment: 0 (none) for a direct NEAR payout, otherwise the 1Click
/// deposit address is assumed valid for `QUOTE_DEADLINE_DEFAULT_NS` after the proposal.
pub fn quote_deadline(direct: bool, created_at_ns: u64) -> u64 {
    if direct {
        0
    } else {
        created_at_ns.saturating_add(QUOTE_DEADLINE_DEFAULT_NS)
    }
}

/// Lowercase and check an invoice hash (64 hex chars, i.e. a sha256 digest).
pub fn normalize_invoice_hash(hash: &str) -> Result<String, String> {
    if hash.len() != INVOICE_HASH_LEN || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("invoice_hash must be {INVOICE_HASH_LEN} hex chars (sha256)"));
    }
    Ok(hash.to_ascii_lowercase())
}

/// A NEAR implicit account id: exactly 64 lowercase hex chars (what 1Click deposit addresses are).
pub fn is_implicit_account(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Everything `propose_payment` checks synchronously (before asking the registry).
#[derive(Clone, Debug)]
pub struct ProposalCheck<'a> {
    pub paused: bool,
    pub invoice_used: bool,
    /// Payments currently Verifying, Pending or Executing, and the configured maximum.
    pub open_payments: u32,
    pub max_open_payments: u32,
    pub policy: Option<&'a VendorPolicy>,
    pub amount: u128,
    /// Committed (Verifying + Pending + Executing + Paid) to this vendor in the rolling window.
    pub vendor_spent: u128,
    /// Committed across all vendors in the rolling window.
    pub total_spent: u128,
    pub treasury_monthly_cap: u128,
}

/// Returns the first violated rule. Order matters only for which message is shown.
pub fn check_proposal(c: &ProposalCheck) -> Result<(), String> {
    if c.paused {
        return Err("treasury is paused".into());
    }
    if c.invoice_used {
        return Err("invoice already used".into());
    }
    if c.open_payments >= c.max_open_payments {
        return Err(format!(
            "too many open payments (max {}): the owner must approve or reject some first",
            c.max_open_payments
        ));
    }
    let policy = c.policy.ok_or("vendor not approved (no policy)")?;
    if c.amount == 0 {
        return Err("amount must be > 0".into());
    }
    if c.amount > policy.max_per_invoice.0 {
        return Err("amount above vendor max_per_invoice".into());
    }
    match c.vendor_spent.checked_add(c.amount) {
        Some(v) if v <= policy.monthly_cap.0 => {}
        _ => return Err("over vendor monthly cap".into()),
    }
    match c.total_spent.checked_add(c.amount) {
        Some(t) if t <= c.treasury_monthly_cap => {}
        _ => return Err("over treasury monthly cap".into()),
    }
    Ok(())
}

fn check_len(name: &str, value: Option<&str>, max: usize) -> Result<(), String> {
    match value {
        Some(v) if v.len() > max => Err(format!("{name} longer than {max} bytes")),
        _ => Ok(()),
    }
}

/// Bound the agent-supplied strings (the treasury pays for their storage). `invoice_hash` is
/// checked by `normalize_invoice_hash`, the deposit address format by `select_destination`.
pub fn validate_inputs(
    deposit_address: Option<&str>,
    quote_hash: Option<&str>,
    memo: Option<&str>,
) -> Result<(), String> {
    check_len("deposit_address", deposit_address, MAX_DEPOSIT_ADDRESS_LEN)?;
    check_len("quote_hash", quote_hash, MAX_QUOTE_HASH_LEN)?;
    check_len("memo", memo, MAX_MEMO_LEN)
}

/// Agent flags: at most `MAX_AGENT_FLAGS`, each non-blank and at most `MAX_AGENT_FLAG_LEN` chars.
pub fn validate_agent_flags(flags: &[String]) -> Result<(), String> {
    if flags.len() > MAX_AGENT_FLAGS {
        return Err(format!("at most {MAX_AGENT_FLAGS} agent_flags"));
    }
    for f in flags {
        if f.trim().is_empty() {
            return Err("agent_flags must not contain empty strings".into());
        }
        if f.chars().count() > MAX_AGENT_FLAG_LEN {
            return Err(format!("agent_flag longer than {MAX_AGENT_FLAG_LEN} chars"));
        }
    }
    Ok(())
}

/// Hold reasons for the agent's flags: `"agent: <flag>"` each. Stored once, in `Payment.reasons`.
pub fn agent_hold_reasons(flags: &[String]) -> Vec<String> {
    flags.iter().map(|f| format!("{AGENT_FLAG_PREFIX}{f}")).collect()
}

/// The agent reasons among a payment's stored reasons.
pub fn agent_reasons_of(reasons: &[String]) -> Vec<String> {
    reasons.iter().filter(|r| r.starts_with(AGENT_FLAG_PREFIX)).cloned().collect()
}

pub fn validate_max_open_payments(max: u32) -> Result<(), String> {
    if max == 0 || max > MAX_OPEN_PAYMENTS_LIMIT {
        return Err(format!("max_open_payments must be in 1..={MAX_OPEN_PAYMENTS_LIMIT}"));
    }
    Ok(())
}

/// NEAR the treasury can spend: balance minus locked minus what its storage needs.
pub fn available_near(balance: u128, locked: u128, storage_bytes: u64, byte_cost: u128) -> u128 {
    balance
        .saturating_sub(locked)
        .saturating_sub(u128::from(storage_bytes).saturating_mul(byte_cost))
}

/// Storage deposit must be > 0 (zero always fails registration) and <= `max`.
pub fn validate_storage_deposit(amount: u128, max: u128) -> Result<(), String> {
    if amount == 0 || amount > max {
        return Err(format!("storage_deposit must be in 1..={max} yoctoNEAR"));
    }
    Ok(())
}

/// Registry entry must exist and still have the version the agent looked at.
pub fn check_registry(
    entry: Option<&RegistryVendor>,
    expected_version: u32,
) -> Result<&RegistryVendor, String> {
    let entry = entry.ok_or(REASON_NOT_IN_REGISTRY)?;
    if entry.version != expected_version {
        return Err(REASON_VERSION_CHANGED.into());
    }
    Ok(entry)
}

/// Where the treasury's `ft_transfer` goes, and whether that is the vendor itself (`direct`).
///
/// - Vendor wants our token on NEAR (`chain == "near"`, `asset_id == "nep141:<token>"`): pay the
///   registry address directly. Fully verified on-chain; any `deposit_address` is ignored.
/// - Anything else: pay the agent-supplied 1Click deposit address (required). It must be a 64-hex
///   implicit account and not one of `forbidden` (treasury, token, agent, owner). That it belongs to
///   a quote paying the vendor is only verified off-chain, so these payouts are held for the owner
///   above `cross_chain_auto_pay_threshold` (see `decide`).
pub fn select_destination(
    payout: &Payout,
    token: &AccountId,
    deposit_address: Option<&str>,
    forbidden: &[&AccountId],
) -> Result<(AccountId, bool), String> {
    if payout.chain == "near" && payout.asset_id == format!("nep141:{token}") {
        let to = payout.address.parse::<AccountId>().map_err(|_| REASON_BAD_PAYOUT_ADDRESS)?;
        return Ok((to, true));
    }
    let deposit = deposit_address.ok_or(REASON_NO_DEPOSIT_ADDRESS)?;
    if !is_implicit_account(deposit) {
        return Err(REASON_BAD_DEPOSIT_ADDRESS.into());
    }
    let to = deposit.parse::<AccountId>().map_err(|_| REASON_BAD_DEPOSIT_ADDRESS)?;
    if forbidden.contains(&&to) {
        return Err(REASON_FORBIDDEN_DEPOSIT_ADDRESS.into());
    }
    Ok((to, false))
}

/// Reasons a payment must wait for the owner. Empty = may execute now.
pub fn needs_human_reasons(
    amount: u128,
    auto_pay_threshold: u128,
    payout_updated_at_ns: u64,
    now_ns: u64,
    min_payout_age_sec: u64,
    first_payment: bool,
) -> Vec<String> {
    let mut reasons = Vec::new();
    if amount > auto_pay_threshold {
        reasons.push(HOLD_OVER_THRESHOLD.to_string());
    }
    let age_ns = now_ns.saturating_sub(payout_updated_at_ns);
    if age_ns < min_payout_age_sec.saturating_mul(NS_PER_SEC) {
        reasons.push(HOLD_FRESH_PAYOUT.to_string());
    }
    if first_payment {
        reasons.push(HOLD_FIRST_PAYMENT.to_string());
    }
    reasons
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    Reject(String),
    Hold { payout: Payout, destination: AccountId, direct: bool, reasons: Vec<String> },
    Execute { payout: Payout, destination: AccountId, direct: bool },
}

/// Inputs for the decision made after the registry answers.
#[derive(Clone, Debug)]
pub struct DecideInput<'a> {
    pub registry: Option<&'a RegistryVendor>,
    pub expected_version: u32,
    pub token: &'a AccountId,
    pub deposit_address: Option<&'a str>,
    /// Accounts a deposit address may never be (treasury, token, agent, owner).
    pub forbidden_destinations: &'a [&'a AccountId],
    pub amount: u128,
    pub auto_pay_threshold: u128,
    /// Cross-chain (non-direct) payouts above this always wait for the owner.
    pub cross_chain_auto_pay_threshold: u128,
    pub min_payout_age_sec: u64,
    pub now_ns: u64,
    pub first_payment: bool,
    /// Agent hold reasons, already `"agent: ..."`; non-empty forces Hold (never Execute).
    pub agent_reasons: &'a [String],
}

pub fn decide(i: &DecideInput) -> Decision {
    let entry = match check_registry(i.registry, i.expected_version) {
        Ok(e) => e,
        Err(e) => return Decision::Reject(e),
    };
    let (destination, direct) = match select_destination(
        &entry.payout,
        i.token,
        i.deposit_address,
        i.forbidden_destinations,
    ) {
        Ok(d) => d,
        Err(e) => return Decision::Reject(e),
    };
    let mut reasons = needs_human_reasons(
        i.amount,
        i.auto_pay_threshold,
        entry.updated_at_ns.0,
        i.now_ns,
        i.min_payout_age_sec,
        i.first_payment,
    );
    if !direct && i.amount > i.cross_chain_auto_pay_threshold {
        reasons.push(HOLD_CROSS_CHAIN.to_string());
    }
    reasons.extend(i.agent_reasons.iter().cloned());
    let payout = entry.payout.clone();
    if reasons.is_empty() {
        Decision::Execute { payout, destination, direct }
    } else {
        Decision::Hold { payout, destination, direct, reasons }
    }
}

/// `ft_on_transfer` return value: amount to refund. Keep everything from our token, refund all
/// of any other token.
pub fn ft_refund_amount(token_contract: &AccountId, configured: &AccountId, amount: u128) -> u128 {
    if token_contract == configured {
        0
    } else {
        amount
    }
}
