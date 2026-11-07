# Orvantra web — owner app

The owner's side of Orvantra: see what the agent read, why a payment is held, and approve or reject it **in your own
NEAR wallet**. Next.js (App Router, TypeScript), one global stylesheet with the tokens of the approved mockups
(`design/final-review.html`, `design/final-list.html`), fonts via `next/font` (Newsreader, IBM Plex Sans, IBM Plex Mono).

Two public pages sit outside the app (no sidebar), from `design/final-home-v2.html` and `design/final-judges.html`:

| Page | What it shows |
|---|---|
| **Home** `/` | Half/half split: the pitch and three doors (I pay invoices → `/review`, I send invoices → `NEXT_PUBLIC_VENDOR_URL` or the registry on NEAR Blocks, I'm a judge → `/judges`) and "How it works". The line "Live on testnet · N scams stopped, M invoices paid today" is computed on the server from the treasury's `get_payments` (Paid; Rejected) plus ledger invoices the agent rejected before reaching the chain, by day in Africa/Lagos; it falls back to "this week", then "so far", and shows no numbers if the chain can't be read (`lib/live.ts`, cached 30 s). |
| **Get paid** `/register` | Vendor sign-up from `design/final-vendor.html`. Sign in with MyNearWallet, Meteor or HERE, then set your own payout (business name, network, token, address) with `set_vendor` on the registry. Networks mirror the contract's list (`lib/registry.ts`, kept in sync with `contracts/vendor-registry/src/lib.rs` by a test); tokens are USDC, plus USDT where 1Click lists it on that chain, with exact 1Click asset ids from `/v0/tokens` (cached 10 min); on testnet NEAR also offers tUSDC. Address checks mirror the contract. An existing entry is prefilled ("You're registered — version N…"). **Gasless first**: if the wallet implements `signDelegateActions`, the NEP-366 SignedDelegate goes to `/api/relay` and Orvantra's relayer pays; otherwise a normal transaction (the vendor pays a tiny fee). |
| **For judges** `/judges` | Five do-this → see-that steps, the network and treasury id. `/judges/test-invoices.zip` zips `agent/fixtures/0*.{png,pdf}` + `EXPECTED.md` on the fly. |

| Page | What it shows |
|---|---|
| **Needs approval** `/review` | One held payment at a time (`1 of N · Next`). Left: the uploaded invoice (PDFs rendered to PNG) with outlines and numbered pins placed from reader A's boxes (green = verified field, red = finding). Right: a plain-English verdict built from the findings without an LLM (`lib/verdict.ts`), the numbered findings, and the dark **If you approve** panel with Approve / Reject. |
| **All invoices** `/invoices` | Ruled list with All / Held / Paid / Stopped filters: on-chain payments merged with the agent ledger and web uploads (`lib/rows.ts`). A row opens the read-only review screen `/invoices/<key>`. |
| **Vendors** `/vendors` | Approved vendors (treasury policy) joined with their registry entry: payout address and route, version, how long ago it changed, per-invoice limit, spend this month against the cap. |
| **Rules & limits** `/rules` | The treasury config written as sentences ("Pay automatically up to 100.00 tUSDC."). Read-only. |
| **Activity** `/activity` | Reads, proposals, holds, payments and rejections, newest first. |

## How it works
- **Reads** use the agent's own modules through the local package `orvantra-agent` (`file:../agent`): NEAR views
  (`near.ts`), the ledger (`ledger.ts`), upload records (`records.ts`). Loading a page only reads; nothing is written on-chain.
- **Uploads** (`POST /api/upload`) store the file in `agent/data/files/<id>.<ext>`, then start the agent in its own
  Node process (`agent/src/web-run.ts`): two NEAR AI Cloud readers → registry and limits → 1Click quote →
  `propose_payment`, the same pipeline as `npm run pay -- --execute`. Progress streams to the browser as NDJSON. The
  agent signs with its **function-call key** (`propose_payment` only). NEAR AI calls, PDF rendering and the key never
  go through the Next.js bundle.
- **Approve / Reject** are signed by the **owner** with NEAR Wallet Selector (MyNearWallet, Meteor, HERE):
  `approve_payment({id})` with 1 yoctoNEAR and 150 TGas, `reject_payment({id, reason})` with 150 TGas and no deposit (the
  contract method is not payable). If the connected account is not the treasury owner, the buttons are disabled
  and a sentence says who can approve. After signing, the page polls `/api/payments/<id>` until Paid / Rejected /
  Failed and then opens the settled record. **The server never signs owner actions.**
- **Relay** (`POST /api/relay`, `lib/relay.ts` + `lib/server/relayer.ts`): decodes the borsh SignedDelegate and only
  sponsors it if the receiver is the registry, it is exactly one FunctionCall to `set_vendor` or `remove_vendor`, with
  exactly 1 yoctoNEAR attached (the registry requires it; it comes from the vendor's balance, and because
  function-call access keys cannot attach deposits the vendor must confirm with a full-access key), at most 30 TGas, not past `max_block_height`, with a valid signature, and the sender has made fewer than
  5 relayed changes in the last hour (in memory). The relayer then sends a transaction with a `SignedDelegate` action
  and waits for the final outcome. The registry checks `predecessor_account_id`, which stays the vendor, so the relayer
  can only ever touch the signer's own entry. Refused on mainnet unless `ORVANTRA_ALLOW_MAINNET_RELAY=1`.
  `npm run relay-selftest -- http://localhost:3000` checks it end to end on testnet (bob re-saves his current entry).
  Note: the installed selector wallets (v10) do not implement `signDelegateActions` yet, so in the browser the page
  currently falls back to the paid transaction and says so.
- **Secrets**: the repo-root `.env` is loaded on the server only (`lib/server/config.ts`, `server-only`). The browser
  receives only the network and contract ids.

## Run
```bash
cd agent && nvm use && npm ci && cd ..   # the agent package (Node 24, see .nvmrc)
cd web && nvm use && npm ci
npm run dev                              # http://localhost:3000
```
`npm run build && npm start` for a production build. `npm test` runs the unit tests (verdict text, overlay maths,
row merging, formatting). `npm run lint` runs ESLint.

| Env (server) | Default | |
|---|---|---|
| `NEAR_NETWORK` | `testnet` | |
| `TREASURY_ID` | `orvantra-treasury-v2.testnet` | |
| `REGISTRY_ID` | `orvantra-registry.testnet` | |
| `TOKEN_ID` | the treasury's `token` | |
| `ORVANTRA_UPLOAD_MODE` | `execute` | `dry-run` or `analyze` makes uploads read-only (nothing proposed) |
| `ORVANTRA_ALLOW_MAINNET` | unset | uploads refuse to sign on mainnet unless `1` |
| `ORVANTRA_TZ` | server time zone | time zone for dates |
| `NEXT_PUBLIC_REPO_URL` | unset | GitHub links on `/` and `/judges` (hidden when unset) |
| `NEXT_PUBLIC_VENDOR_URL` | `/register` | "I send invoices" / "For vendors" |
| `RELAYER_ID` | `orvantra-relayer.testnet` | account that pays for gasless vendor updates |
| `RELAYER_KEY_PATH` | `~/.near-credentials/<network>/<RELAYER_ID>.json` | legacy keychain JSON `{account_id, public_key, private_key}`; never logged |
| `ORVANTRA_ALLOW_MAINNET_RELAY` | unset | the relay refuses on mainnet unless `1` |

## Do X → see Y (testnet)
| Do | See |
|---|---|
| Open `/review` | The held Acme invoice INV-2026-0150 with a red outline on "Our payout address has changed…", the headline **This invoice asks you to pay someone else.**, findings 1 Known vendor · 2 Read twice, privately · 3 Different payout address · 4 First payment to this vendor, and the 80.00 tUSDC panel paying `0x3333…3333` (the registry address, not the invoice's `0x9999…`). |
| Click **Connect wallet** | The wallet selector with MyNearWallet, Meteor and HERE. |
| Sign in with an account that is not `orvantra-owner.testnet` | Approve and Reject disabled: "Only the treasury owner, orvantra-owner.testnet, can approve or reject this payment." |
| Sign in as the owner, click **Approve** | Your wallet asks to sign `approve_payment` (1 yoctoNEAR); then "Signed. The treasury is checking Acme Design Studio's registry entry and paying…", then **Paid.** and the paid record. |
| **Upload invoice** → `agent/fixtures/03-bob-small.png` | Bob's B-0008 was already paid (#1), so the steps stop after the checks: **Stopped — duplicate invoice**, no transaction. A new Bob invoice under 100 would tick through all five steps, be paid automatically, and open the list with its row selected. |
| **Upload invoice** → `agent/fixtures/07-unknown-vendor.png` | Stops after the checks ("not a registered vendor"), no transaction; the row reads **Stopped — not a registered vendor**. |
| `/invoices?f=paid` | Only paid rows ("Paid automatically", "Paid — approved by you"). |
| Open `/register`, connect as `orvantra-bob.testnet` | "You're registered — version 2, …", prefilled NEAR / tUSDC / `orvantra-bob.testnet`, button "Nothing to change". Switch to Base and type `0xBAD`: "A Base address is 0x followed by 40 hex characters." |
| `npm run relay-selftest -- http://localhost:3000` | `relay: HTTP 200 ok=true tx=…`, bob's entry unchanged, "bob paid gas: no". |
| `/rules` | "Pay automatically up to 100.00 tUSDC." and the other limits, read from the treasury. |
| `npm run attach -- ../agent/fixtures/04-acme-changed-bank.png` | Read-only: stores the image, readings and region boxes for an invoice proposed earlier from the command line, so its review screen shows overlays. Nothing is proposed. |

## Files
- `app/(public)/` home and judges pages (+ the zip route); `app/(app)/` the owner app with its sidebar layout.
- `app/` API routes (`api/upload`, `api/payments/[id]`, `api/files/[name]`).
- `components/` `ReviewScreen`, `ApprovePanel` (wallet signing + polling), `UploadButton` (progress dialog),
  `WalletProvider`, `Sidebar`, `NavList`, `WalletStatus`.
- `lib/verdict.ts` findings → verdict and numbered findings (pure, tested). `lib/overlay.ts` boxes → outlines and pins
  (pure, tested). `lib/rows.ts` payments + ledger + records → rows (pure, tested). `lib/activity.ts`, `lib/format.ts`.
- `lib/server/` config (.env, ids), data loading (views), review model, the agent runner.
- `lib/registry.ts` registry chains/limits/address rules + token options (pure, tested against the Rust source).
  `lib/relay.ts` relay policy (pure, tested with signed delegate actions). `components/VendorPanel.tsx` the sign-up form.
- `scripts/relay-selftest.ts` testnet relay check (signs as bob, no change to his entry).
- `scripts/attach.mjs` read-only backfill. `scripts/screenshots.mjs` page screenshots (Playwright, dev helper).

## Known limits
- Region boxes come from reader A (Qwen3-VL), are drawn on page 1 only, and are never used for a decision. Invalid or
  missing boxes mean no overlays; the findings stay numbered on the right.
- Testnet cross-chain payouts are simulated (see `agent/README.md`). The panel says "simulated 1Click deposit on testnet".
- One upload runs at a time per server process.
