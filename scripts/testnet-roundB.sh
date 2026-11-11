#!/usr/bin/env bash
# Orvantra Round B (v6.2): the treasury contract and the agent REFUSING things, live on testnet, on the existing
# v6 treasury. Five demos, each one rule: payout-age hold (agent prediction), vendor monthly cap, treasury monthly
# cap, pause (all three refused by the contract itself), and policy removal (agent rejection).
#
# TESTNET ONLY. Signs with keys from ~/.near-credentials/testnet (owner, acme) and the agent's restricted
# FUNCTION-CALL key (~/.orvantra/keys/testnet/<agent>.json, propose_payment only). Every on-chain change is
# restored before the script exits (also on failure: see the trap), and a refused proposal creates nothing,
# so the payments list is the same before and after. Prints a PASS/FAIL table; exit code 1 on any FAIL.
#
# Prereqs: cd agent && npm ci; NEARAI_API_KEY in the repo-root .env (two one-file analyses); python3; near CLI.
set -euo pipefail
source "$HOME/.cargo/env" 2>/dev/null || true
export NVM_DIR="$HOME/.nvm"; [[ -s "$NVM_DIR/nvm.sh" ]] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true

# ------------------------------------------------------------------ accounts
NETWORK=testnet
OWNER=${OWNER:-orvantra.testnet}
AGENT=${AGENT:-orvantra-agent.testnet}
TREASURY=${TREASURY:-orvantra-treasury-v6.testnet}
REGISTRY=${REGISTRY:-orvantra-registry.testnet}
ACME=${ACME:-orvantra-acme.testnet}
BOB=${BOB:-orvantra-bob.testnet}

# ------------------------------------------------------------------ baseline (restored at the end)
U=1000000
AUTO_PAY=$((100 * U)); CAP=$((1000 * U)); MIN_AGE=120
BOB_MAX=$((300 * U)); BOB_CAP=$((200 * U))
ACME_NAME='Acme Design'
ACME_ASSET='nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near'
ACME_ADDR=0x3333333333333333333333333333333333333333
ACME_ADDR_TMP=0x3333333333333333333333333333333333333334   # one digit off: the registry bumps the payout version
GAS='150.0 Tgas'
RUN_ID="$(date +%s)"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="${TMPDIR:-/tmp}/orvantra-roundB-$RUN_ID.log"
echo "near CLI + agent output -> $LOG"
export NEAR_NETWORK="$NETWORK" TREASURY_ID="$TREASURY" REGISTRY_ID="$REGISTRY" AGENT_ID="$AGENT"

