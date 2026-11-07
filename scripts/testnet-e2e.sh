#!/usr/bin/env bash
# Orvantra Day 3 testnet walkthrough: test token + treasury against the deployed vendor registry.
#
# TESTNET ONLY. Uses near-cli-rs with keys from the legacy keychain (~/.near-credentials/testnet).
# Safe to re-run: deploys/inits are skipped when already done, invoice hashes get a per-run suffix,
# and caps are raised relative to what was already spent this month.
#
# Prereqs: contracts built (`cargo near build non-reproducible-wasm` in contracts/test-token and
# contracts/treasury), python3 (JSON parsing), and full-access keys in the keychain for
# OWNER, AGENT and NEAR_VENDOR. TOKEN / TREASURY / AGENT are created via the testnet faucet if missing.
set -euo pipefail

# ------------------------------------------------------------------ accounts (edit these)
NETWORK=testnet
OWNER=${OWNER:-orvantra-owner.testnet}  # the human (dev stand-in on testnet); owns token supply + treasury
AGENT=orvantra-agent.testnet           # the AI agent's account (only it may propose_payment)
TOKEN=orvantra-tusdc.testnet           # test-token contract (tUSDC, 6 decimals)
TREASURY=orvantra-treasury.testnet     # treasury contract
REGISTRY=orvantra-registry.testnet     # vendor registry (already deployed, see docs/DEPLOYMENTS.md)
CROSS_VENDOR=orvantra-acme.testnet     # registry payout: USDC on Base (cross-chain path)
NEAR_VENDOR=orvantra-bob.testnet       # we set its payout to tUSDC on NEAR (direct path)

# ------------------------------------------------------------------ amounts (tUSDC base units, 6 decimals)
U=1000000
SUPPLY=$((1000000 * U))                # 1,000,000 tUSDC
FUND=$((500 * U))                      # top the treasury up to at least this
AUTO_PAY_THRESHOLD=$((100 * U))        # > 100 tUSDC needs the owner
MIN_PAYOUT_AGE_SEC=120                 # demo value: payouts younger than 2 min need the owner
VENDOR_MAX=$((300 * U))                # max per invoice
STORAGE_DEPOSIT='0.00125 NEAR'
GAS='150.0 Tgas'                       # propose/approve: >= 100 TGas (see treasury README)

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOKEN_WASM="$ROOT/target/near/test_token/test_token.wasm"
TREASURY_WASM="$ROOT/target/near/treasury/treasury.wasm"
RUN="$(date +%s)"                      # per-run suffix for invoice hashes
LOG="${TMPDIR:-/tmp}/orvantra-e2e-$RUN.log"   # full near CLI output of every transaction
echo "near CLI transaction output -> $LOG"

# ------------------------------------------------------------------ helpers
step() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
expect() { printf '\033[0;32m   do: %s\n   -> see: %s\033[0m\n' "$1" "$2"; }

view() { # view CONTRACT METHOD JSON  -> prints JSON result on stdout
  near contract call-function as-read-only "$1" "$2" json-args "$3" \
    network-config "$NETWORK" now 2>/dev/null
}

call_raw() { # call_raw SIGNER CONTRACT METHOD JSON DEPOSIT
  near contract call-function as-transaction "$2" "$3" json-args "$4" \
    prepaid-gas "$GAS" attached-deposit "$5" \
    sign-as "$1" network-config "$NETWORK" sign-with-legacy-keychain send
}

# call: full CLI output goes to $LOG; on failure show the tail and return 1 (stops the script).
call() {
  echo "### $1 -> $2.$3 $4" >>"$LOG"
  if ! call_raw "$@" >>"$LOG" 2>&1; then
    echo "   FAILED: $1 -> $2.$3 (last lines of $LOG):" >&2
    tail -15 "$LOG" >&2
    return 1
  fi
}

# call that is EXPECTED to fail; prints whether the expected message appeared.
call_expect_fail() { # call_expect_fail EXPECTED_MSG SIGNER CONTRACT METHOD JSON DEPOSIT
  local msg="$1"; shift
  local out
  if out="$(call_raw "$@" 2>&1)"; then
    echo "   UNEXPECTED: call succeeded"; echo "$out" | tail -5; return 1
  fi
  if grep -q "$msg" <<<"$out"; then
    echo "   OK: rejected by contract with \"$msg\""
  else
    echo "   UNEXPECTED failure output:"; echo "$out" | tail -10; return 1
  fi
}

