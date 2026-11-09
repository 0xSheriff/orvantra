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
//!                                      └──► Executing ──storage_deposit──► ft_transfer──► Paid / Failed
//!                                              └──owner resolve_executing (stuck)──► Paid / Failed
//! ```
//! Every payout first registers the destination on the token (`storage_deposit` with
//! `registration_only: true`, paid from the treasury's NEAR balance; excess is refunded by the token),
//! because a fresh 1Click deposit address is not registered on USDC and a bare ft_transfer would fail.
//! Verifying, Pending, Executing and Paid count against the rolling 30-day caps; Rejected/Failed
//! release. All decision logic lives in `policy.rs` (pure, unit-tested).

pub mod policy;

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, IterableSet, LookupMap, LookupSet, Vector};
use near_sdk::{
    assert_one_yocto, env, ext_contract, is_promise_success, near, require, AccountId,
    BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

pub use policy::{InitialVendorPolicy, Payout, RegistryVendor, VendorPolicy};
use policy::{Decision, DecideInput, ProposalCheck};

pub const EVENT_STANDARD: &str = "orvantra_treasury";
pub const EVENT_VERSION: &str = "1.0.0";
pub const MAX_PAGE_LIMIT: u64 = 100;

// Gas budget (static, explicit, ~2x margin over typical costs; verify on testnet receipts):
// - registry.get_vendor is a single map read (~2-3 TGas).
// - NEP-145 storage_deposit (registration_only) is one map write + maybe a refund transfer (~3-5 TGas).
// - NEP-141 ft_transfer is ~3-5 TGas.
// - on_payment_transferred updates one record + two counters (~3 TGas).
// - on_payment_registered (~3 TGas own) schedules ft_transfer + on_payment_transferred, which it
//   must pass on: 10 + 10 = 20 TGas. Budget 30 TGas.
// - on_*_checked runs the policy decision (~5 TGas) and may schedule storage_deposit +
//   on_payment_registered, which it must pass on: 10 + 30 = 40 TGas. Budget 60 TGas.
// propose_payment / approve_payment attach 5 + 60 = 65 TGas statically plus their own ~5-15 TGas
// (propose reads 2 x 30 daily spend counters), so callers must attach >= 100 TGas (150
// recommended). Unused gas is shared out by the runtime.
pub const GAS_GET_VENDOR: Gas = Gas::from_tgas(5);
pub const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
pub const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
pub const GAS_ON_TRANSFERRED: Gas = Gas::from_tgas(10);
pub const GAS_ON_REGISTERED: Gas = Gas::from_tgas(30);
pub const GAS_ON_CHECKED: Gas = Gas::from_tgas(60);
pub const GAS_ON_WITHDRAWN: Gas = Gas::from_tgas(5);
pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// Default NEAR attached to `storage_deposit` before each payout: 0.00125 NEAR, the NEP-141
/// minimum on USDC (125 bytes x 1e19 yocto/byte). Excess (or all of it, if the receiver is already
/// registered) is refunded to the treasury by the token.
pub const DEFAULT_STORAGE_DEPOSIT: u128 = 1_250_000_000_000_000_000_000;
/// Upper bound for the owner-settable storage deposit (guards against a typo draining NEAR).
pub const MAX_STORAGE_DEPOSIT: u128 = 100_000_000_000_000_000_000_000; // 0.1 NEAR
/// Default cap on payments that are Verifying, Pending or Executing at the same time.
pub const DEFAULT_MAX_OPEN_PAYMENTS: u32 = 25;
/// Default NEAR the treasury keeps free (for payout registrations and callbacks): 0.5 NEAR.
pub const DEFAULT_NEAR_RESERVE: u128 = 500_000_000_000_000_000_000_000;

#[ext_contract(ext_registry)]
#[allow(dead_code)]
trait Registry {
    fn get_vendor(&self, account_id: AccountId) -> Option<RegistryVendor>;
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
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

    /// Not finished yet; counts against `max_open_payments`.
    pub fn is_open(self) -> bool {
        matches!(self, Self::Verifying | Self::Pending | Self::Executing)
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Payment {
    pub id: u64,
    /// Lowercase sha256 hex.
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
    /// Hold/reject reasons. The agent's flags are stored here once, as "agent: <flag>".
    pub reasons: Vec<String>,
    pub approved_by_owner: bool,
    /// Day (`block_timestamp / 1 day`) the amount is committed to.
    pub day: u64,
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
    pub cross_chain_auto_pay_threshold: U128,
    pub monthly_cap: U128,
    pub min_payout_age_sec: u64,
    /// yoctoNEAR attached to `storage_deposit` before each payout.
    pub storage_deposit: U128,
    pub paused: bool,
    pub payment_count: u64,
    pub open_payments: u32,
    pub max_open_payments: u32,
    /// yoctoNEAR that must stay free; proposals and `withdraw_near` refuse to go below it.
    pub near_reserve: U128,
    /// yoctoNEAR free right now (balance - locked - storage).
    pub available_near: U128,
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
    cross_chain_auto_pay_threshold: u128,
    monthly_cap: u128,
    min_payout_age_sec: u64,
    storage_deposit: u128,
    paused: bool,
    max_open_payments: u32,
    open_payments: u32,
    near_reserve: u128,
    policies: IterableMap<AccountId, VendorPolicy>,
    payments: Vector<Payment>,
    /// invoice hash -> id of the payment that holds it. Kept for every proposal (also rejected
    /// ones) unless the owner releases a Rejected/Failed payment's hash.
    used_invoices: LookupMap<String, u64>,
    pending: IterableSet<u64>,
    /// Vendors that have received at least one Paid payment.
    paid_vendors: LookupSet<AccountId>,
    /// Committed amount per (vendor, day) and per day.
    vendor_spent: LookupMap<(AccountId, u64), u128>,
    total_spent: LookupMap<u64, u128>,
}

#[near]
impl Treasury {
    /// `initial_vendor_policies` (optional, <= 50, no duplicates, limits > 0) lets the deployer
    /// approve vendors at init so the owner's wallet does not have to sign setup transactions.
    /// Each emits `vendor_policy_set`, exactly like `set_vendor_policy`.
    /// Optional safety settings: `cross_chain_auto_pay_threshold` (default 0 = every cross-chain
    /// payout waits for the owner), `max_open_payments` (default 25), `near_reserve` (default 0.5 NEAR).
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        owner: AccountId,
        agent: AccountId,
        registry: AccountId,
        token: AccountId,
        auto_pay_threshold: U128,
        monthly_cap: U128,
        min_payout_age_sec: u64,
        storage_deposit: Option<U128>,
        initial_vendor_policies: Option<Vec<InitialVendorPolicy>>,
        cross_chain_auto_pay_threshold: Option<U128>,
        max_open_payments: Option<u32>,
        near_reserve: Option<U128>,
    ) -> Self {
        require!(owner != agent, "agent must be a different account from owner");
        let storage_deposit = storage_deposit.map(|d| d.0).unwrap_or(DEFAULT_STORAGE_DEPOSIT);
        policy::validate_storage_deposit(storage_deposit, MAX_STORAGE_DEPOSIT)
            .unwrap_or_else(|e| env::panic_str(&e));
        let max_open_payments = max_open_payments.unwrap_or(DEFAULT_MAX_OPEN_PAYMENTS);
        policy::validate_max_open_payments(max_open_payments).unwrap_or_else(|e| env::panic_str(&e));
        let initial_vendor_policies = initial_vendor_policies.unwrap_or_default();
        policy::validate_initial_vendor_policies(&initial_vendor_policies)
            .unwrap_or_else(|e| env::panic_str(&e));
        let mut t = Self {
            owner,
            agent,
            registry,
            token,
            auto_pay_threshold: auto_pay_threshold.0,
            cross_chain_auto_pay_threshold: cross_chain_auto_pay_threshold.map(|v| v.0).unwrap_or(0),
            monthly_cap: monthly_cap.0,
            min_payout_age_sec,
            storage_deposit,
            paused: false,
            max_open_payments,
            open_payments: 0,
            near_reserve: near_reserve.map(|v| v.0).unwrap_or(DEFAULT_NEAR_RESERVE),
            policies: IterableMap::new(StorageKey::Policies),
            payments: Vector::new(StorageKey::Payments),
            used_invoices: LookupMap::new(StorageKey::UsedInvoices),
            pending: IterableSet::new(StorageKey::Pending),
            paid_vendors: LookupSet::new(StorageKey::PaidVendors),
            vendor_spent: LookupMap::new(StorageKey::VendorSpent),
            total_spent: LookupMap::new(StorageKey::TotalSpent),
        };
        for p in initial_vendor_policies {
            t.insert_vendor_policy(p.vendor, p.max_per_invoice, p.monthly_cap);
        }
        t
    }

    // ---------------------------------------------------------------- agent

    /// Agent only. Panics on any synchronous policy violation (nothing is stored then). Otherwise
    /// records the payment as Verifying, commits the amount to the rolling 30-day caps, burns the
    /// invoice hash, and asks the registry before deciding. Attach >= 100 TGas (150 recommended).
    ///
    /// `invoice_hash`: 64 hex chars (sha256), stored lowercase.
    /// `agent_flags`: the agent's own hold reasons (<= 8, each 1..=200 chars). Non-empty means the
    /// payment never auto-executes: it goes Pending with reasons "agent: <flag>" and only the owner
    /// can approve it. The agent never approves.
    #[allow(clippy::too_many_arguments)]
    pub fn propose_payment(
        &mut self,
        invoice_hash: String,
        vendor: AccountId,
        amount: U128,
        payout_version: u32,
        deposit_address: Option<String>,
        quote_hash: Option<String>,
        memo: Option<String>,
        agent_flags: Option<Vec<String>>,
    ) -> Promise {
        require!(env::predecessor_account_id() == self.agent, "only the agent can propose payments");
        let invoice_hash =
            policy::normalize_invoice_hash(&invoice_hash).unwrap_or_else(|e| env::panic_str(&e));
        policy::validate_inputs(deposit_address.as_deref(), quote_hash.as_deref(), memo.as_deref())
            .unwrap_or_else(|e| env::panic_str(&e));
        let agent_flags = agent_flags.unwrap_or_default();
        policy::validate_agent_flags(&agent_flags).unwrap_or_else(|e| env::panic_str(&e));

        let now = env::block_timestamp();
        let day = policy::day_of(now);
        let check = ProposalCheck {
            paused: self.paused,
            invoice_used: self.used_invoices.contains_key(&invoice_hash),
            open_payments: self.open_payments,
            max_open_payments: self.max_open_payments,
            policy: self.policies.get(&vendor),
            amount: amount.0,
            vendor_spent: self.vendor_spent_in_window(&vendor, day),
            total_spent: self.total_spent_in_window(day),
            treasury_monthly_cap: self.monthly_cap,
        };
        policy::check_proposal(&check).unwrap_or_else(|e| env::panic_str(&e));

        let id = u64::from(self.payments.len());
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
            reasons: policy::agent_hold_reasons(&agent_flags),
            approved_by_owner: false,
            day,
            created_at: now.into(),
            updated_at: now.into(),
        };
        self.used_invoices.insert(invoice_hash, id);
        self.commit(&vendor, day, amount.0);
        self.payments.push(payment.clone());
        self.open_payments += 1;
        emit("payment_proposed", payment_json(&payment));

        // The record is stored now; make sure paying it out (and its callbacks) stays funded.
        self.flush();
        require!(self.available_near() >= self.near_reserve, "treasury needs a NEAR top-up");

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
        if let Some(reason) = self.still_payable(&p.vendor) {
            return PromiseOrValue::Value(self.reject(id, reason));
        }
        let entry = match registry {
            Ok(e) => e,
            Err(_) => return PromiseOrValue::Value(self.reject(id, policy::REASON_REGISTRY_FAILED)),
        };
        let agent_reasons = policy::agent_reasons_of(&p.reasons);
        let treasury = env::current_account_id();
        let forbidden = [&treasury, &self.token, &self.agent, &self.owner];
        let decision = policy::decide(&DecideInput {
            registry: entry.as_ref(),
            expected_version: p.payout_version,
            token: &self.token,
            deposit_address: p.deposit_address.as_deref(),
            forbidden_destinations: &forbidden,
            amount: p.amount.0,
            auto_pay_threshold: self.auto_pay_threshold,
            cross_chain_auto_pay_threshold: self.cross_chain_auto_pay_threshold,
            min_payout_age_sec: self.min_payout_age_sec,
            now_ns: env::block_timestamp(),
            first_payment: !self.paid_vendors.contains(&p.vendor),
            agent_reasons: &agent_reasons,
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
    /// Panics while paused. If the vendor's policy was removed meanwhile, the payment is Rejected.
    /// Requires 1 yoctoNEAR (full-access key). Attach >= 100 TGas.
    #[payable]
    pub fn approve_payment(&mut self, id: u64) -> PromiseOrValue<PaymentStatus> {
        self.assert_owner_full_access();
        require!(!self.paused, "treasury is paused");
        let p = self.payment(id);
        require!(p.status == PaymentStatus::Pending, "payment is not pending");
        if !self.policies.contains_key(&p.vendor) {
            return PromiseOrValue::Value(self.reject(id, policy::REASON_NO_POLICY));
        }
        self.payment_mut(id).approved_by_owner = true;
        self.set_status(id, PaymentStatus::Verifying);
        emit("payment_approved", payment_json(&self.payment(id)));

        PromiseOrValue::Promise(
            ext_registry::ext(self.registry.clone())
                .with_static_gas(GAS_GET_VENDOR)
                .get_vendor(p.vendor)
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_ON_CHECKED)
                        .on_approval_checked(id),
                ),
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
        if let Some(reason) = self.still_payable(&p.vendor) {
            return PromiseOrValue::Value(self.reject(id, reason));
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

    /// Owner settles a payment stuck in Executing (e.g. a callback ran out of gas). Check the
    /// token transfer on the explorer first: `paid = true` marks it Paid (vendor becomes known),
    /// `paid = false` marks it Failed and releases its cap. Emits `payment_resolved`.
    /// Requires 1 yoctoNEAR (full-access key).
    #[payable]
    pub fn resolve_executing(&mut self, id: u64, paid: bool) -> PaymentStatus {
        self.assert_owner_full_access();
        let p = self.payment(id);
        require!(p.status == PaymentStatus::Executing, "payment is not executing");
        emit("payment_resolved", json!({ "id": p.id, "paid": paid }));
        if paid {
            self.payment_mut(id).reasons.push(policy::REASON_OWNER_PAID.into());
            self.mark_paid(id)
        } else {
            self.fail(id, policy::REASON_OWNER_UNPAID)
        }
    }

    /// Owner frees the invoice hash of a Rejected or Failed payment, so the genuine invoice can be
    /// proposed again (e.g. after a forged copy burned it). Requires 1 yoctoNEAR (full-access key).
    #[payable]
    pub fn release_invoice_hash(&mut self, id: u64) {
        self.assert_owner_full_access();
        let p = self.payment(id);
        require!(
            matches!(p.status, PaymentStatus::Rejected | PaymentStatus::Failed),
            "only Rejected or Failed payments can release their invoice hash"
        );
        require!(
            self.used_invoices.get(&p.invoice_hash) == Some(&p.id),
            "invoice hash is not held by this payment"
        );
        self.used_invoices.remove(&p.invoice_hash);
        emit("invoice_hash_released", json!({ "id": p.id, "invoice_hash": p.invoice_hash }));
    }

    #[payable]
    pub fn set_vendor_policy(&mut self, vendor: AccountId, max_per_invoice: U128, monthly_cap: U128) {
        self.assert_owner_full_access();
        policy::validate_vendor_limits(max_per_invoice.0, monthly_cap.0)
            .unwrap_or_else(|e| env::panic_str(&e));
        self.insert_vendor_policy(vendor, max_per_invoice, monthly_cap);
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

    /// Cross-chain payouts above this amount always wait for the owner (default 0 = all of them).
    /// Requires 1 yoctoNEAR (full-access key).
    #[payable]
    pub fn set_cross_chain_auto_pay_threshold(&mut self, amount: U128) {
        self.assert_owner_full_access();
        self.cross_chain_auto_pay_threshold = amount.0;
        emit("cross_chain_threshold_changed", json!({ "cross_chain_auto_pay_threshold": amount }));
    }

    /// Max open (Verifying + Pending + Executing) payments (1..=100) and the NEAR kept free.
    /// Requires 1 yoctoNEAR (full-access key).
    #[payable]
    pub fn set_capacity(&mut self, max_open_payments: u32, near_reserve: U128) {
        self.assert_owner_full_access();
        policy::validate_max_open_payments(max_open_payments).unwrap_or_else(|e| env::panic_str(&e));
        self.max_open_payments = max_open_payments;
        self.near_reserve = near_reserve.0;
        emit(
            "capacity_changed",
            json!({ "max_open_payments": max_open_payments, "near_reserve": near_reserve }),
        );
    }

    /// yoctoNEAR attached to `storage_deposit` before each payout (default 0.00125 NEAR, max
    /// 0.1 NEAR). Requires 1 yoctoNEAR (full-access key).
    #[payable]
    pub fn set_storage_deposit(&mut self, amount: U128) {
        self.assert_owner_full_access();
        policy::validate_storage_deposit(amount.0, MAX_STORAGE_DEPOSIT)
            .unwrap_or_else(|e| env::panic_str(&e));
        self.storage_deposit = amount.0;
        emit("storage_deposit_changed", json!({ "storage_deposit": amount }));
    }

    /// Owner moves tokens out of the treasury. Requires 1 yoctoNEAR (full-access key).
    /// Registers `receiver` on the token first (refunded if already registered), then transfers.
    /// `withdrawal` is emitted once the transfer succeeded (`withdrawal_failed` otherwise).
    /// Attach >= 50 TGas.
    #[payable]
    pub fn withdraw(&mut self, amount: U128, receiver: AccountId) -> Promise {
        self.assert_owner_full_access();
        require!(amount.0 > 0, "amount must be > 0");
        // Plain `.then`: ft_transfer runs even if registration failed, and then only fails itself if
        // the receiver really is unregistered (there is no payment record to update here).
        self.register_on_token(&receiver)
            .then(
                ext_ft::ext(self.token.clone())
                    .with_attached_deposit(ONE_YOCTO)
                    .with_static_gas(GAS_FT_TRANSFER)
                    .ft_transfer(receiver.clone(), amount, Some("orvantra treasury withdrawal".into())),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_WITHDRAWN)
                    .on_withdrawn(amount, receiver, false),
            )
    }

    /// Owner takes NEAR out, never below `near_reserve`. Requires 1 yoctoNEAR (full-access key).
    /// `near_withdrawal` is emitted once the transfer succeeded.
    #[payable]
    pub fn withdraw_near(&mut self, amount: U128) -> Promise {
        self.assert_owner_full_access();
        require!(amount.0 > 0, "amount must be > 0");
        let spendable = self.available_near().saturating_sub(self.near_reserve);
        require!(amount.0 <= spendable, "withdrawal would go below the NEAR reserve");
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount.0)).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_ON_WITHDRAWN)
                .on_withdrawn(amount, self.owner.clone(), true),
        )
    }

    /// Result of a withdrawal: emits `withdrawal` / `near_withdrawal` on success, else
    /// `withdrawal_failed`. Never panics.
    #[private]
    pub fn on_withdrawn(&mut self, amount: U128, receiver: AccountId, near: bool) -> bool {
        let ok = is_promise_success();
        let event = match (ok, near) {
            (true, false) => "withdrawal",
            (true, true) => "near_withdrawal",
            (false, _) => "withdrawal_failed",
        };
        let asset = if near { "near" } else { "token" };
        emit(event, json!({ "amount": amount, "receiver": receiver, "asset": asset }));
        ok
    }

    /// Stop the agent from proposing (and the owner from approving). No deposit needed (safe direction).
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

    /// Result of the token's `storage_deposit` for payment `id`'s destination. On success, sends the
    /// tokens. On failure (e.g. deposit below the token's minimum) the payment is Failed and its cap
    /// released; the attached NEAR comes back to the treasury with the failed receipt's refund.
    /// Never panics.
    #[private]
    pub fn on_payment_registered(&mut self, id: u64) -> PromiseOrValue<PaymentStatus> {
        let p = self.payment(id);
        if p.status != PaymentStatus::Executing {
            return PromiseOrValue::Value(p.status);
        }
        if !is_promise_success() {
            return PromiseOrValue::Value(self.fail(id, policy::REASON_STORAGE_DEPOSIT_FAILED));
        }
        let Some(destination) = p.destination.clone() else {
            return PromiseOrValue::Value(self.fail(id, "no destination"));
        };
        PromiseOrValue::Promise(
            ext_ft::ext(self.token.clone())
                .with_attached_deposit(ONE_YOCTO)
                .with_static_gas(GAS_FT_TRANSFER)
                .ft_transfer(destination, p.amount, p.memo.clone())
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_ON_TRANSFERRED)
                        .on_payment_transferred(p.id),
                ),
        )
    }

    /// Result of the treasury's ft_transfer for payment `id`. Never panics.
    #[private]
    pub fn on_payment_transferred(&mut self, id: u64) -> PaymentStatus {
        let p = self.payment(id);
        if p.status != PaymentStatus::Executing {
            return p.status;
        }
        if is_promise_success() {
            self.mark_paid(id)
        } else {
            self.fail(id, policy::REASON_FT_TRANSFER_FAILED)
        }
    }

    // ---------------------------------------------------------------- views

    pub fn get_payment(&self, id: u64) -> Option<Payment> {
        self.payments.get(u32::try_from(id).ok()?).cloned()
    }

    pub fn get_payments(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Payment> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(MAX_PAGE_LIMIT).min(MAX_PAGE_LIMIT);
        let end = u64::from(self.payments.len()).min(from.saturating_add(limit));
        (from..end).filter_map(|i| self.get_payment(i)).collect()
    }

    /// Payments waiting for the owner (at most `MAX_PAGE_LIMIT`).
    pub fn get_pending(&self) -> Vec<Payment> {
        self.pending
            .iter()
            .take(MAX_PAGE_LIMIT as usize)
            .filter_map(|id| self.get_payment(*id))
            .collect()
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            agent: self.agent.clone(),
            registry: self.registry.clone(),
            token: self.token.clone(),
            auto_pay_threshold: self.auto_pay_threshold.into(),
            cross_chain_auto_pay_threshold: self.cross_chain_auto_pay_threshold.into(),
            monthly_cap: self.monthly_cap.into(),
            min_payout_age_sec: self.min_payout_age_sec,
            storage_deposit: self.storage_deposit.into(),
            paused: self.paused,
            payment_count: u64::from(self.payments.len()),
            open_payments: self.open_payments,
            max_open_payments: self.max_open_payments,
            near_reserve: self.near_reserve.into(),
            available_near: self.available_near().into(),
        }
    }

    pub fn get_vendor_policy(&self, vendor: AccountId) -> Option<VendorPolicy> {
        self.policies.get(&vendor).cloned()
    }

    /// Committed amount in the rolling 30-day window (today and the 29 days before), for one
    /// vendor or (`null`) for the whole treasury. This is what the caps are checked against.
    pub fn monthly_spent(&self, vendor: Option<AccountId>) -> U128 {
        let today = policy::day_of(env::block_timestamp());
        match vendor {
            Some(v) => self.vendor_spent_in_window(&v, today),
            None => self.total_spent_in_window(today),
        }
        .into()
    }

    /// `hash` is compared lowercase; anything that is not 64 hex chars is never used.
    pub fn is_invoice_used(&self, hash: String) -> bool {
        policy::normalize_invoice_hash(&hash).is_ok_and(|h| self.used_invoices.contains_key(&h))
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

    /// Why a Verifying payment can no longer go ahead (paused, or the vendor lost its policy).
    fn still_payable(&self, vendor: &AccountId) -> Option<&'static str> {
        if self.paused {
            Some(policy::REASON_PAUSED)
        } else if !self.policies.contains_key(vendor) {
            Some(policy::REASON_NO_POLICY)
        } else {
            None
        }
    }

    /// Store a (validated) vendor policy and emit `vendor_policy_set`.
    fn insert_vendor_policy(&mut self, vendor: AccountId, max_per_invoice: U128, monthly_cap: U128) {
        emit(
            "vendor_policy_set",
            json!({ "vendor": vendor, "max_per_invoice": max_per_invoice, "monthly_cap": monthly_cap }),
        );
        self.policies.insert(vendor, VendorPolicy { max_per_invoice, monthly_cap });
    }

    /// Vector index of payment `id`; ids above u32::MAX never exist (no aliasing).
    fn index(id: u64) -> u32 {
        u32::try_from(id).unwrap_or_else(|_| env::panic_str("payment not found"))
    }

    fn payment(&self, id: u64) -> Payment {
        self.payments
            .get(Self::index(id))
            .cloned()
            .unwrap_or_else(|| env::panic_str("payment not found"))
    }

    fn payment_mut(&mut self, id: u64) -> &mut Payment {
        self.payments
            .get_mut(Self::index(id))
            .unwrap_or_else(|| env::panic_str("payment not found"))
    }

    fn set_status(&mut self, id: u64, status: PaymentStatus) {
        let p = self.payment_mut(id);
        let was_open = p.status.is_open();
        p.status = status;
        p.updated_at = env::block_timestamp().into();
        let id = p.id;
        match (was_open, status.is_open()) {
            (true, false) => self.open_payments = self.open_payments.saturating_sub(1),
            (false, true) => self.open_payments += 1,
            _ => {}
        }
        if status == PaymentStatus::Pending {
            self.pending.insert(id);
        } else {
            self.pending.remove(&id);
        }
    }

    fn reject(&mut self, id: u64, reason: &str) -> PaymentStatus {
        let p = self.payment(id);
        if p.status.is_committed() {
            self.release(&p.vendor, p.day, p.amount.0);
        }
        self.payment_mut(id).reasons.push(reason.to_string());
        self.set_status(id, PaymentStatus::Rejected);
        emit("payment_rejected", payment_json(&self.payment(id)));
        PaymentStatus::Rejected
    }

    /// Failed after the decision (registration or transfer): release the cap, record the reason.
    fn fail(&mut self, id: u64, reason: &str) -> PaymentStatus {
        let p = self.payment(id);
        self.release(&p.vendor, p.day, p.amount.0);
        self.payment_mut(id).reasons.push(reason.into());
        self.set_status(id, PaymentStatus::Failed);
        emit("payment_failed", payment_json(&self.payment(id)));
        PaymentStatus::Failed
    }

    fn mark_paid(&mut self, id: u64) -> PaymentStatus {
        self.set_status(id, PaymentStatus::Paid);
        let p = self.payment(id);
        self.paid_vendors.insert(p.vendor.clone());
        emit("payment_paid", payment_json(&p));
        PaymentStatus::Paid
    }

    /// token.storage_deposit({account_id, registration_only: true}) with `self.storage_deposit`
    /// yoctoNEAR from the treasury's balance. NEP-145 refunds the excess (or all of it, if the
    /// account is already registered) to the predecessor, i.e. back to this treasury.
    fn register_on_token(&self, account: &AccountId) -> Promise {
        ext_ft::ext(self.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(self.storage_deposit))
            .with_static_gas(GAS_STORAGE_DEPOSIT)
            .storage_deposit(Some(account.clone()), Some(true))
    }

    /// storage_deposit(destination) -> on_payment_registered -> ft_transfer(destination, amount,
    /// memo) with 1 yoctoNEAR -> on_payment_transferred.
    fn execute(&mut self, id: u64) -> Promise {
        self.set_status(id, PaymentStatus::Executing);
        let p = self.payment(id);
        let destination = p.destination.clone().unwrap_or_else(|| env::panic_str("no destination"));
        self.register_on_token(&destination).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_ON_REGISTERED)
                .on_payment_registered(p.id),
        )
    }

    /// Write cached collection changes to storage, so `env::storage_usage()` is current.
    fn flush(&mut self) {
        self.payments.flush();
        self.used_invoices.flush();
        self.vendor_spent.flush();
        self.total_spent.flush();
    }

    fn available_near(&self) -> u128 {
        policy::available_near(
            env::account_balance().as_yoctonear(),
            env::account_locked_balance().as_yoctonear(),
            env::storage_usage(),
            env::storage_byte_cost().as_yoctonear(),
        )
    }

    fn vendor_spent_on(&self, vendor: &AccountId, day: u64) -> u128 {
        self.vendor_spent.get(&(vendor.clone(), day)).copied().unwrap_or(0)
    }

    fn total_spent_on(&self, day: u64) -> u128 {
        self.total_spent.get(&day).copied().unwrap_or(0)
    }

    fn vendor_spent_in_window(&self, vendor: &AccountId, today: u64) -> u128 {
        policy::window_days(today).fold(0u128, |s, d| s.saturating_add(self.vendor_spent_on(vendor, d)))
    }

    fn total_spent_in_window(&self, today: u64) -> u128 {
        policy::window_days(today).fold(0u128, |s, d| s.saturating_add(self.total_spent_on(d)))
    }

    fn commit(&mut self, vendor: &AccountId, day: u64, amount: u128) {
        let v = self.vendor_spent_on(vendor, day) + amount;
        let t = self.total_spent_on(day) + amount;
        self.vendor_spent.insert((vendor.clone(), day), v);
        self.total_spent.insert(day, t);
    }

    /// Undo `commit` on the payment's own day; counters that reach 0 are deleted.
    fn release(&mut self, vendor: &AccountId, day: u64, amount: u128) {
        let v = self.vendor_spent_on(vendor, day).saturating_sub(amount);
        let t = self.total_spent_on(day).saturating_sub(amount);
        if v == 0 {
            self.vendor_spent.remove(&(vendor.clone(), day));
        } else {
            self.vendor_spent.insert((vendor.clone(), day), v);
        }
        if t == 0 {
            self.total_spent.remove(&day);
        } else {
            self.total_spent.insert(day, t);
        }
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
