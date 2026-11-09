#!/usr/bin/env bash
# Orvantra Day 5 testnet walkthrough: agent -> (1Click quote) -> treasury, signed with a RESTRICTED agent key.
#
# TESTNET ONLY. Run it yourself (it signs testnet transactions with keys from ~/.near-credentials/testnet via
# near-cli-rs `sign-with-legacy-keychain`). Re-runnable: existing accounts / deploys / registrations / keys are
# skipped, and `npm run pay` refuses to re-send an invoice it already proposed (agent/data/ledger.json).
#
# Prereqs:
#   - contracts built:  (cd contracts/treasury && cargo near build non-reproducible-wasm)
#   - agent deps:       (cd agent && nvm use && npm ci)    and NEARAI_API_KEY in the repo-root .env
#   - full-access keys in the legacy keychain for OWNER and AGENT (from Day 3), python3
#   - TOKEN, REGISTRY, vendors already deployed/registered (docs/DEPLOYMENTS.md)
# Bob's payment history lives on the OLD treasury; the new one starts clean.
set -euo pipefail

# ------------------------------------------------------------------ accounts (edit these)
NETWORK=testnet
OWNER=orvantra-owner.testnet             # the human; owns the tUSDC supply, approves held payments
AGENT=orvantra-agent.testnet             # the agent account; it will sign ONLY with a function-call key
# Treasury with the 2026-11-08 security fixes (new state layout): deploy to a FRESH account.
TREASURY=${TREASURY:-orvantra-treasury-v4.testnet}
# Stand-in for the 1Click deposit address (testnet has no NEAR Intents). The treasury only pays cross-chain to a
# 64-hex implicit account, like real 1Click deposit addresses; this one is sha256("orvantra-1click-sim").
SIM=${SIM:-$(python3 -c "import hashlib; print(hashlib.sha256(b'orvantra-1click-sim').hexdigest())")}
TOKEN=orvantra-tusdc.testnet             # test token (tUSDC, 6 decimals)
REGISTRY=orvantra-registry.testnet       # vendor registry
ACME=orvantra-acme.testnet               # payout: USDC on Base  -> cross-chain path (simulated on testnet)
BOB=orvantra-bob.testnet                 # payout: tUSDC on NEAR -> direct path
REGISTER_SIM_ON_TOKEN=${REGISTER_SIM_ON_TOKEN:-1}  # 0 = leave SIM unregistered; the treasury registers it itself on payout

# ------------------------------------------------------------------ amounts (tUSDC base units, 6 decimals)
U=1000000
FUND=$((500 * U))                        # top the treasury up to at least this
AUTO_PAY_THRESHOLD=$((100 * U))          # > 100 tUSDC needs the owner
MONTHLY_CAP=$((1000 * U))
MIN_PAYOUT_AGE_SEC=120                   # payouts younger than 2 min need the owner
STORAGE_DEPOSIT_YOCTO=1250000000000000000000   # 0.00125 NEAR attached to token.storage_deposit before each payout
ACME_MAX=$((300 * U)); ACME_CAP=$((600 * U))
BOB_MAX=$((300 * U));  BOB_CAP=$((200 * U))
GAS='150.0 Tgas'

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TREASURY_WASM="$ROOT/target/near/treasury/treasury.wasm"
LOG="${TMPDIR:-/tmp}/orvantra-day5-$(date +%s).log"
KEYFILE="$HOME/.orvantra/keys/$NETWORK/$AGENT.json"
echo "near CLI + agent output -> $LOG"

# Everything `npm run pay` / `prove-key-limits` needs:
export NEAR_NETWORK="$NETWORK" TREASURY_ID="$TREASURY" REGISTRY_ID="$REGISTRY" AGENT_ID="$AGENT" SIM_DEPOSIT_ACCOUNT="$SIM"

