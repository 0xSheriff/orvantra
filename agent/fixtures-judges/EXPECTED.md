# Expected decisions for the judges' test invoices

These 10 invoices are **fresh**: three vendors you have never seen on the All invoices page — **NovaTech Labs**
(`orvantra-novatech.testnet`), **GreenLeaf Co** (`orvantra-greenleaf.testnet`) and **PixelWorks Studio**
(`orvantra-pixelworks.testnet`) — with invoice numbers and amounts that have never been proposed on any treasury.
Nothing in this zip has been processed, demoed or burnt before you open it. They are separate from the 14
invoices on the All invoices page (the original Acme / Bob set, plus the ten Harbor & Oak, Cloudline and
Meridian invoices).

All vendors are registered in the vendor registry with their **own** payout details (tUSDC on NEAR, to their own
account), and the owner has approved each in the treasury policy (max_per_invoice 300, monthly_cap 600).
Verified against the live treasury `orvantra-treasury-v6.testnet` on 2026-11-12: every invoice below analyzes
to **propose** — the agent finds nothing wrong with any of them.

Because no vendor in this set has ever been paid, the contract's own rules hold every one of them:

- `first payment to this vendor` — applies to all 10. The contract never auto-pays a vendor's first invoice.
- `amount above auto-pay threshold 100.00 USDC` — applies to #03, #05, #08, #10 (the four over $100).

So the expected live flow for **every** file is: the agent reads both TEE models, passes all checks, proposes;
the treasury proposes the payment and **holds it in Pending** for the owner to approve in their wallet.
Nothing in this zip auto-executes on its own.

| # | File | Invoice | Expected | Why |
|---|------|---------|----------|-----|
| 1 | `01-novatech-retainer.png` | NovaTech Labs, NT-2026-031, **60.00 USDC** | **propose** (held: first payment) | Clean. Owner approves → first payment to NovaTech settles tUSDC on NEAR. |
| 2 | `02-novatech-pipeline.png` | NovaTech Labs, NT-2026-032, **85.00 USDC** | **propose** (held: first payment) | Clean. |
| 3 | `03-novatech-saas.png` | NovaTech Labs, NT-2026-033, 96 + 24 = **120.00 USDC** | **propose** (held: over 100 threshold + first payment) | Two line items, sum correct. Over the auto-pay threshold, so it needs the owner. |
| 4 | `04-greenleaf-landscaping.png` | GreenLeaf Co, GL-2026-051, **48.00 USDC** | **propose** (held: first payment) | Clean. |
| 5 | `05-greenleaf-irrigation.png` | GreenLeaf Co, GL-2026-052, **150.00 USDC** | **propose** (held: over 100 threshold + first payment) | Largest GreenLeaf invoice; within the 300 per-invoice cap. |
| 6 | `06-greenleaf-pruning.png` | GreenLeaf Co, GL-2026-053, **35.00 USDC** | **propose** (held: first payment) | Clean, smallest in the set. |
| 7 | `07-pixelworks-icons.png` | PixelWorks Studio, PW-2026-071, **64.00 USDC** | **propose** (held: first payment) | Clean. |
| 8 | `08-pixelworks-brand.png` | PixelWorks Studio, PW-2026-072, **180.00 USDC** | **propose** (held: over 100 threshold + first payment) | Clean. |
| 9 | `09-pixelworks-mockups.png` | PixelWorks Studio, PW-2026-073, **95.00 USDC** | **propose** (held: first payment) | Clean; just under the threshold. |
| 10 | `10-novatech-audit.png` | NovaTech Labs, NT-2026-034, **250.00 USDC** | **propose** (held: over 100 threshold + first payment) | Largest in the set; still within NovaTech's 300 cap. |

**One-shot, by design.** The treasury burns each `invoice_hash` the moment a payment is proposed for it — the
same dedupe guard that protects against double-paying a real invoice. So if a file in this zip has already been
proposed (by you or someone else), re-uploading it is a working demo of that guard: the agent will **reject** it
with `invoice_hash already used in the treasury`. The first upload of each file gives the full happy path above.

**What to try in order (one file each is enough):**
1. `01-novatech-retainer.png` — small, under threshold: agent proposes, contract holds it as NovaTech's first
   payment, the owner approves in their wallet, and the money settles to the vendor's own NEAR account.
2. `05-greenleaf-irrigation.png` — over threshold: same path, and the Pending entry shows both hold reasons
   (over 100 + first payment).
3. Upload `01-novatech-retainer.png` again — the duplicate guard rejects it.
