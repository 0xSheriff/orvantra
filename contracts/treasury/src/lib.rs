//! Orvantra treasury: one per business. Holds a single NEP-141 token (USDC) and lets the AI agent
//! pay invoices only within the owner's policy. See `README.md` for the full rules.
//!
//! Roles:
//! - `owner`: the human. Sets policy, approves/rejects held payments, withdraws, pauses.
//! - `agent`: a separate account whose function-call key can only call `propose_payment`.
//!
//! Payment lifecycle:
//! ```text
//! propose_payment ─► Verifying ──registry──► Rejected
//!                                      ├──► Pending ──approve──► Verifying ──registry──► Executing / Rejected
//!                                      │       └──reject──► Rejected
//!                                      └──► Executing ──ft_transfer──► Paid / Failed
//! ```
//! Verifying, Pending, Executing and Paid count against monthly caps; Rejected/Failed release.
//! All decision logic lives in `policy.rs` (pure, unit-tested).

pub mod policy;

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, IterableSet, LookupMap, LookupSet, Vector};
use near_sdk::{
    assert_one_yocto, env, ext_contract, is_promise_success, near, require, AccountId,
    BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

pub use policy::{Payout, RegistryVendor, VendorPolicy};
use policy::{Decision, DecideInput, ProposalCheck};

pub const EVENT_STANDARD: &str = "orvantra_treasury";
pub const EVENT_VERSION: &str = "1.0.0";
pub const MAX_PAGE_LIMIT: u64 = 100;

// Gas budget (static, explicit, ~2x margin over typical costs; verify on testnet receipts):
// - registry.get_vendor is a single map read (~2-3 TGas).
// - NEP-141 ft_transfer is ~3-5 TGas.
// - on_payment_transferred updates one record + two counters (~3 TGas).
// - on_*_checked runs the policy decision (~5 TGas) and may schedule ft_transfer + its callback,
//   which it must pass on: GAS_FT_TRANSFER + GAS_ON_TRANSFERRED = 20 TGas. Budget 45 TGas.
// propose_payment / approve_payment attach 5 + 45 = 50 TGas statically plus their own ~5-10 TGas,
// so callers should attach >= 100 TGas. Unused gas is shared out by the runtime.
pub const GAS_GET_VENDOR: Gas = Gas::from_tgas(5);
pub const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
pub const GAS_ON_TRANSFERRED: Gas = Gas::from_tgas(10);
pub const GAS_ON_CHECKED: Gas = Gas::from_tgas(45);
pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[ext_contract(ext_registry)]
#[allow(dead_code)]
trait Registry {
    fn get_vendor(&self, account_id: AccountId) -> Option<RegistryVendor>;
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaymentStatus {
    /// Waiting for the registry answer (after propose, or after owner approval).
    Verifying,
    /// Held for the owner.
    Pending,
    /// ft_transfer in flight.
    Executing,
    Paid,
    Rejected,
    Failed,
}

impl PaymentStatus {
    /// Counts against monthly caps.
    pub fn is_committed(self) -> bool {
        matches!(self, Self::Verifying | Self::Pending | Self::Executing | Self::Paid)
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Payment {
    pub id: u64,
    pub invoice_hash: String,
    pub vendor: AccountId,
    pub amount: U128,
    /// Registry version the agent checked.
    pub payout_version: u32,
    /// Registry payout at decision time (None until the registry answered).
    pub payout: Option<Payout>,
    /// Receiver of the treasury's ft_transfer.
    pub destination: Option<AccountId>,
    /// true = paid straight to the vendor's NEAR account; false = via 1Click deposit address.
    pub direct: bool,
    pub deposit_address: Option<String>,
    pub quote_hash: Option<String>,
    pub memo: Option<String>,
    pub status: PaymentStatus,
    pub reasons: Vec<String>,
    pub approved_by_owner: bool,
    /// 30-day bucket the amount is committed to.
    pub bucket: u64,
    pub created_at: U64,
    pub updated_at: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigView {
    pub owner: AccountId,
    pub agent: AccountId,
    pub registry: AccountId,
    pub token: AccountId,
    pub auto_pay_threshold: U128,
    pub monthly_cap: U128,
    pub min_payout_age_sec: u64,
    pub paused: bool,
    pub payment_count: u64,
}

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Policies,
    Payments,
    UsedInvoices,
    Pending,
    PaidVendors,
    VendorSpent,
    TotalSpent,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Treasury {
    owner: AccountId,
    agent: AccountId,
    registry: AccountId,
    token: AccountId,
    auto_pay_threshold: u128,
    monthly_cap: u128,
    min_payout_age_sec: u64,
    paused: bool,
    policies: IterableMap<AccountId, VendorPolicy>,
    payments: Vector<Payment>,
    /// Every invoice hash ever proposed (including rejected ones). Never removed.
    used_invoices: LookupSet<String>,
    pending: IterableSet<u64>,
    /// Vendors that have received at least one Paid payment.
    paid_vendors: LookupSet<AccountId>,
    vendor_spent: LookupMap<(AccountId, u64), u128>,
    total_spent: LookupMap<u64, u128>,
}

#[near]
impl Treasury {
    #[init]
    pub fn new(
        owner: AccountId,
        agent: AccountId,
        registry: AccountId,
        token: AccountId,
        auto_pay_threshold: U128,
        monthly_cap: U128,
        min_payout_age_sec: u64,
    ) -> Self {
        require!(owner != agent, "agent must be a different account from owner");
        Self {
            owner,
            agent,
            registry,
            token,
            auto_pay_threshold: auto_pay_threshold.0,
            monthly_cap: monthly_cap.0,
            min_payout_age_sec,
            paused: false,
            policies: IterableMap::new(StorageKey::Policies),
            payments: Vector::new(StorageKey::Payments),
            used_invoices: LookupSet::new(StorageKey::UsedInvoices),
            pending: IterableSet::new(StorageKey::Pending),
            paid_vendors: LookupSet::new(StorageKey::PaidVendors),
            vendor_spent: LookupMap::new(StorageKey::VendorSpent),
            total_spent: LookupMap::new(StorageKey::TotalSpent),
        }
    }

    // ---------------------------------------------------------------- agent

    /// Agent only. Panics on any synchronous policy violation (nothing is stored then). Otherwise
    /// records the payment as Verifying, commits the amount to this month's caps, burns the
    /// invoice hash, and asks the registry before deciding. Attach >= 100 TGas.
    pub fn propose_payment(
        &mut self,
        invoice_hash: String,
        vendor: AccountId,
        amount: U128,
        payout_version: u32,
        deposit_address: Option<String>,
        quote_hash: Option<String>,
        memo: Option<String>,
    ) -> Promise {
        require!(env::predecessor_account_id() == self.agent, "only the agent can propose payments");
        policy::validate_inputs(
            &invoice_hash,
            deposit_address.as_deref(),
            quote_hash.as_deref(),
            memo.as_deref(),
        )
        .unwrap_or_else(|e| env::panic_str(&e));

        let now = env::block_timestamp();
        let bucket = policy::bucket_of(now);
        let check = ProposalCheck {
            paused: self.paused,
            invoice_used: self.used_invoices.contains(&invoice_hash),
            policy: self.policies.get(&vendor),
            amount: amount.0,
            vendor_spent: self.vendor_spent_in(&vendor, bucket),
            total_spent: self.total_spent_in(bucket),
            treasury_monthly_cap: self.monthly_cap,
        };
        policy::check_proposal(&check).unwrap_or_else(|e| env::panic_str(&e));

        let id = self.payments.len() as u64;
        let payment = Payment {
            id,
            invoice_hash: invoice_hash.clone(),
            vendor: vendor.clone(),
            amount,
            payout_version,
            payout: None,
            destination: None,
            direct: false,
            deposit_address,
            quote_hash,
            memo,
            status: PaymentStatus::Verifying,
            reasons: vec![],
            approved_by_owner: false,
            bucket,
            created_at: now.into(),
            updated_at: now.into(),
        };
        self.used_invoices.insert(invoice_hash);
        self.commit(&vendor, bucket, amount.0);
        self.payments.push(payment.clone());
        emit("payment_proposed", payment_json(&payment));

        ext_registry::ext(self.registry.clone())
            .with_static_gas(GAS_GET_VENDOR)
            .get_vendor(vendor)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_CHECKED)
                    .on_proposal_checked(id),
            )
    }

    /// Registry answered for a new proposal. Never panics (state must persist).
    #[private]
    pub fn on_proposal_checked(
        &mut self,
        id: u64,
        #[callback_result] registry: Result<Option<RegistryVendor>, PromiseError>,
    ) -> PromiseOrValue<PaymentStatus> {
        let p = self.payment(id);
        if p.status != PaymentStatus::Verifying {
            return PromiseOrValue::Value(p.status); // e.g. owner rejected it meanwhile
        }
        let entry = match registry {
            Ok(e) => e,
            Err(_) => return PromiseOrValue::Value(self.reject(id, policy::REASON_REGISTRY_FAILED)),
        };
        let decision = policy::decide(&DecideInput {
            registry: entry.as_ref(),
            expected_version: p.payout_version,
            token: &self.token,
            deposit_address: p.deposit_address.as_deref(),
            amount: p.amount.0,
            auto_pay_threshold: self.auto_pay_threshold,
            min_payout_age_sec: self.min_payout_age_sec,
            now_ns: env::block_timestamp(),
            first_payment: !self.paid_vendors.contains(&p.vendor),
        });
        match decision {
            Decision::Reject(reason) => PromiseOrValue::Value(self.reject(id, &reason)),
            Decision::Hold { payout, destination, direct, reasons } => {
                let p = self.payment_mut(id);
                p.payout = Some(payout);
                p.destination = Some(destination);
                p.direct = direct;
                p.reasons = reasons;
                self.set_status(id, PaymentStatus::Pending);
                emit("payment_pending", payment_json(&self.payment(id)));
                PromiseOrValue::Value(PaymentStatus::Pending)
            }
            Decision::Execute { payout, destination, direct } => {
                let p = self.payment_mut(id);
                p.payout = Some(payout);
                p.destination = Some(destination);
                p.direct = direct;
                PromiseOrValue::Promise(self.execute(id))
            }
        }
    }

    // ---------------------------------------------------------------- owner

    /// Owner approves a Pending payment. The registry is checked again (the payout may have
    /// changed while the payment waited); the payment executes only if it is unchanged.
    /// Requires 1 yoctoNEAR (full-access key). Attach >= 100 TGas.
    #[payable]
    pub fn approve_payment(&mut self, id: u64) -> Promise {
        self.assert_owner_full_access();
        let p = self.payment(id);
        require!(p.status == PaymentStatus::Pending, "payment is not pending");
        self.payment_mut(id).approved_by_owner = true;
        self.set_status(id, PaymentStatus::Verifying);
        emit("payment_approved", payment_json(&self.payment(id)));

        ext_registry::ext(self.registry.clone())
            .with_static_gas(GAS_GET_VENDOR)
            .get_vendor(p.vendor)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_CHECKED)
                    .on_approval_checked(id),
            )
    }

    /// Registry answered for an approved payment. Never panics.
    #[private]
    pub fn on_approval_checked(
        &mut self,
        id: u64,
        #[callback_result] registry: Result<Option<RegistryVendor>, PromiseError>,
    ) -> PromiseOrValue<PaymentStatus> {
        let p = self.payment(id);
        if p.status != PaymentStatus::Verifying {
            return PromiseOrValue::Value(p.status);
        }
        let entry = match registry {
            Ok(e) => e,
            Err(_) => return PromiseOrValue::Value(self.reject(id, policy::REASON_REGISTRY_FAILED)),
        };
        match policy::check_registry(entry.as_ref(), p.payout_version) {
            Err(reason) => PromiseOrValue::Value(self.reject(id, &reason)),
            Ok(e) if Some(&e.payout) != p.payout.as_ref() => {
                PromiseOrValue::Value(self.reject(id, policy::REASON_VERSION_CHANGED))
            }
            Ok(_) => PromiseOrValue::Promise(self.execute(id)),
        }
    }

    /// Owner rejects a Pending (or stuck Verifying) payment and releases its cap.
    /// No deposit needed: rejecting can only make the treasury safer.
    pub fn reject_payment(&mut self, id: u64, reason: String) {
        self.assert_owner();
        let p = self.payment(id);
        require!(
            matches!(p.status, PaymentStatus::Pending | PaymentStatus::Verifying),
            "payment is not pending"
        );
        let reason: String = reason.chars().take(policy::MAX_REASON_LEN).collect();
        self.reject(id, &format!("owner: {reason}"));
    }

    #[payable]
    pub fn set_vendor_policy(&mut self, vendor: AccountId, max_per_invoice: U128, monthly_cap: U128) {
        self.assert_owner_full_access();
        require!(max_per_invoice.0 > 0 && monthly_cap.0 > 0, "limits must be > 0");
        let policy = VendorPolicy { max_per_invoice, monthly_cap };
        emit(
            "vendor_policy_set",
            json!({ "vendor": vendor, "max_per_invoice": max_per_invoice, "monthly_cap": monthly_cap }),
        );
        self.policies.insert(vendor, policy);
    }

    #[payable]
    pub fn remove_vendor_policy(&mut self, vendor: AccountId) {
        self.assert_owner_full_access();
        require!(self.policies.remove(&vendor).is_some(), "vendor has no policy");
        emit("vendor_policy_removed", json!({ "vendor": vendor }));
    }

    #[payable]
    pub fn set_agent(&mut self, agent: AccountId) {
        self.assert_owner_full_access();
        require!(agent != self.owner, "agent must be a different account from owner");
        emit("agent_changed", json!({ "old_agent": self.agent, "new_agent": agent }));
        self.agent = agent;
    }

    #[payable]
    pub fn set_limits(&mut self, auto_pay_threshold: U128, monthly_cap: U128, min_payout_age_sec: u64) {
        self.assert_owner_full_access();
        self.auto_pay_threshold = auto_pay_threshold.0;
        self.monthly_cap = monthly_cap.0;
        self.min_payout_age_sec = min_payout_age_sec;
        emit(
            "limits_changed",
            json!({
                "auto_pay_threshold": auto_pay_threshold,
                "monthly_cap": monthly_cap,
                "min_payout_age_sec": min_payout_age_sec,
            }),
        );
    }

    /// Owner moves tokens out of the treasury. Requires 1 yoctoNEAR (full-access key).
    #[payable]
    pub fn withdraw(&mut self, amount: U128, receiver: AccountId) -> Promise {
        self.assert_owner_full_access();
        require!(amount.0 > 0, "amount must be > 0");
        emit("withdrawal", json!({ "amount": amount, "receiver": receiver }));
        ext_ft::ext(self.token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(receiver, amount, Some("orvantra treasury withdrawal".into()))
    }

    /// Stop the agent from proposing. No deposit needed (safe direction).
    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
        emit("paused", json!({}));
    }

    #[payable]
    pub fn unpause(&mut self) {
        self.assert_owner_full_access();
        self.paused = false;
        emit("unpaused", json!({}));
    }

    // ---------------------------------------------------------------- token

    /// NEP-141 receiver. Keep our token, refund any other token in full.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let _ = msg;
        let token_contract = env::predecessor_account_id();
        let refund = policy::ft_refund_amount(&token_contract, &self.token, amount.0);
        if refund == 0 {
            env::log_str(&format!("received {} from {sender_id}", amount.0));
        } else {
            env::log_str(&format!("refunding unsupported token {token_contract}"));
        }
        PromiseOrValue::Value(U128(refund))
    }

    /// Result of the treasury's ft_transfer for payment `id`. Never panics.
    #[private]
    pub fn on_payment_transferred(&mut self, id: u64) -> PaymentStatus {
        let p = self.payment(id);
        if p.status != PaymentStatus::Executing {
            return p.status;
        }
        if is_promise_success() {
            self.set_status(id, PaymentStatus::Paid);
            self.paid_vendors.insert(p.vendor.clone());
            emit("payment_paid", payment_json(&self.payment(id)));
            PaymentStatus::Paid
        } else {
            self.release(&p.vendor, p.bucket, p.amount.0);
            self.payment_mut(id).reasons.push("ft_transfer failed".into());
            self.set_status(id, PaymentStatus::Failed);
            emit("payment_failed", payment_json(&self.payment(id)));
            PaymentStatus::Failed
        }
    }

    // ---------------------------------------------------------------- views

    pub fn get_payment(&self, id: u64) -> Option<Payment> {
        self.payments.get(id as u32).cloned()
    }

    pub fn get_payments(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Payment> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(MAX_PAGE_LIMIT).min(MAX_PAGE_LIMIT);
        let end = (self.payments.len() as u64).min(from.saturating_add(limit));
        (from..end).filter_map(|i| self.payments.get(i as u32).cloned()).collect()
    }

    /// Payments waiting for the owner (at most `MAX_PAGE_LIMIT`).
    pub fn get_pending(&self) -> Vec<Payment> {
        self.pending
            .iter()
            .take(MAX_PAGE_LIMIT as usize)
            .filter_map(|id| self.payments.get(*id as u32).cloned())
            .collect()
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            agent: self.agent.clone(),
            registry: self.registry.clone(),
            token: self.token.clone(),
            auto_pay_threshold: self.auto_pay_threshold.into(),
            monthly_cap: self.monthly_cap.into(),
            min_payout_age_sec: self.min_payout_age_sec,
            paused: self.paused,
            payment_count: self.payments.len() as u64,
        }
    }

    pub fn get_vendor_policy(&self, vendor: AccountId) -> Option<VendorPolicy> {
        self.policies.get(&vendor).cloned()
    }

    /// Committed amount in the current 30-day bucket, for one vendor or for the whole treasury.
    pub fn monthly_spent(&self, vendor: Option<AccountId>) -> U128 {
        let bucket = policy::bucket_of(env::block_timestamp());
        match vendor {
            Some(v) => self.vendor_spent_in(&v, bucket),
            None => self.total_spent_in(bucket),
        }
        .into()
    }

    pub fn is_invoice_used(&self, hash: String) -> bool {
        self.used_invoices.contains(&hash)
    }
}

