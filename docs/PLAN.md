# Day-by-day plan (deadline 2026-11-14 23:59 UTC = 00:59 WAT Nov 15)

Aim to submit by **Nov 14, 18:00 UTC**. Everything after Day 6 is polish; the core loop must work by Day 6.

| Day | Date | Goal | Done when |
|---|---|---|---|
| 1 | Thu–Fri Nov 5–6 | Setup + README first | Repo created; testnet + mainnet accounts; NEAR AI + Fortytwo keys in `.env`; 1Click **dry** quote script returns a signed quote; NEAR AI Cloud models + attestation API confirmed |
| 2 | Sat Nov 7 | vendor-registry contract | register/update/get payout; only the vendor can change it; `updated_at` stored; tests pass |
| 3 | Sun Nov 8 | treasury contract | policy, caps, monthly cap, duplicate-hash block, pending/approve flow, function-call key; tests incl. over-limit + duplicate |
| 4 | Mon Nov 9 | AI extraction | NEAR AI + Fortytwo strict-JSON extraction; agree/disagree logic; 6 sample invoices (3 normal, 3 fraud) |
| 5 | Tue Nov 10 | Payment executor | quote → verify signature → recipient == registry → propose_payment; full loop on testnet (dry quotes) |
| 6 | Wed Nov 11 | UI + vendor onboarding | Upload page, invoice list with checks, owner approve via wallet; vendor page + gasless relayer; Telegram alerts. **Core loop complete.** |
| 7 | Thu Nov 12 | Mainnet | Deploy contracts to mainnet (you sign); 2–3 real payments of $1–2 to another chain; status tracking |
| 8 | Fri Nov 13 | Judge-ready | README "do X → see Y" steps; hosted demo; record 2-min video |
| 9 | Sat Nov 14 | Ship | Repo public + LICENSE; you post on X (@NEARProtocol #NEARHackathon); submit once after checking payload |

## Cut list if behind (in order)
1. Email intake (keep web + Telegram)
2. Telegram bot (keep web)
3. Gasless vendor relayer (vendor pays tiny gas)
4. Second chain — pay only USDC on NEAR + one other chain

## Things only you can do
- Create NEAR accounts (testnet for dev, mainnet for payout + demo) and fund mainnet with a few NEAR + ~$10 USDC
- Create API keys (NEAR AI Cloud, Fortytwo; optional 1Click JWT at partners.near-intents.org) into `.env`
- Approve every mainnet deploy/transaction, making the repo public, the X post, and the final submission
