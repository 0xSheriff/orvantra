#!/usr/bin/env bash
# Orvantra treasury v6 testnet deploy (non-interactive). TESTNET ONLY.
# v6 = v5 contract + OWNER = orvantra.testnet (the human's own account, key in their wallet).
# What this script can sign: v6 (faucet key, on host), v5 (owner key, on host — to release funds),
# agent (full key, on host). It CANNOT sign as the owner — vendor policies are set by the owner
# in the web app (/rules), not here.
set -euo pipefail
source ~/.cargo/env
cd ~/projects/orvantra
set -a; . ./.env 2>/dev/null; set +a
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null 2>&1

NETWORK=testnet
OWNER=orvantra.testnet            # the human. Key NOT on this host — by design.
V5OWNER=orvantra-owner.testnet    # v5 treasury owner (host key) — only used to withdraw v5 funds.
AGENT=orvantra-agent.testnet
TREASURY=orvantra-treasury-v6.testnet
V5=orvantra-treasury-v5.testnet
TOKEN=orvantra-tusdc.testnet
REGISTRY=orvantra-registry.testnet
ACME=orvantra-acme.testnet
BOB=orvantra-bob.testnet
SIM=8820697d2b4ba9c41055b0362c1318baa0b626304d8015547b4bb9a407560239
U=1000000
FUND=$((500 * U))
AUTO_PAY_THRESHOLD=$((100 * U))
MONTHLY_CAP=$((1000 * U))
MIN_PAYOUT_AGE_SEC=120
STORAGE_DEPOSIT_YOCTO=1250000000000000000000
GAS='150.0 Tgas'
TREASURY_WASM="$HOME/projects/orvantra/target/near/treasury/treasury.wasm"
KEYFILE="$HOME/.orvantra/keys/$NETWORK/$AGENT.json"
LOG="${TMPDIR:-/tmp}/orvantra-v6-deploy-$(date +%s).log"
echo "log: $LOG"

export NEAR_NETWORK="$NETWORK" TREASURY_ID="$TREASURY" REGISTRY_ID="$REGISTRY" AGENT_ID="$AGENT" SIM_DEPOSIT_ACCOUNT="$SIM"

step() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
view() { near contract call-function as-read-only "$1" "$2" json-args "$3" network-config "$NETWORK" now 2>/dev/null; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
exists() { near account view-account-summary "$1" network-config "$NETWORK" now >/dev/null 2>&1; }
call() { # SIGNER CONTRACT METHOD JSON DEPOSIT
  echo "### $1 -> $2.$3 $4" >>"$LOG"
  if ! near contract call-function as-transaction "$2" "$3" json-args "$4" prepaid-gas "$GAS" attached-deposit "$5" \
      sign-as "$1" network-config "$NETWORK" sign-with-legacy-keychain send >>"$LOG" 2>&1; then
    echo "   FAILED: $1 -> $2.$3 (tail of $LOG):" >&2; tail -20 "$LOG" >&2; return 1
  fi
}

[[ -f "$TREASURY_WASM" ]] || { echo "wasm missing — build first"; exit 1; }

step "1. account (faucet)"
if exists "$TREASURY"; then echo "   $TREASURY exists (skip)"; else
  near account create-account sponsor-by-faucet-service "$TREASURY" autogenerate-new-keypair \
    save-to-legacy-keychain network-config "$NETWORK" create
fi

step "2. deploy wasm + init (owner=$OWNER)"
if view "$TREASURY" get_config '{}' >/dev/null 2>&1; then echo "   already deployed (skip)"; else
  near contract deploy "$TREASURY" use-file "$TREASURY_WASM" \
    with-init-call new json-args "{\"owner\":\"$OWNER\",\"agent\":\"$AGENT\",\"registry\":\"$REGISTRY\",\"token\":\"$TOKEN\",\"auto_pay_threshold\":\"$AUTO_PAY_THRESHOLD\",\"monthly_cap\":\"$MONTHLY_CAP\",\"min_payout_age_sec\":$MIN_PAYOUT_AGE_SEC,\"storage_deposit\":\"$STORAGE_DEPOSIT_YOCTO\",\"cross_chain_auto_pay_threshold\":\"0\",\"max_open_payments\":25,\"near_reserve\":\"500000000000000000000000\"}" \
    prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
    network-config "$NETWORK" sign-with-legacy-keychain send
fi
view "$TREASURY" get_config '{}'
echo

step "3. token registration (signed by v6 itself)"
for a in "$TREASURY" "$SIM"; do
  if [[ "$(view "$TOKEN" storage_balance_of "{\"account_id\":\"$a\"}")" == "null" ]]; then
    call "$TREASURY" "$TOKEN" storage_deposit "{\"account_id\":\"$a\",\"registration_only\":true}" '0.00125 NEAR'
    echo "   registered $a"
  else echo "   $a already registered (skip)"; fi
done

step "4. fund v6 from v5 remaining tUSDC (signed by v5 owner)"
bal() { view "$TOKEN" ft_balance_of "{\"account_id\":\"$1\"}" | json 'int(d)'; }
have="$(bal "$TREASURY" || echo 0)"
want=$((FUND - have))
if (( want > 0 )); then
  # withdraw from v5 (full-access call, signed by v5's owner) straight to v6
  call "$V5OWNER" "$V5" withdraw "{\"amount\":\"$want\",\"receiver\":\"$TREASURY\"}" '1 yoctoNEAR'
  echo "   withdrew $((want / U)).00 tUSDC v5 -> v6"
fi
echo "   v6 tUSDC balance: $(( $(bal "$TREASURY") / U )).00"

step "5. fresh agent function-call key scoped to v6"
(cd agent && npm run --silent setup-agent-key -- --account "$AGENT" --contract "$TREASURY" --network "$NETWORK" --force)
cp "$KEYFILE" "$HOME/.orvantra/keys/$NETWORK/orvantra-agent.testnet.v6.json"
PUB="$(python3 -c "import json; print(json.load(open('$KEYFILE'))['public_key'])")"
echo "   new agent key: $PUB"
if near account list-keys "$AGENT" network-config "$NETWORK" now 2>/dev/null | grep -q "${PUB#ed25519:}"; then
  echo "   already on-chain (skip)"
else
  near account add-key "$AGENT" grant-function-call-access --allowance '0.25 NEAR' \
    --contract-account-id "$TREASURY" --function-names 'propose_payment' \
    use-manually-provided-public-key "$PUB" network-config "$NETWORK" sign-with-legacy-keychain send >>"$LOG" 2>&1
  echo "   added on-chain"
fi

step "6. STOP — owner must now, in the web app (/rules) with $OWNER connected:"
echo "   set_vendor_policy acme (300 per invoice / 600 monthly) and bob (300 / 200)."
echo "   then run: bash scripts/testnet-v6-demo.sh"
echo
echo "DEPLOY V6 DONE (demo not run — it needs the owner's vendor policies first)"
