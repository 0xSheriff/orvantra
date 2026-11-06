# Orvantra agent — invoice reader, checks, 1Click quotes, on-chain proposals

Reads an invoice (PNG, JPEG or PDF) with **two independent AI models, both running in TEEs on NEAR AI Cloud**,
verifies each model's signed response, compares the two readings, looks up the vendor in the on-chain
**vendor registry** and the owner's **treasury policy**, and decides: `propose`, `hold` or `reject` (Day 4).

`npm run pay` (Day 5) then turns a `propose`/`hold` into a `treasury.propose_payment` transaction signed with a
**function-call key that can only call `propose_payment`** — see [Paying (Day 5)](#paying-day-5). `npm run analyze`
stays read-only.

```
invoice.pdf/png ──► reader A: Qwen/Qwen3-VL-30B-A3B-Instruct ─┐  (NEAR AI Cloud, TEE, E2EE,
                └─► reader B: z-ai/glm-5.3-flash ─────────────┤   response signature verified)
                                                              ▼
                     normalize (amounts → 6-decimal base units, dates → ISO, accounts → lowercase)
                                                              ▼
                     compare critical fields: vendor account, invoice number, total, currency, due date
                                                              ▼
       NEAR views (testnet): registry.get_vendor / payout_age_ns, treasury.get_vendor_policy /
                             is_invoice_used / get_config / get_payments / monthly_spent
                                                              ▼
                     checks (pure) ──► { action, reasons, invoice_hash, amount, payout (from REGISTRY) }
```

## Why two readers
A single model can misread an invoice and nobody notices. While choosing models we ran one invoice with a
total of **1,200.00** through several NEAR AI models: `moonshotai/kimi-k2.6` read it as **200**, and
`Qwen/Qwen3.8-27B` returned garbled fields under the strict schema. The two models used here come from different
families (Qwen and GLM) and both read it correctly. When the readers disagree on any critical field, the
invoice is **held** for a human. One model's mistake can't become a payment unless the other model makes
the same mistake.

## Privacy
- Invoice images are sent **only to NEAR AI Cloud**: no other AI service, no OCR service, no logging service.
  (Fortytwo is not used by the agent. It can optionally write synthetic fixture text, and never sees a real invoice.)
- Both readers run on attested TEE deployments. The SDK (`@nearai/inference-sdk`) verifies the gateway and model
  attestation **before** sending the invoice, and encrypts the message content (including the image) to the
  attested model key (**E2EE**). E2EE with image content works for both readers (eval: `e2ee=on` for all 14
  readings). If E2EE fails for a model, the agent retries without it and records the reason in the receipt
  (`e2ee_fallback_reason`). `NEARAI_E2EE=0` forces plaintext mode (signatures are still verified); this switch
  has not been exercised in the eval.
- After each answer, `verifyResponse(id)` checks the response signature against the exact request and response
  bytes. The receipt records `signature_kind` (`provider_tee` = signed inside the model TEE). **If verification
  fails or is unavailable, the reading is marked unverified and the decision is `hold`**. The agent never claims
  a reading is verified when it is not.
- The `.env` file is read at runtime only (`dotenv`) and its values are never printed.

## Setup
```bash
cd agent
nvm use            # Node 24 (.nvmrc); @nearai/inference-sdk needs Node >= 24.22.1
npm ci
# repo-root .env must contain NEARAI_API_KEY=...   (never commit it)
```

Optional environment variables: `NEAR_NETWORK` (default `testnet`), `NEAR_RPC_URLS` (comma-separated, tried
with failover; default testnet `https://test.rpc.fastnear.com,https://rpc.testnet.near.org`, mainnet
`https://free.rpc.fastnear.com,https://rpc.mainnet.near.org`; legacy single `NEAR_RPC_URL` also accepted),
`NEAR_VIEW_CACHE_MS` (identical view calls within this window share one request, default `30000`, `0` disables), `REGISTRY_ID` (default `orvantra-registry.testnet`), `TREASURY_ID`
(default `orvantra-treasury.testnet`), `READER_A_MODEL`, `READER_B_MODEL`, `NEARAI_E2EE=0`.

## Commands
| Command | What it does | Network |
|---|---|---|
| `npm test` | Unit tests for normalize, compare, hash, checks, request parsing | none |
| `npm run typecheck` | `tsc --noEmit` | none |
| `npm run analyze -- <file>` | Report + JSON for one invoice | NEAR AI Cloud + NEAR RPC (read-only) |
| `npm run eval` | All fixtures through the real readers, prints a PASS/FAIL table, writes `eval-results.json` | same |
| `npm run fixtures` | Regenerates `fixtures/*.png/pdf` (pdfkit; PNGs rasterized by pdfjs, no system fonts needed) | none |
| `npm run chain-state` | Prints registry/treasury state the checks depend on | NEAR RPC (read-only) |
| `npm run pay -- <file> [--execute]` | Day 5 pipeline; default **dry run** prints exactly what would be sent | + 1Click (+ NEAR tx with `--execute`) |
| `npm run setup-agent-key -- --account <agent> --contract <treasury> [--network testnet]` | New ed25519 key in `~/.orvantra/keys/<network>/<account>.json` (mode 600) + the add-key command | none |
| `npm run prove-key-limits` | Tries `set_limits`, `withdraw`, token `ft_transfer`, NEAR transfer with the agent key; prints a PASS table | NEAR tx (all refused) |
| `npm run quote -- [--recipient 0x… --dest <asset> --amount <units>]` | One **dry** 1Click quote, signature + validation | 1Click |
| `npm run oneclick-status -- <depositAddress> [--tx <hash> --sender <acct>]` | Submit a deposit tx and poll 1Click until terminal | 1Click |

## Do X → see Y
| Do | See |
|---|---|
| `npm run analyze -- fixtures/01-acme-normal.png` | Both readings side by side, `readers AGREE`, both `VERIFIED (provider_tee)`, e2ee=on, `DECISION: PROPOSE`, payout `0x3333…` on Base **from the registry**, and `[contract] will be held by contract: …first payment` |
| `npm run analyze -- fixtures/04-acme-changed-bank.png` | `DECISION: HOLD` — "invoice asks to pay a different address — ignored; registry is the source of truth (invoice says: 0x9999…)". Payout is still `0x3333…` |
| `npm run analyze -- fixtures/02-bob-normal.pdf` | PDF rendered to an image; `HOLD`: 45.00 is more than 3x Bob's median paid amount (10.00); `[contract] would reject: vendor monthly cap` |
| `npm run analyze -- fixtures/07-unknown-vendor.png` | `REJECT`: not in the vendor registry, not approved in the treasury policy |
| `npm run analyze -- fixtures/_probe_acme.png` | `REJECT`: 1200.00 is above the vendor max_per_invoice 300.00 |
| `npm run eval` | `7/7 PASS` table (see `fixtures/EXPECTED.md`); #05 is rejected as a duplicate of #01 with the same `invoice_hash` |

## Decision rules (`src/checks.ts`, pure and unit-tested)
**reject**: no vendor NEAR account on the invoice (or invalid id) · vendor not in the registry · vendor not approved
in the treasury policy · `invoice_hash` already used on-chain (or earlier in the same batch) · currency not USDC/USD ·
total ≤ 0 · amount > vendor `max_per_invoice`.

**hold**: readers disagree on a critical field · a reader's response could not be verified · the invoice's
payment text names an address that is not the registry payout (or contains bank details) · line items don't sum to
the total (or a line is unreadable) · amount > 3× the vendor's median **Paid** amount · total/invoice number unreadable ·
NEAR state could not be read.

**notes** (don't change the action): due date passed or unreadable · no line items · no paid history.

**contract predictions** (the treasury enforces these on-chain; the agent only reports them): over the auto-pay
threshold → Pending · payout changed less than `min_payout_age_sec` ago → Pending · first payment to the vendor →
Pending · vendor/treasury monthly cap would be exceeded → contract rejects · treasury paused.

**Payout** always comes from the registry (`chain`, `asset_id`, `address`, `version`). The invoice never supplies it.

**invoice_hash** = `sha256_hex("<vendor_account>|<invoice_number_normalized>|<amount_base_units>|<currency>")`.
Account is lowercased, invoice number uppercased without whitespace or a leading `#`/`No.`, amount in 6-decimal
base units, and `USD` is hashed as `USDC` (the settlement currency). Re-sending the same invoice in a different
template gives the same hash.

### Amount parsing
`1,200.00`, `$1200`, `USDC 120.5`, `1.200,00`, `1 200,00` → base units. If both `,` and `.` appear, the last one is
the decimal separator. A single `,` followed by 1–2 digits is a decimal comma, and followed by 3 digits it is a
thousands separator. A single `.` is always a decimal point (`1.200` = 1.2). Anything ambiguous or malformed
returns null and leads to a hold.

## Paying (Day 5)

```
analyze (Day 4) ──reject──► stop, nothing sent
   │ propose / hold (hold reasons become agent_flags)
   ▼
path = registry payout.chain == "near" && payout.asset_id == "nep141:<treasury token>" ? DIRECT : 1CLICK
   │ DIRECT: no quote; the treasury pays the registry address itself
   │ 1CLICK mainnet: real quote ─► verify signature + strict validation ─► deposit_address = quote.depositAddress
   │ 1CLICK testnet: DRY mainnet quote (price + signature only) ─► deposit_address = SIM_DEPOSIT_ACCOUNT
   ▼                 "SIMULATED 1Click deposit — testnet has no NEAR Intents"
treasury.propose_payment(invoice_hash, vendor, amount, payout_version, deposit_address, quote_hash, memo, agent_flags)
   signed with the FUNCTION-CALL key ─► read back the payment: Paid / Pending (reasons) / Rejected + explorer link
   ▼ mainnet 1Click + Paid
1Click /deposit/submit (tx hash) ─► poll /status until SUCCESS / REFUNDED / FAILED
```

**The agent never decides that money moves.** The contract decides (policy + registry), and anything held waits for
the owner's own wallet. The agent can only add `agent_flags`, which make the contract hold a payment, never pay it.

### The agent key
`npm run setup-agent-key -- --account orvantra-agent.testnet --contract orvantra-treasury-v2.testnet` writes a new
ed25519 key to `~/.orvantra/keys/testnet/orvantra-agent.testnet.json` (dir 700, file 600, outside the repo; the
private key is never printed) and prints:
```
near account add-key orvantra-agent.testnet \
  grant-function-call-access --allowance '0.25 NEAR' \
  --contract-account-id orvantra-treasury-v2.testnet --function-names 'propose_payment' \
  use-manually-provided-public-key ed25519:… \
  network-config testnet sign-with-legacy-keychain send
```
Before every `--execute`, `pay` reads the key's permission on-chain and **refuses to sign** unless it is a
function-call key for the treasury with exactly `[propose_payment]` (a full-access key is rejected). It also refuses a
key file readable by other users. `npm run prove-key-limits` signs four forbidden transactions with that key; each is
refused by the network (`MethodNameMismatch`, `DepositWithFunctionCall`, `ReceiverMismatch`, `RequiresFullAccess`).
At 150 TGas per proposal, the 0.25 NEAR allowance covers roughly 15 proposals; add a new key when it runs out.

### 1Click quote validation (`src/oneclick.ts`, unit-tested with a real signed quote)
The treasury pays the quote's `depositAddress` and cannot verify on-chain what 1Click will do with it, so every field
that decides where money goes is checked against the treasury config and the **registry** (never the invoice):
`verifyQuoteSignature` (1Click manager key) over the signed payload · `originAsset` = `nep141:<treasury token>` ·
`destinationAsset` = registry `payout.asset_id` · `recipient` = registry `payout.address` · `amount` and
`quote.amountIn` = invoice amount (`EXACT_INPUT`) · `refundTo` = treasury · `depositType`/`refundType` = `ORIGIN_CHAIN`,
`recipientType` = `DESTINATION_CHAIN` · request deadline (and quote deadline) in the future · real quotes:
`depositAddress` present, a NEAR account id, no `depositMemo` · no `customRecipientMsg` / virtual-chain recipients ·
USD out ≥ 97% of USD in. `quote_hash` stored on-chain = the SDK's `quoteHash` = base58(sha256(signed payload)), the
exact message 1Click signed, so anyone can re-verify the stored quote.

**Finding (2026-11-06):** an `ORIGIN_CHAIN` quote whose `refundTo` is not an existing **mainnet** account gets an opaque
`HTTP 400 Internal server error`. The testnet treasury does not exist on mainnet, so the simulated path uses
`SIM_QUOTE_REFUND_TO` (default `intents.near`) as refundTo of the dry quote. Dry quotes move no funds.

### Environment (Day 5)
`TREASURY_ID` (use `orvantra-treasury-v2.testnet` for the Day 5 contract), `AGENT_ID` (default: the treasury's
configured agent), `SIM_DEPOSIT_ACCOUNT` (default `orvantra-1click-sim.testnet`), `SIM_QUOTE_REFUND_TO`
(default `intents.near`), `PROPOSE_GAS_TGAS` (default 150), `ONECLICK_JWT` (optional, never printed),
`ONECLICK_BASE`, `ORVANTRA_KEYS_DIR`, `ORVANTRA_LEDGER` (default `agent/data/ledger.json`, gitignored).

### Ledger
`agent/data/ledger.json`: `invoice_hash → { file, network, treasury, vendor, amount, decision, path, agent_flags,
quote (summary, quote_hash, simulated), deposit_address, payment_id, tx_hash, statuses[] }`. `pay --execute`
refuses to send an invoice that the ledger already shows as sent to the same treasury (the contract would reject
the duplicate hash anyway; this saves the key's allowance).

### Do X → see Y (testnet, after `scripts/testnet-day5.sh` setup)
| Do | See |
|---|---|
| `npm run pay -- fixtures/03-bob-small.png` | `path: DIRECT`, the exact `propose_payment` JSON, `DRY RUN — nothing was signed or sent` |
| `… 03-bob-small.png --execute` | tx link, `Result: payment #N is PAID`, destination `orvantra-bob.testnet` (direct) |
| `… 01-acme-normal.png --execute` | dry mainnet quote `signature VALID`, `!! SIMULATED 1Click deposit` banner, `PENDING`: above threshold + first payment |
| `… 04-acme-changed-bank.png --execute` | `PENDING` with `agent: invoice asks to pay a different address — ignored; …` |
| `… 05-acme-duplicate.png --execute` | `REJECTED by the agent — invoice_hash already used …`, no transaction |
| `npm run prove-key-limits` | 4/4 PASS table |

## Files
- `src/extract.ts`: page loading (PDF → PNG via pdf-to-img/pdfjs), prompt, strict JSON schema, readers, receipts.
- `src/normalize.ts`, `src/compare.ts`, `src/hash.ts`, `src/checks.ts`: pure logic.
- `src/near.ts`: JSON-RPC views + generic `rpc()` with failover/backoff (plain `fetch`, sends a User-Agent).
- `src/analyze.ts`: pipeline. `src/report.ts`: text report. `src/cli.ts` / `src/eval.ts`: entry points.
- Day 5: `src/pay.ts` (CLI), `src/plan.ts` (pure: path, quote expectation, flags, args, preflight),
  `src/oneclick.ts` (1Click client + strict validation), `src/keys.ts` (agent key file + permission check),
  `src/tx.ts` (sign/send with `@near-js/*`, outcome parsing), `src/ledger.ts`;
  `scripts/setup-agent-key.ts`, `scripts/prove-key-limits.ts`, `scripts/quote.ts`, `scripts/oneclick-status.ts`.
- `test/data/dry-quote-base.json`: a real signed dry quote (120 USDC NEAR → USDC Base) used by the offline tests.
- `scripts/make-fixtures.ts`: fixture generator. `fixtures/EXPECTED.md`: expected decisions.

## Known limits
- The two readers are prompted the same way; a misleading invoice could fool both in the same way. The
  registry-only payout and the contract caps limit what that can cost.
- The payment-text scan uses patterns (EVM, NEAR, base58, bech32, IBAN/bank words). It is meant to catch redirect
  attempts and may hold some harmless invoices.
- Testnet cross-chain payouts are **simulated**: tUSDC goes to `orvantra-1click-sim.testnet`, not into NEAR Intents.
  Only the price + signature of the (dry, mainnet) quote are real. Real deposit addresses come from mainnet quotes.
- A mainnet payment that waits for the owner keeps the quote's deposit address; if the owner approves after the
  quote deadline, 1Click refunds the deposit to the treasury. Track it with `npm run oneclick-status`.
- `npm audit` reports a low-severity advisory in `elliptic`, which `@nearai/inference-sdk` pulls in through
  `@phala/dcap-qvl`. No fix is available yet.