# ------------------------------------------------------------------ helpers
step() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
expect() { printf '\033[0;32m   do: %s\n   -> see: %s\033[0m\n' "$1" "$2"; }
view() { near contract call-function as-read-only "$1" "$2" json-args "$3" network-config "$NETWORK" now 2>/dev/null; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
exists() { near account view-account-summary "$1" network-config "$NETWORK" now >/dev/null 2>&1; }
call() { # call SIGNER CONTRACT METHOD JSON DEPOSIT
  echo "### $1 -> $2.$3 $4" >>"$LOG"
  if ! near contract call-function as-transaction "$2" "$3" json-args "$4" prepaid-gas "$GAS" attached-deposit "$5" \
      sign-as "$1" network-config "$NETWORK" sign-with-legacy-keychain send >>"$LOG" 2>&1; then
    echo "   FAILED: $1 -> $2.$3 (last lines of $LOG):" >&2; tail -15 "$LOG" >&2; return 1
  fi
}
ensure_account() {
  if exists "$1"; then echo "   $1 exists (skip)"; else
    echo "   creating $1 via faucet"
    near account create-account sponsor-by-faucet-service "$1" autogenerate-new-keypair \
      save-to-legacy-keychain network-config "$NETWORK" create
  fi
}
balance() { view "$TOKEN" ft_balance_of "{\"account_id\":\"$1\"}" | json 'int(d)'; }
pay() { # pay FIXTURE -> runs the agent with --execute, full output to $LOG, prints the key lines
  echo "### npm run pay -- fixtures/$1 --execute" >>"$LOG"
  (cd "$ROOT/agent" && npm run --silent pay -- "fixtures/$1" --execute) 2>&1 | tee -a "$LOG" |
    grep -E '^(DECISION|path:|=== Result|  reason:|  amount|tx |  https|REJECTED|Already proposed|STOP|!! SIMULATED|  signature|  The OWNER|  - )' || true
}

[[ -f "$TREASURY_WASM" ]] || { echo "Build first: (cd contracts/treasury && cargo near build non-reproducible-wasm)"; exit 1; }

# ================================================================== 1. accounts
step "1. Accounts"
ensure_account "$TREASURY"   # (SIM is an implicit account id: it needs no creation to hold tUSDC)
for a in "$OWNER" "$AGENT" "$TOKEN" "$REGISTRY" "$ACME" "$BOB"; do
  exists "$a" || { echo "   missing $a (create it first, see docs/DEPLOYMENTS.md)"; exit 1; }
done
expect "near account view-account-summary $TREASURY network-config testnet now" "account exists with ~10 NEAR (pays payout storage deposits)"

# ================================================================== 2. deploy new treasury
step "2. Deploy the Day 5 treasury to $TREASURY"
if view "$TREASURY" get_config '{}' >/dev/null; then
  echo "   already deployed+initialised (skip)"
else
  near contract deploy "$TREASURY" use-file "$TREASURY_WASM" \
    with-init-call new json-args "{\"owner\":\"$OWNER\",\"agent\":\"$AGENT\",\"registry\":\"$REGISTRY\",\"token\":\"$TOKEN\",\"auto_pay_threshold\":\"$AUTO_PAY_THRESHOLD\",\"monthly_cap\":\"$MONTHLY_CAP\",\"min_payout_age_sec\":$MIN_PAYOUT_AGE_SEC,\"storage_deposit\":\"$STORAGE_DEPOSIT_YOCTO\",\"cross_chain_auto_pay_threshold\":\"0\",\"max_open_payments\":25,\"near_reserve\":\"500000000000000000000000\"}" \
    prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
    network-config "$NETWORK" sign-with-legacy-keychain send
fi
view "$TREASURY" get_config '{}'
expect "view $TREASURY get_config" "owner=$OWNER agent=$AGENT storage_deposit=\"$STORAGE_DEPOSIT_YOCTO\" payment_count=0 cross_chain_auto_pay_threshold=\"0\" max_open_payments=25 available_near > near_reserve (0.5 NEAR)"

# ================================================================== 3. token registration + funding
step "3. Register $TREASURY (+ $SIM) on $TOKEN, fund the treasury with 500 tUSDC"
regs=("$TREASURY"); [[ "$REGISTER_SIM_ON_TOKEN" == 1 ]] && regs+=("$SIM")
for a in "${regs[@]}"; do
  if [[ "$(view "$TOKEN" storage_balance_of "{\"account_id\":\"$a\"}")" == "null" ]]; then
    call "$OWNER" "$TOKEN" storage_deposit "{\"account_id\":\"$a\",\"registration_only\":true}" '0.00125 NEAR'
    echo "   registered $a"
  else echo "   $a already registered (skip)"; fi
done
have="$(balance "$TREASURY")"
if (( have < FUND )); then
  call "$OWNER" "$TOKEN" ft_transfer_call "{\"receiver_id\":\"$TREASURY\",\"amount\":\"$((FUND - have))\",\"msg\":\"\"}" '1 yoctoNEAR'
fi
echo "   treasury balance: $(balance "$TREASURY")"
expect "view $TOKEN ft_balance_of {\"account_id\":\"$TREASURY\"}" "\"$FUND\" or more"

# ================================================================== 4. vendor policies
step "4. Owner approves the vendors (per-invoice max + monthly cap)"
call "$OWNER" "$TREASURY" set_vendor_policy "{\"vendor\":\"$ACME\",\"max_per_invoice\":\"$ACME_MAX\",\"monthly_cap\":\"$ACME_CAP\"}" '1 yoctoNEAR'
call "$OWNER" "$TREASURY" set_vendor_policy "{\"vendor\":\"$BOB\",\"max_per_invoice\":\"$BOB_MAX\",\"monthly_cap\":\"$BOB_CAP\"}" '1 yoctoNEAR'
view "$REGISTRY" get_vendor "{\"account_id\":\"$ACME\"}" | json '"   registry %s: %s on %s v%s" % (d["account_id"], d["payout"]["address"], d["payout"]["chain"], d["version"])'
view "$REGISTRY" get_vendor "{\"account_id\":\"$BOB\"}" | json '"   registry %s: %s on %s v%s" % (d["account_id"], d["payout"]["address"], d["payout"]["chain"], d["version"])'
expect "view $TREASURY get_vendor_policy {\"vendor\":\"$BOB\"}" "{\"max_per_invoice\":\"$BOB_MAX\",\"monthly_cap\":\"$BOB_CAP\"}"

# ================================================================== 5. restricted agent key
step "5. Agent key: generated locally, added on-chain as a FUNCTION-CALL key (propose_payment only)"
if [[ -f "$KEYFILE" ]]; then
  echo "   $KEYFILE exists (skip generation)"
  echo "   (re-print the add-key command: cd agent && npm run setup-agent-key -- --account $AGENT --contract $TREASURY --network $NETWORK --force   # makes a NEW key)"
else
  (cd "$ROOT/agent" && npm run --silent setup-agent-key -- --account "$AGENT" --contract "$TREASURY" --network "$NETWORK")
fi
PUB="$(python3 -c "import json; print(json.load(open('$KEYFILE'))['public_key'])")"
if near account list-keys "$AGENT" network-config "$NETWORK" now 2>/dev/null | grep -q "${PUB#ed25519:}"; then
  echo "   $PUB is already on $AGENT (skip)"
else
  echo "   Add the key (signed by $AGENT's full-access key in your keychain):"
  echo
  echo "near account add-key $AGENT grant-function-call-access --allowance '0.25 NEAR' \\"
  echo "  --contract-account-id $TREASURY --function-names 'propose_payment' \\"
  echo "  use-manually-provided-public-key $PUB network-config $NETWORK sign-with-legacy-keychain send"
  echo
  read -r -p "   Run it in another terminal, then press Enter to continue (Ctrl-C to stop) " _
fi
expect "near account list-keys $AGENT network-config testnet now" \
  "$PUB  function call: receiver $TREASURY, methods [propose_payment], allowance 0.25 NEAR"

# ================================================================== 6. warm-up: first payment to Bob
step "6. Warm-up: the contract holds the FIRST payment to any vendor, so Bob gets one owner-approved payment first"
pay 02-bob-normal.pdf
pid="$(view "$TREASURY" get_pending '{}' | json "next((p['id'] for p in d if p['vendor']=='$BOB'), '')")"
if [[ -n "$pid" ]]; then
  call "$OWNER" "$TREASURY" approve_payment "{\"id\":$pid}" '1 yoctoNEAR'
  view "$TREASURY" get_payment "{\"id\":$pid}" | json '"   payment #%s %s -> %s direct=%s reasons=%s" % (d["id"], d["status"], d["destination"], d["direct"], d["reasons"])'
fi
expect "pay 02-bob-normal.pdf --execute, then owner approve_payment" \
  "Pending ('first payment to this vendor') -> approved -> Paid; storage_deposit(bob) refunded (already registered), then ft_transfer"

# ================================================================== 7. the four demo invoices
step "7a. 03-bob-small.png: 12.50 tUSDC, known vendor, under threshold -> paid automatically, DIRECT"
before="$(balance "$BOB")"
pay 03-bob-small.png
echo "   $BOB balance: $before -> $(balance "$BOB")"
expect "npm run pay -- fixtures/03-bob-small.png --execute" "path: DIRECT; Result: payment #N is PAID; Bob +12500000"

step "7b. 01-acme-normal.png: 120 tUSDC to Acme (USDC on Base) -> SIMULATED 1Click, held by the CONTRACT"
pay 01-acme-normal.png
expect "npm run pay -- fixtures/01-acme-normal.png --execute" \
  "dry mainnet quote signature VALID; !! SIMULATED banner; PENDING: 'amount above auto-pay threshold', 'first payment to this vendor', 'cross-chain payout: owner confirms the 1Click deposit address'"

step "7c. 04-acme-changed-bank.png: invoice says 'pay 0x9999…' -> ignored; agent flags it, contract holds it"
pay 04-acme-changed-bank.png
expect "npm run pay -- fixtures/04-acme-changed-bank.png --execute" \
  "destination still the registry payout; PENDING with reasons 'agent: invoice asks to pay a different address — ignored; …'"

step "7d. 05-acme-duplicate.png: same invoice as 01 in another template -> rejected, nothing sent"
pay 05-acme-duplicate.png
expect "npm run pay -- fixtures/05-acme-duplicate.png --execute" \
  "REJECTED by the agent — 'invoice_hash already used in the treasury (duplicate invoice)'; no transaction"

# ================================================================== 8. key limits
step "8. Prove the agent key can't do anything else"
(cd "$ROOT/agent" && npm run --silent prove-key-limits) 2>&1 | tee -a "$LOG" || true
expect "npm run prove-key-limits" "4/4 PASS: set_limits, withdraw, token ft_transfer, NEAR transfer all refused by the network"

step "Done. Inspect:"
echo "   near contract call-function as-read-only $TREASURY get_payments json-args '{}' network-config testnet now"
echo "   near contract call-function as-read-only $TREASURY get_pending json-args '{}' network-config testnet now"
echo "   Explorer: https://testnet.nearblocks.io/address/$TREASURY     Agent ledger: agent/data/ledger.json"
echo "   Optional: approve the held Acme payment as the owner -> tUSDC goes to $SIM (simulated deposit):"
echo "     near contract call-function as-transaction $TREASURY approve_payment json-args '{\"id\":<id>}' prepaid-gas '150.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as $OWNER network-config testnet sign-with-legacy-keychain send"