# ------------------------------------------------------------------ helpers
step() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
expect() { printf '\033[0;32m   do: %s\n   -> see: %s\033[0m\n' "$1" "$2"; }
view() { near contract call-function as-read-only "$1" "$2" json-args "$3" network-config "$NETWORK" now 2>/dev/null; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
TX=''
call() { # call SIGNER CONTRACT METHOD JSON DEPOSIT  -> sets TX to the transaction hash
  local out
  echo "### $1 -> $2.$3 $4" >>"$LOG"
  if ! out="$(near contract call-function as-transaction "$2" "$3" json-args "$4" prepaid-gas "$GAS" attached-deposit "$5" \
      sign-as "$1" network-config "$NETWORK" sign-with-legacy-keychain send 2>&1)"; then
    echo "$out" >>"$LOG"; echo "   FAILED: $1 -> $2.$3 (tail of $LOG):" >&2; tail -15 "$LOG" >&2; return 1
  fi
  echo "$out" >>"$LOG"
  TX="$(grep -oE 'Transaction ID: [1-9A-HJ-NP-Za-km-z]+' <<<"$out" | head -1 | awk '{print $3}' || true)"
  [[ -n "$TX" ]] || TX="$(grep -oE 'txns/[1-9A-HJ-NP-Za-km-z]+' <<<"$out" | head -1 | cut -d/ -f2 || true)"
  echo "   tx $1 -> $3: ${TX:-?}  https://testnet.nearblocks.io/txns/${TX:-?}"
}
owner() { call "$OWNER" "$TREASURY" "$1" "$2" '1 yoctoNEAR'; }
propose() { # propose VENDOR AMOUNT MEMO -> PROPOSE_JSON ({tx_hash, explorer_url, failure}); return 1 = refused
  local hash rc=0
  hash="$(printf '%s:%s' "$3" "$RUN_ID" | shasum -a 256 | cut -d' ' -f1)"
  echo "### propose-raw $1 $2 $3 hash=$hash" >>"$LOG"
  PROPOSE_JSON="$(cd "$ROOT/agent" && npm run --silent propose-raw -- --vendor "$1" --amount "$2" --memo "$3" --hash "$hash" 2>>"$LOG")" || rc=$?
  echo "$PROPOSE_JSON" >>"$LOG"
  PROPOSE_TX="$(json 'd.get("tx_hash") or "-"' <<<"$PROPOSE_JSON")"
  PROPOSE_FAIL="$(json 'd.get("failure") or ""' <<<"$PROPOSE_JSON")"
  echo "   tx $AGENT -> propose_payment($1, $2, memo $3): $PROPOSE_TX  https://testnet.nearblocks.io/txns/$PROPOSE_TX"
  return $rc
}
analyze() { # analyze FIXTURE -> ANALYZE_JSON (decision only)
  echo "### analyze fixtures/$1 (TREASURY_ID=$TREASURY)" >>"$LOG"
  ANALYZE_JSON="$(cd "$ROOT/agent" && npm run --silent analyze -- "fixtures/$1" --json-only 2>>"$LOG" | python3 -c '
import json,sys; a=json.load(sys.stdin); d=a["decision"]
print(json.dumps({"action": d["action"], "reasons": d["reasons"], "predictions": d["contract_predictions"]}))')"
  echo "$ANALYZE_JSON" >>"$LOG"
  python3 -c '
import json,sys; d=json.loads(sys.argv[1]); print("   agent decision:", d["action"].upper())
[print("     reason:", r) for r in d["reasons"]]; [print("     [contract]", p) for p in d["predictions"]]' "$ANALYZE_JSON"
}
RESULTS=()
record() { RESULTS+=("$1|$2|$3"); printf '   \033[1m%s: %s\033[0m — %s\n' "$1" "$2" "$3"; }
config_line() { view "$TREASURY" get_config '{}' | json '"auto_pay_threshold=%s monthly_cap=%s min_payout_age_sec=%s paused=%s payment_count=%s" % (d["auto_pay_threshold"], d["monthly_cap"], d["min_payout_age_sec"], d["paused"], d["payment_count"])'; }
policy_line() { view "$TREASURY" get_vendor_policy "{\"vendor\":\"$1\"}" | json '"none" if d is None else "max_per_invoice=%s monthly_cap=%s" % (d["max_per_invoice"], d["monthly_cap"])'; }
registry_line() { view "$REGISTRY" get_vendor "{\"account_id\":\"$1\"}" | json '"%s %s v%s" % (d["display_name"], d["payout"]["address"], d["version"])'; }
payments_count() { view "$TREASURY" get_payments '{}' | json 'len(d)'; }

# ------------------------------------------------------------------ restores (run on exit, whatever happened)
NEED_LIMITS=0 NEED_ACME=0 NEED_BOB_POLICY=0 NEED_UNPAUSE=0
restore_limits() { owner set_limits "{\"auto_pay_threshold\":\"$AUTO_PAY\",\"monthly_cap\":\"$CAP\",\"min_payout_age_sec\":$MIN_AGE}" && NEED_LIMITS=0; }
restore_acme() {
  call "$ACME" "$REGISTRY" set_vendor "{\"display_name\":\"$ACME_NAME\",\"chain\":\"base\",\"asset_id\":\"$ACME_ASSET\",\"address\":\"$ACME_ADDR\"}" '1 yoctoNEAR' && NEED_ACME=0
}
restore_bob_policy() { owner set_vendor_policy "{\"vendor\":\"$BOB\",\"max_per_invoice\":\"$BOB_MAX\",\"monthly_cap\":\"$BOB_CAP\"}" && NEED_BOB_POLICY=0; }
restore_unpause() { owner unpause '{}' && NEED_UNPAUSE=0; }
cleanup() {
  local rc=$?
  set +e
  if (( NEED_LIMITS + NEED_ACME + NEED_BOB_POLICY + NEED_UNPAUSE > 0 )); then
    step "Restoring what a failed step left behind"
    (( NEED_UNPAUSE )) && restore_unpause
    (( NEED_BOB_POLICY )) && restore_bob_policy
    (( NEED_ACME )) && restore_acme
    (( NEED_LIMITS )) && restore_limits
  fi
  exit $rc
}
trap cleanup EXIT

# ================================================================== 0. baseline
step "0. Baseline on $TREASURY (must match the documented live state before anything is touched)"
CFG_BEFORE="$(config_line)"; BOB_BEFORE="$(policy_line "$BOB")"; ACME_POL_BEFORE="$(policy_line "$ACME")"
ACME_REG_BEFORE="$(registry_line "$ACME")"; BOB_REG_BEFORE="$(registry_line "$BOB")"; N_BEFORE="$(payments_count)"
ACME_V_BEFORE="${ACME_REG_BEFORE##*v}"
BOB_SPENT="$(view "$TREASURY" monthly_spent "{\"vendor\":\"$BOB\"}" | json 'int(d)')"
TOTAL_SPENT="$(view "$TREASURY" monthly_spent '{"vendor":null}' | json 'int(d)')"
echo "   config:   $CFG_BEFORE"
echo "   policies: $BOB = $BOB_BEFORE; $ACME = $ACME_POL_BEFORE"
echo "   registry: $ACME = $ACME_REG_BEFORE; $BOB = $BOB_REG_BEFORE"
echo "   payments: $N_BEFORE; monthly_spent bob=$BOB_SPENT total=$TOTAL_SPENT"
[[ "$CFG_BEFORE" == "auto_pay_threshold=$AUTO_PAY monthly_cap=$CAP min_payout_age_sec=$MIN_AGE paused=False"* ]] \
  || { echo "   treasury config is not the documented baseline: stopping before touching anything"; NEED_LIMITS=0; exit 1; }
[[ "$BOB_BEFORE" == "max_per_invoice=$BOB_MAX monthly_cap=$BOB_CAP" ]] || { echo "   Bob's policy is not the baseline: stopping"; exit 1; }
[[ "$ACME_REG_BEFORE" == "$ACME_NAME $ACME_ADDR v"* ]] || { echo "   Acme's registry payout is not the baseline: stopping"; exit 1; }
PROPOSE_AMOUNT=$((10 * U))
(( BOB_SPENT + PROPOSE_AMOUNT > 60 * U )) || { echo "   Bob's monthly spend is too low for B2 (needs > 50.00 committed): stopping"; exit 1; }
(( TOTAL_SPENT + PROPOSE_AMOUNT > 180 * U && TOTAL_SPENT < 180 * U )) || { echo "   total monthly spend does not fit B3 (needs 170.00 < total < 180.00): stopping"; exit 1; }

# ================================================================== B1. payout-age hold (agent prediction)
step "B1. Payout changed recently -> the agent predicts the contract hold (min_payout_age_sec raised to 3600)"
owner set_limits "{\"auto_pay_threshold\":\"$AUTO_PAY\",\"monthly_cap\":\"$CAP\",\"min_payout_age_sec\":3600}"; NEED_LIMITS=1; B1_TX_LIMITS="$TX"
call "$ACME" "$REGISTRY" set_vendor "{\"display_name\":\"$ACME_NAME\",\"chain\":\"base\",\"asset_id\":\"$ACME_ASSET\",\"address\":\"$ACME_ADDR_TMP\"}" '1 yoctoNEAR'; NEED_ACME=1; B1_TX_ACME="$TX"
echo "   registry now: $(registry_line "$ACME")   payout_age_ns: $(view "$REGISTRY" payout_age_ns "{\"account_id\":\"$ACME\"}")"
analyze rb-acme-normal.png
if grep -qF 'payout changed less than 3600s ago' <<<"$ANALYZE_JSON"; then
  record B1 PASS "agent predicts 'will be held by contract: payout changed less than 3600s ago' (set_limits $B1_TX_LIMITS, set_vendor $B1_TX_ACME)"
else record B1 FAIL "no payout-age prediction in: $ANALYZE_JSON"; fi
expect "set_limits(min_payout_age_sec=3600); acme set_vendor(new address); npm run analyze -- fixtures/rb-acme-normal.png" \
  "[contract] will be held by contract: payout changed less than 3600s ago"
restore_acme; B1_TX_ACME_BACK="$TX"
restore_limits; B1_TX_LIMITS_BACK="$TX"
echo "   restored: $(registry_line "$ACME") (version bumped twice: payout changed and changed back); $(config_line)"

# ================================================================== B2. vendor monthly cap (contract)
step "B2. Vendor monthly cap: Bob's cap lowered to 60.00 with $BOB_SPENT already committed -> propose 10.00 is refused"
owner set_vendor_policy "{\"vendor\":\"$BOB\",\"max_per_invoice\":\"$BOB_MAX\",\"monthly_cap\":\"$((60 * U))\"}"; NEED_BOB_POLICY=1; B2_TX_POLICY="$TX"
if propose "$BOB" "$PROPOSE_AMOUNT" RB-01; then record B2 FAIL "proposal was ACCEPTED (payment created) — tx $PROPOSE_TX"
elif grep -qF 'over vendor monthly cap' <<<"$PROPOSE_FAIL"; then record B2 PASS "contract panicked 'over vendor monthly cap' (tx $PROPOSE_TX)"
else record B2 FAIL "refused for another reason: $PROPOSE_FAIL"; fi
echo "   panic: $(python3 -c 'import sys,re; m=re.search(r"Smart contract panicked: [^\"]*", sys.argv[1]); print(m.group(0) if m else sys.argv[1][:200])' "$PROPOSE_FAIL")"
expect "set_vendor_policy(bob, 300, 60); agent propose_payment(bob, 10.00, memo RB-01)" "tx FAILS: Smart contract panicked: over vendor monthly cap"
restore_bob_policy; B2_TX_BACK="$TX"

# ================================================================== B3. treasury monthly cap (contract)
step "B3. Treasury monthly cap lowered to 180.00 with $TOTAL_SPENT committed -> propose 10.00 is refused"
owner set_limits "{\"auto_pay_threshold\":\"$AUTO_PAY\",\"monthly_cap\":\"$((180 * U))\",\"min_payout_age_sec\":$MIN_AGE}"; NEED_LIMITS=1; B3_TX_LIMITS="$TX"
if propose "$BOB" "$PROPOSE_AMOUNT" RB-02; then record B3 FAIL "proposal was ACCEPTED (payment created) — tx $PROPOSE_TX"
elif grep -qF 'over treasury monthly cap' <<<"$PROPOSE_FAIL"; then record B3 PASS "contract panicked 'over treasury monthly cap' (tx $PROPOSE_TX)"
else record B3 FAIL "refused for another reason: $PROPOSE_FAIL"; fi
expect "set_limits(monthly_cap=180); agent propose_payment(bob, 10.00, memo RB-02)" "tx FAILS: Smart contract panicked: over treasury monthly cap"
restore_limits; B3_TX_BACK="$TX"

# ================================================================== B4. pause (contract)
step "B4. Paused treasury -> propose 10.00 is refused"
call "$OWNER" "$TREASURY" pause '{}' '0 NEAR'; NEED_UNPAUSE=1; B4_TX_PAUSE="$TX"   # pause() takes no deposit (safe direction); unpause needs 1 yoctoNEAR
echo "   $(config_line)"
if propose "$BOB" "$PROPOSE_AMOUNT" RB-03; then record B4 FAIL "proposal was ACCEPTED while paused — tx $PROPOSE_TX"
elif grep -qF 'treasury is paused' <<<"$PROPOSE_FAIL"; then record B4 PASS "contract panicked 'treasury is paused' (tx $PROPOSE_TX)"
else record B4 FAIL "refused for another reason: $PROPOSE_FAIL"; fi
expect "pause(); agent propose_payment(bob, 10.00, memo RB-03)" "tx FAILS: Smart contract panicked: treasury is paused"
restore_unpause; B4_TX_UNPAUSE="$TX"

# ================================================================== B5. policy removal (agent)
step "B5. Owner removes Bob's policy -> the agent rejects a clean Bob invoice before anything is signed"
owner remove_vendor_policy "{\"vendor\":\"$BOB\"}"; NEED_BOB_POLICY=1; B5_TX_REMOVE="$TX"
echo "   policy now: $(policy_line "$BOB")"
analyze rb-bob-normal.png
if grep -qF '"action": "reject"' <<<"$ANALYZE_JSON" && grep -qF 'not approved in the treasury policy' <<<"$ANALYZE_JSON"; then
  record B5 PASS "agent REJECT 'vendor $BOB is not approved in the treasury policy' (remove_vendor_policy $B5_TX_REMOVE)"
else record B5 FAIL "unexpected decision: $ANALYZE_JSON"; fi
expect "remove_vendor_policy(bob); npm run analyze -- fixtures/rb-bob-normal.png" "REJECT: vendor orvantra-bob.testnet is not approved in the treasury policy"
restore_bob_policy; B5_TX_BACK="$TX"

# ================================================================== final: everything back
step "Final state (must equal the baseline; refused proposals create no payment)"
CFG_AFTER="$(config_line)"; BOB_AFTER="$(policy_line "$BOB")"; ACME_POL_AFTER="$(policy_line "$ACME")"
ACME_REG_AFTER="$(registry_line "$ACME")"; BOB_REG_AFTER="$(registry_line "$BOB")"; N_AFTER="$(payments_count)"
echo "   config:   $CFG_AFTER"
echo "   policies: $BOB = $BOB_AFTER; $ACME = $ACME_POL_AFTER"
echo "   registry: $ACME = $ACME_REG_AFTER (was $ACME_REG_BEFORE); $BOB = $BOB_REG_AFTER"
echo "   payments: $N_AFTER (was $N_BEFORE)"
ok=1
[[ "$CFG_AFTER" == "$CFG_BEFORE" ]] || ok=0
[[ "$BOB_AFTER" == "$BOB_BEFORE" && "$ACME_POL_AFTER" == "$ACME_POL_BEFORE" ]] || ok=0
[[ "$ACME_REG_AFTER" == "$ACME_NAME $ACME_ADDR v$((ACME_V_BEFORE + 2))" && "$BOB_REG_AFTER" == "$BOB_REG_BEFORE" ]] || ok=0
[[ "$N_AFTER" == "$N_BEFORE" ]] || ok=0
if (( ok )); then record RESTORE PASS "config, both policies and payment count unchanged; Acme registry v$ACME_V_BEFORE -> v$((ACME_V_BEFORE + 2)) (payout changed and changed back)"
else record RESTORE FAIL "state differs from the baseline (see above)"; fi

step "Results"
fails=0
printf '   %-8s %-5s %s\n' step result detail
for r in "${RESULTS[@]}"; do
  IFS='|' read -r s v d <<<"$r"; printf '   %-8s %-5s %s\n' "$s" "$v" "$d"; [[ "$v" == PASS ]] || fails=$((fails + 1))
done
echo
echo "   restore txs: acme set_vendor back $B1_TX_ACME_BACK, set_limits back $B1_TX_LIMITS_BACK / $B3_TX_BACK, bob policy back $B2_TX_BACK / $B5_TX_BACK, unpause $B4_TX_UNPAUSE"
echo "   explorer: https://testnet.nearblocks.io/address/$TREASURY     log: $LOG"
(( fails == 0 )) && echo "   ALL PASS" || { echo "   $fails FAIL"; exit 1; }