// -------------------------------------------------------------------- internals
impl Treasury {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner can do this");
    }

    /// Owner + exactly 1 yoctoNEAR attached, which function-call access keys cannot do.
    fn assert_owner_full_access(&self) {
        self.assert_owner();
        assert_one_yocto();
    }

    fn payment(&self, id: u64) -> Payment {
        self.payments
            .get(id as u32)
            .cloned()
            .unwrap_or_else(|| env::panic_str("payment not found"))
    }

    fn payment_mut(&mut self, id: u64) -> &mut Payment {
        self.payments
            .get_mut(id as u32)
            .unwrap_or_else(|| env::panic_str("payment not found"))
    }

    fn set_status(&mut self, id: u64, status: PaymentStatus) {
        let p = self.payment_mut(id);
        p.status = status;
        p.updated_at = env::block_timestamp().into();
        if status == PaymentStatus::Pending {
            self.pending.insert(id);
        } else {
            self.pending.remove(&id);
        }
    }

    fn reject(&mut self, id: u64, reason: &str) -> PaymentStatus {
        let p = self.payment(id);
        if p.status.is_committed() {
            self.release(&p.vendor, p.bucket, p.amount.0);
        }
        self.payment_mut(id).reasons.push(reason.to_string());
        self.set_status(id, PaymentStatus::Rejected);
        emit("payment_rejected", payment_json(&self.payment(id)));
        PaymentStatus::Rejected
    }

    /// ft_transfer(destination, amount, memo) with 1 yoctoNEAR, then `on_payment_transferred`.
    fn execute(&mut self, id: u64) -> Promise {
        self.set_status(id, PaymentStatus::Executing);
        let p = self.payment(id);
        let destination = p.destination.clone().unwrap_or_else(|| env::panic_str("no destination"));
        ext_ft::ext(self.token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(destination, p.amount, p.memo.clone())
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_TRANSFERRED)
                    .on_payment_transferred(id),
            )
    }

    fn vendor_spent_in(&self, vendor: &AccountId, bucket: u64) -> u128 {
        self.vendor_spent.get(&(vendor.clone(), bucket)).copied().unwrap_or(0)
    }

    fn total_spent_in(&self, bucket: u64) -> u128 {
        self.total_spent.get(&bucket).copied().unwrap_or(0)
    }

    fn commit(&mut self, vendor: &AccountId, bucket: u64, amount: u128) {
        let v = self.vendor_spent_in(vendor, bucket) + amount;
        let t = self.total_spent_in(bucket) + amount;
        self.vendor_spent.insert((vendor.clone(), bucket), v);
        self.total_spent.insert(bucket, t);
    }

    fn release(&mut self, vendor: &AccountId, bucket: u64, amount: u128) {
        let v = self.vendor_spent_in(vendor, bucket).saturating_sub(amount);
        let t = self.total_spent_in(bucket).saturating_sub(amount);
        self.vendor_spent.insert((vendor.clone(), bucket), v);
        self.total_spent.insert(bucket, t);
    }
}

fn payment_json(p: &Payment) -> serde_json::Value {
    json!({
        "id": p.id,
        "invoice_hash": p.invoice_hash,
        "vendor": p.vendor,
        "amount": p.amount,
        "status": p.status,
        "destination": p.destination,
        "direct": p.direct,
        "quote_hash": p.quote_hash,
        "reasons": p.reasons,
    })
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

#[cfg(test)]
mod tests;
