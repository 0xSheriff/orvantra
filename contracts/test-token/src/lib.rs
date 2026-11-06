//! Orvantra test token: a minimal NEP-141 fungible token for TESTNET DEMOS ONLY.
//!
//! "Test USDC" (symbol `tUSDC`, 6 decimals, like real USDC). The whole supply is minted to
//! `owner_id` at init; there is no further minting. Accounts must be registered with
//! `storage_deposit` (NEP-145) before they can receive tokens, exactly like real USDC on NEAR.
//!
//! All logic comes from `near-contract-standards`; this file only wires it up.

use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::{
    env, near, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue,
};

pub const NAME: &str = "Test USDC";
pub const SYMBOL: &str = "tUSDC";
pub const DECIMALS: u8 = 6;

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    FungibleToken,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct TestToken {
    token: FungibleToken,
    metadata: FungibleTokenMetadata,
}

pub fn metadata() -> FungibleTokenMetadata {
    FungibleTokenMetadata {
        spec: FT_METADATA_SPEC.to_string(),
        name: NAME.to_string(),
        symbol: SYMBOL.to_string(),
        icon: None,
        reference: None,
        reference_hash: None,
        decimals: DECIMALS,
    }
}

#[near]
impl TestToken {
    /// Mint `total_supply` (base units, 6 decimals) to `owner_id`.
    #[init]
    pub fn new(owner_id: AccountId, total_supply: U128) -> Self {
        let mut this = Self { token: FungibleToken::new(StorageKey::FungibleToken), metadata: metadata() };
        this.metadata.assert_valid();
        this.token.internal_register_account(&owner_id);
        this.token.internal_deposit(&owner_id, total_supply.0);
        FtMint { owner_id: &owner_id, amount: total_supply, memo: Some("initial supply") }.emit();
        this
    }
}

#[near]
impl FungibleTokenCore for TestToken {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for TestToken {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used, burned) =
            self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned > 0 {
            env::log_str(&format!("{burned} tokens burned (receiver unregistered)"));
        }
        used.into()
    }
}

#[near]
impl StorageManagement for TestToken {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        // Same behaviour as the reference implementation: burn the balance only with force=true.
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for TestToken {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const SUPPLY: u128 = 1_000_000 * 1_000_000; // 1M tUSDC

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(predecessor: &str, deposit: NearToken) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(acc("token.testnet"))
            .predecessor_account_id(acc(predecessor))
            .attached_deposit(deposit)
            .build());
    }

    fn setup() -> TestToken {
        ctx("deployer.testnet", NearToken::from_yoctonear(0));
        TestToken::new(acc("owner.testnet"), U128(SUPPLY))
    }

    #[test]
    fn init_mints_supply_to_owner() {
        let t = setup();
        assert_eq!(t.ft_total_supply().0, SUPPLY);
        assert_eq!(t.ft_balance_of(acc("owner.testnet")).0, SUPPLY);
        assert_eq!(t.ft_balance_of(acc("nobody.testnet")).0, 0);
    }

    #[test]
    fn metadata_is_test_usdc() {
        let t = setup();
        let m = t.ft_metadata();
        assert_eq!(m.name, "Test USDC");
        assert_eq!(m.symbol, "tUSDC");
        assert_eq!(m.decimals, 6);
        assert_eq!(m.spec, FT_METADATA_SPEC);
    }

    #[test]
    fn storage_deposit_then_transfer() {
        let mut t = setup();
        let min = t.storage_balance_bounds().min;
        ctx("alice.testnet", min);
        t.storage_deposit(None, None);
        assert!(t.storage_balance_of(acc("alice.testnet")).is_some());

        ctx("owner.testnet", NearToken::from_yoctonear(1));
        t.ft_transfer(acc("alice.testnet"), U128(5_000_000), None);
        assert_eq!(t.ft_balance_of(acc("alice.testnet")).0, 5_000_000);
        assert_eq!(t.ft_balance_of(acc("owner.testnet")).0, SUPPLY - 5_000_000);
    }

    /// NEAR refunded to the caller by the receipts the token created.
    fn refunded() -> u128 {
        near_sdk::test_utils::get_created_receipts()
            .into_iter()
            .flat_map(|r| r.actions)
            .filter_map(|a| match a {
                near_sdk::mock::MockAction::Transfer { deposit, .. } => Some(deposit.as_yoctonear()),
                _ => None,
            })
            .sum()
    }

    /// What the treasury does before every payout: a third party (the treasury) registers a fresh
    /// account with `registration_only: true`, attaching 0.00125 NEAR + extra.
    #[test]
    fn registration_only_by_third_party_refunds_excess_and_repeat() {
        let mut t = setup();
        let min = t.storage_balance_bounds().min.as_yoctonear();
        assert_eq!(min, 1_250_000_000_000_000_000_000, "0.00125 NEAR, same as USDC");
        let deposit = NearToken::from_yoctonear(min + 1_000);
        let fresh = acc("a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90");

        ctx("treasury.testnet", deposit);
        let b = t.storage_deposit(Some(fresh.clone()), Some(true));
        assert_eq!(b.total.as_yoctonear(), min);
        assert_eq!(refunded(), 1_000, "excess refunded");
        assert!(t.storage_balance_of(fresh.clone()).is_some());

        ctx("treasury.testnet", deposit);
        t.storage_deposit(Some(fresh.clone()), Some(true));
        assert_eq!(refunded(), min + 1_000, "already registered: everything refunded");
    }

    #[test]
    #[should_panic(expected = "less than the minimum storage balance")]
    fn registration_below_minimum_panics() {
        let mut t = setup();
        ctx("treasury.testnet", NearToken::from_yoctonear(1));
        t.storage_deposit(Some(acc("new.testnet")), Some(true));
    }

    #[test]
    #[should_panic(expected = "is not registered")]
    fn transfer_to_unregistered_fails() {
        let mut t = setup();
        ctx("owner.testnet", NearToken::from_yoctonear(1));
        t.ft_transfer(acc("bob.testnet"), U128(1), None);
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn transfer_requires_one_yocto() {
        let mut t = setup();
        ctx("owner.testnet", NearToken::from_yoctonear(0));
        t.ft_transfer(acc("owner2.testnet"), U128(1), None);
    }
}
