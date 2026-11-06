//! Pure decision logic for the treasury. No `env::` calls here, so everything is unit-testable
//! without a NEAR runtime. The contract in `lib.rs` only gathers inputs and applies results.

use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

pub const NS_PER_SEC: u64 = 1_000_000_000;
/// Monthly accounting uses fixed 30-day buckets: `bucket = block_timestamp / BUCKET_NS`.
pub const BUCKET_NS: u64 = 30 * 24 * 60 * 60 * NS_PER_SEC;

pub const MAX_INVOICE_HASH_LEN: usize = 128;
pub const MAX_DEPOSIT_ADDRESS_LEN: usize = 128;
pub const MAX_QUOTE_HASH_LEN: usize = 128;
pub const MAX_MEMO_LEN: usize = 256;
pub const MAX_REASON_LEN: usize = 256;
pub const MAX_AGENT_FLAGS: usize = 8;
/// Characters (not bytes) per agent flag.
pub const MAX_AGENT_FLAG_LEN: usize = 200;
pub const AGENT_FLAG_PREFIX: &str = "agent: ";

pub const REASON_NOT_IN_REGISTRY: &str = "not in registry";
pub const REASON_VERSION_CHANGED: &str = "payout changed since agent checked";
pub const REASON_REGISTRY_FAILED: &str = "registry call failed";
pub const REASON_NO_DEPOSIT_ADDRESS: &str = "deposit_address required for non-NEAR-direct payout";
pub const REASON_BAD_DEPOSIT_ADDRESS: &str = "deposit_address is not a valid NEAR account id";
pub const REASON_BAD_PAYOUT_ADDRESS: &str = "registry payout address is not a valid NEAR account id";
pub const HOLD_OVER_THRESHOLD: &str = "amount above auto-pay threshold";
pub const HOLD_FRESH_PAYOUT: &str = "payout changed recently";
pub const HOLD_FIRST_PAYMENT: &str = "first payment to this vendor";
pub const REASON_STORAGE_DEPOSIT_FAILED: &str = "storage_deposit failed";
pub const REASON_FT_TRANSFER_FAILED: &str = "ft_transfer failed";

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

pub fn bucket_of(ts_ns: u64) -> u64 {
    ts_ns / BUCKET_NS
}

/// Everything `propose_payment` checks synchronously (before asking the registry).
#[derive(Clone, Debug)]
pub struct ProposalCheck<'a> {
    pub paused: bool,
    pub invoice_used: bool,
    pub policy: Option<&'a VendorPolicy>,
    pub amount: u128,
    /// Committed (Verifying + Pending + Executing + Paid) to this vendor in the current bucket.
    pub vendor_spent: u128,
    /// Committed across all vendors in the current bucket.
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

/// Bound all agent-supplied strings (the treasury pays for their storage).
pub fn validate_inputs(
    invoice_hash: &str,
    deposit_address: Option<&str>,
    quote_hash: Option<&str>,
    memo: Option<&str>,
) -> Result<(), String> {
    if invoice_hash.trim().is_empty() {
        return Err("invoice_hash must not be empty".into());
    }
    check_len("invoice_hash", Some(invoice_hash), MAX_INVOICE_HASH_LEN)?;
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

/// Hold reasons for the agent's flags: `"agent: <flag>"` each.
pub fn agent_hold_reasons(flags: &[String]) -> Vec<String> {
    flags.iter().map(|f| format!("{AGENT_FLAG_PREFIX}{f}")).collect()
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
/// - Anything else: pay the agent-supplied 1Click deposit address (required). It is only verified
///   off-chain by the agent; caps bound the damage.
pub fn select_destination(
    payout: &Payout,
    token: &AccountId,
    deposit_address: Option<&str>,
) -> Result<(AccountId, bool), String> {
    if payout.chain == "near" && payout.asset_id == format!("nep141:{token}") {
        let to = payout.address.parse::<AccountId>().map_err(|_| REASON_BAD_PAYOUT_ADDRESS)?;
        return Ok((to, true));
    }
    let deposit = deposit_address.ok_or(REASON_NO_DEPOSIT_ADDRESS)?;
    let to = deposit.parse::<AccountId>().map_err(|_| REASON_BAD_DEPOSIT_ADDRESS)?;
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
    pub amount: u128,
    pub auto_pay_threshold: u128,
    pub min_payout_age_sec: u64,
    pub now_ns: u64,
    pub first_payment: bool,
    /// Agent hold reasons; non-empty forces Hold (never Execute).
    pub agent_flags: &'a [String],
}

pub fn decide(i: &DecideInput) -> Decision {
    let entry = match check_registry(i.registry, i.expected_version) {
        Ok(e) => e,
        Err(e) => return Decision::Reject(e),
    };
    let (destination, direct) =
        match select_destination(&entry.payout, i.token, i.deposit_address) {
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
    reasons.extend(agent_hold_reasons(i.agent_flags));
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
