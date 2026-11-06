# Orvantra agent — invoice reader + checks (Day 4)

Reads an invoice (PNG, JPEG or PDF) with **two independent AI models, both running in TEEs on NEAR AI Cloud**,
verifies each model's signed response, compares the two readings, looks up the vendor in the on-chain
**vendor registry** and the owner's **treasury policy**, and decides: `propose`, `hold` or `reject`.

Day 4 is **read-only**: nothing is written on-chain. The decision is what the agent *would* send to
`treasury.propose_payment`.

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

Optional environment variables: `NEAR_NETWORK` (default `testnet`), `NEAR_RPC_URL` (default
`https://rpc.<network>.near.org`), `REGISTRY_ID` (default `orvantra-registry.testnet`), `TREASURY_ID`
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

## Files
- `src/extract.ts`: page loading (PDF → PNG via pdf-to-img/pdfjs), prompt, strict JSON schema, readers, receipts.
- `src/normalize.ts`, `src/compare.ts`, `src/hash.ts`, `src/checks.ts`: pure logic.
- `src/near.ts`: read-only JSON-RPC views (plain `fetch`, sends a User-Agent).
- `src/analyze.ts`: pipeline. `src/report.ts`: text report. `src/cli.ts` / `src/eval.ts`: entry points.
- `scripts/make-fixtures.ts`: fixture generator. `fixtures/EXPECTED.md`: expected decisions.

## Known limits
- The two readers are prompted the same way; a misleading invoice could fool both in the same way. The
  registry-only payout and the contract caps limit what that can cost.
- The payment-text scan uses patterns (EVM, NEAR, base58, bech32, IBAN/bank words). It is meant to catch redirect
  attempts and may hold some harmless invoices.
- `npm audit` reports a low-severity advisory in `elliptic`, which `@nearai/inference-sdk` pulls in through
  `@phala/dcap-qvl`. No fix is available yet.
