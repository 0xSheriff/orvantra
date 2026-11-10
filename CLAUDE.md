# Orvantra — project context for coding agents

AI accounts-payable agent for the NEAR Hackathon (deadline 2026-11-14 23:59 UTC).
Read `docs/ARCHITECTURE.md` and `docs/PLAN.md` first.

## Layout (target)
- `contracts/vendor-registry/` — Rust NEAR contract: vendors set their own payout details.
- `contracts/treasury/` — Rust NEAR contract: holds USDC, enforces payment policy (Day 3). Decision logic in `src/policy.rs` (pure).
- `contracts/test-token/` — NEP-141 "Test USDC" (tUSDC, 6 decimals) for testnet demos only.
- `scripts/testnet-e2e.sh` — testnet walkthrough of token + treasury + registry (run manually).
- `scripts/testnet-day5.sh` — Day 5 testnet walkthrough: treasury v2, restricted agent key, `npm run pay` (run manually).
- `agent/` — TypeScript service (Node 24): invoice extraction by two NEAR AI Cloud readers, checks, 1Click payments (Day 4-5).
  Invoice content goes ONLY to NEAR AI Cloud — never to Fortytwo or any other service.
- `web/` — Next.js owner app (Day 6a): annotated review, invoices, vendors, rules, activity, wallet approvals.
  Imports the agent's light modules via `orvantra-agent` (file:../agent); uploads run `agent/src/web-run.ts` in a
  child process. See `web/README.md`. Tests: `cd web && npm test`; `npm run build`, `npm run lint`.

## Toolchain (installed)
- Rust 1.99 + `wasm32-unknown-unknown`, `cargo near` 0.23, `near` CLI (near-cli-rs 0.31), Node 22.
- Build a contract: `cd contracts/<name> && cargo near build non-reproducible-wasm`.
- Tests: `cargo test` (unit tests with near-sdk `testing_env!`; integration tests with `near-workspaces` sandbox).

## Hard rules
- NEVER read, print, or commit `.env` (holds NEARAI_API_KEY, FORTYTWO_API_KEY, ONECLICK_JWT).
- NEVER deploy to mainnet, sign mainnet transactions, push, or make the repo public. Testnet only
  (`orvantra.testnet`) and only when explicitly asked.
- Keep code simple and well-tested; judges include Claude Code and Codex screening reproducibility.

## Token economy (this runs on a limited 5h/weekly Claude budget — be lean)
- The repo is small (~8.3k lines). Do NOT re-read files you have already read, and never dump a whole file
  when a targeted `grep`/`sed -n '10,40p'` gets the answer. Prefer narrow reads.
- Batch related edits into one pass instead of one edit per turn; run tests once at the end of a coherent
  change, not after every single edit.
- Do not spawn sub-agents/workflows for small fixes. One focused pass is cheaper than fanning out.
- Between distinct phases (implement → test → docs) use `/compact` so you stop re-billing the full history.
- If a command fails, fix the specific cause; do not retry the same command unchanged.

## Verified API facts
- 1Click base: `https://1click.chaindefuser.com/v0` (`/tokens`, `/quote`, `/status`). Requests must send a
  User-Agent header (default Python urllib UA gets 403). Burn addresses (0x...dEaD) are rejected as recipient.
- USDC on NEAR asset id: `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`
- USDC on Base asset id: `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near`
- 1Click deposit = send the origin token to the quote's `depositAddress`, no message/memo:
  - NEAR origin (`nep141:wrap.near`): plain NEAR transfer.  NEAR USDC origin: `ft_transfer_call` to the
    USDC contract, `receiver_id=intents.near` + msg.  EVM origin (e.g. Base USDC): plain ERC20 transfer
    to the 0x depositAddress on that chain (verified 2026-11-10: quote carries no `depositMemo`).
- 1Click `refundTo` must exist on the ORIGIN chain: a NEAR account for NEAR origin, an EVM 0x address for
  an EVM origin (a NEAR account id on a Base-origin quote is rejected: "refundTo is not valid").
- NEAR AI Cloud: `https://cloud-api.near.ai/v1`, model `Qwen/Qwen3-VL-30B-A3B-Instruct` (TEE, verifiable, vision).
  Reader B `z-ai/glm-5.3-flash`. Via `@nearai/inference-sdk` with `e2ee: true`, image_url content works for both and
  `verifyResponse` returns `signatureKind: provider_tee` (verified 2026-11-06).
- Fortytwo: `https://api.fortytwo.network/v1`, model `qwen/qwen3.8-27b` (reasoning model: give max_tokens >= 2000).