json() { # json 'python expression on d' < JSON
  python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"
}

exists() { near account view-account-summary "$1" network-config "$NETWORK" now >/dev/null 2>&1; }

ensure_account() {
  if exists "$1"; then echo "   $1 exists"; else
    echo "   creating $1 via faucet"
    near account create-account sponsor-by-faucet-service "$1" autogenerate-new-keypair \
      save-to-legacy-keychain network-config "$NETWORK" create
  fi
}

last_payment_id() { view "$TREASURY" get_config '{}' | json 'd["payment_count"]-1'; }

show_payment() { # show_payment ID
  view "$TREASURY" get_payment "{\"id\":$1}" |
    json '"   payment #%s status=%s direct=%s dest=%s amount=%s reasons=%s" % (d["id"], d["status"], d["direct"], d["destination"], d["amount"], d["reasons"])'
}

propose() { # propose VENDOR AMOUNT HASH [DEPOSIT_ADDRESS] -> prints new payment id
  local version dep
  version="$(view "$REGISTRY" get_vendor "{\"account_id\":\"$1\"}" | json 'd["version"] if d else 0')"
  dep="null"; [[ -n "${4:-}" ]] && dep="\"$4\""
  call "$AGENT" "$TREASURY" propose_payment \
    "{\"invoice_hash\":\"$3\",\"vendor\":\"$1\",\"amount\":\"$2\",\"payout_version\":$version,\"deposit_address\":$dep,\"quote_hash\":null,\"memo\":\"orvantra e2e $3\"}" \
    '0 NEAR' || return 1
  last_payment_id
}

balance() { view "$TOKEN" ft_balance_of "{\"account_id\":\"$1\"}" | json 'int(d)'; }

[[ -f "$TOKEN_WASM" && -f "$TREASURY_WASM" ]] || {
  echo "Build first: (cd contracts/test-token && cargo near build non-reproducible-wasm) and same for contracts/treasury"; exit 1; }

# ================================================================== 1. accounts
step "1. Accounts"
for a in "$AGENT" "$TOKEN" "$TREASURY"; do ensure_account "$a"; done
for a in "$OWNER" "$REGISTRY" "$CROSS_VENDOR" "$NEAR_VENDOR"; do
  exists "$a" || { echo "   missing $a (create it first)"; exit 1; }
done

# ================================================================== 2. deploy token
step "2. Deploy test token to $TOKEN"
if view "$TOKEN" ft_metadata '{}' >/dev/null; then
  echo "   already deployed+initialised (skip)"
else
  near contract deploy "$TOKEN" use-file "$TOKEN_WASM" \
    with-init-call new json-args "{\"owner_id\":\"$OWNER\",\"total_supply\":\"$SUPPLY\"}" \
    prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
    network-config "$NETWORK" sign-with-legacy-keychain send
fi
expect "near contract call-function as-read-only $TOKEN ft_metadata json-args {} network-config testnet now" \
  '{"name":"Test USDC","symbol":"tUSDC","decimals":6,...}'

# ================================================================== 3. deploy treasury
step "3. Deploy treasury to $TREASURY"
if view "$TREASURY" get_config '{}' >/dev/null; then
  echo "   already deployed+initialised (skip; to ship new code: near contract deploy $TREASURY use-file $TREASURY_WASM without-init-call ...)"
else
  near contract deploy "$TREASURY" use-file "$TREASURY_WASM" \
    with-init-call new json-args "{\"owner\":\"$OWNER\",\"agent\":\"$AGENT\",\"registry\":\"$REGISTRY\",\"token\":\"$TOKEN\",\"auto_pay_threshold\":\"$AUTO_PAY_THRESHOLD\",\"monthly_cap\":\"$((1000 * U))\",\"min_payout_age_sec\":$MIN_PAYOUT_AGE_SEC}" \
    prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
    network-config "$NETWORK" sign-with-legacy-keychain send
fi
view "$TREASURY" get_config '{}'

# ================================================================== 4. token storage + funding
step "4. Register treasury + $NEAR_VENDOR on the token, fund the treasury"
for a in "$TREASURY" "$NEAR_VENDOR"; do
  if [[ "$(view "$TOKEN" storage_balance_of "{\"account_id\":\"$a\"}")" == "null" ]]; then
    call "$OWNER" "$TOKEN" storage_deposit "{\"account_id\":\"$a\",\"registration_only\":true}" "$STORAGE_DEPOSIT"
    echo "   registered $a"
  else echo "   $a already registered"; fi
done
have="$(balance "$TREASURY")"
if (( have < FUND )); then
  # ft_transfer_call exercises treasury.ft_on_transfer (accepts only the configured token)
  call "$OWNER" "$TOKEN" ft_transfer_call \
    "{\"receiver_id\":\"$TREASURY\",\"amount\":\"$((FUND - have))\",\"msg\":\"\"}" '1 yoctoNEAR'
fi
echo "   treasury balance: $(balance "$TREASURY") (base units)"
expect "view $TOKEN ft_balance_of {\"account_id\":\"$TREASURY\"}" "\"$FUND\" or more"

# ================================================================== 5. vendors + policy
step "5. $NEAR_VENDOR publishes a NEAR-direct payout (tUSDC on NEAR) in the registry"
# set_vendor requires exactly 1 yoctoNEAR (forces a full-access key, i.e. a real wallet confirmation).
call "$NEAR_VENDOR" "$REGISTRY" set_vendor \
  "{\"display_name\":\"Bob Supplies\",\"chain\":\"near\",\"asset_id\":\"nep141:$TOKEN\",\"address\":\"$NEAR_VENDOR\"}" \
  '1 yoctoNEAR'
view "$REGISTRY" get_vendor "{\"account_id\":\"$NEAR_VENDOR\"}"
echo "   ($CROSS_VENDOR stays on chain \"base\": cross-chain path, needs a 1Click deposit address)"

step "6. Owner sets limits + vendor policies (caps raised relative to this month's spend so re-runs work)"
total_spent="$(view "$TREASURY" monthly_spent '{"vendor":null}' | json 'int(d)')"
bob_spent="$(view "$TREASURY" monthly_spent "{\"vendor\":\"$NEAR_VENDOR\"}" | json 'int(d)')"
TREASURY_CAP=$((total_spent + 1000 * U))
BOB_CAP=$((bob_spent + 200 * U))     # this run uses 165 tUSDC, so a 50 tUSDC 4th payment breaks the cap
call "$OWNER" "$TREASURY" set_limits \
  "{\"auto_pay_threshold\":\"$AUTO_PAY_THRESHOLD\",\"monthly_cap\":\"$TREASURY_CAP\",\"min_payout_age_sec\":$MIN_PAYOUT_AGE_SEC}" \
  '1 yoctoNEAR'
call "$OWNER" "$TREASURY" set_vendor_policy \
  "{\"vendor\":\"$CROSS_VENDOR\",\"max_per_invoice\":\"$VENDOR_MAX\",\"monthly_cap\":\"$((600 * U))\"}" '1 yoctoNEAR'
call "$OWNER" "$TREASURY" set_vendor_policy \
  "{\"vendor\":\"$NEAR_VENDOR\",\"max_per_invoice\":\"$VENDOR_MAX\",\"monthly_cap\":\"$BOB_CAP\"}" '1 yoctoNEAR'
view "$TREASURY" get_vendor_policy "{\"vendor\":\"$CROSS_VENDOR\"}"
view "$TREASURY" get_vendor_policy "{\"vendor\":\"$NEAR_VENDOR\"}"

# ================================================================== 7. first payment -> pending -> approve
step "7. First payment to $NEAR_VENDOR (10 tUSDC)"
id="$(propose "$NEAR_VENDOR" $((10 * U)) "inv-first-$RUN")"
show_payment "$id"
expect "first run" "status=Pending reasons=['first payment to this vendor', ...] (re-runs: Paid if payout is old enough)"
if [[ "$(view "$TREASURY" get_payment "{\"id\":$id}" | json 'd["status"]')" == "Pending" ]]; then
  call "$OWNER" "$TREASURY" approve_payment "{\"id\":$id}" '1 yoctoNEAR'
  show_payment "$id"
  expect "owner approve_payment($id)" "status=Paid direct=True dest=$NEAR_VENDOR"
fi

# ================================================================== 8. small payment auto path
step "8. Small payment auto path (5 tUSDC, under threshold, known vendor)"
age_ns="$(view "$REGISTRY" payout_age_ns "{\"account_id\":\"$NEAR_VENDOR\"}" | json 'int(d)')"
wait_s=$(( MIN_PAYOUT_AGE_SEC - age_ns / 1000000000 + 5 ))
if (( wait_s > 0 )); then echo "   payout is fresh; waiting ${wait_s}s for min_payout_age_sec..."; sleep "$wait_s"; fi
before="$(balance "$NEAR_VENDOR")"
SMALL_HASH="inv-small-$RUN"
id="$(propose "$NEAR_VENDOR" $((5 * U)) "$SMALL_HASH")"
show_payment "$id"
echo "   $NEAR_VENDOR balance: $before -> $(balance "$NEAR_VENDOR")"
expect "agent propose_payment 5 tUSDC" "status=Paid direct=True, no owner action, vendor balance +5000000"

# ================================================================== 9. over threshold -> pending -> approve
step "9. Over threshold (150 tUSDC > 100 auto-pay threshold)"
id="$(propose "$NEAR_VENDOR" $((150 * U)) "inv-big-$RUN")"
show_payment "$id"
expect "agent propose_payment 150 tUSDC" "status=Pending reasons=['amount above auto-pay threshold']"
view "$TREASURY" get_pending '{}' | json '"   get_pending ids: %s" % [p["id"] for p in d]'
call "$OWNER" "$TREASURY" approve_payment "{\"id\":$id}" '1 yoctoNEAR'
show_payment "$id"
expect "owner approve_payment($id) (re-checks registry version first)" "status=Paid"

# ================================================================== 10. duplicate
step "10. Duplicate invoice (re-submit $SMALL_HASH)"
v="$(view "$REGISTRY" get_vendor "{\"account_id\":\"$NEAR_VENDOR\"}" | json 'd["version"]')"
call_expect_fail "invoice already used" "$AGENT" "$TREASURY" propose_payment \
  "{\"invoice_hash\":\"$SMALL_HASH\",\"vendor\":\"$NEAR_VENDOR\",\"amount\":\"$((5 * U))\",\"payout_version\":$v}" '0 NEAR'
expect "same invoice hash again" "tx fails: \"invoice already used\" (nothing stored, nothing paid)"

# ================================================================== 11. over caps
step "11. Over caps"
call_expect_fail "amount above vendor max_per_invoice" "$AGENT" "$TREASURY" propose_payment \
  "{\"invoice_hash\":\"inv-huge-$RUN\",\"vendor\":\"$CROSS_VENDOR\",\"amount\":\"$((400 * U))\",\"payout_version\":2,\"deposit_address\":null}" '0 NEAR'
expect "400 tUSDC to $CROSS_VENDOR (max_per_invoice 300)" "tx fails: \"amount above vendor max_per_invoice\""
echo "   $NEAR_VENDOR spent this month: $(view "$TREASURY" monthly_spent "{\"vendor\":\"$NEAR_VENDOR\"}") / cap $BOB_CAP"
call_expect_fail "over vendor monthly cap" "$AGENT" "$TREASURY" propose_payment \
  "{\"invoice_hash\":\"inv-cap-$RUN\",\"vendor\":\"$NEAR_VENDOR\",\"amount\":\"$((50 * U))\",\"payout_version\":$v}" '0 NEAR'
expect "50 tUSDC more to $NEAR_VENDOR (165 of 200 used)" "tx fails: \"over vendor monthly cap\""

step "Done. Inspect everything:"
echo "   near contract call-function as-read-only $TREASURY get_payments json-args '{}' network-config testnet now"
echo "   Explorer: https://testnet.nearblocks.io/address/$TREASURY"
