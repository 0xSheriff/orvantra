// npm run notifier            — watch the treasury and send Telegram alerts (held / paid / rejected / failed / stopped)
// npm run notifier -- --link  — show the chat id of whoever pressed Start on the bot
// npm run notifier -- --test  — send one sample "Held for you" message
// Secrets come from the environment (.env at runtime) and are never printed. Approvals are never done from Telegram.
import '../env.ts';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nearConfig, getPayments, getConfig, getVendor, clearViewCache, type Payment } from '../near.ts';
import { readLedger, defaultLedgerPath } from '../ledger.ts';
import { unitFor } from '../format.ts';
import { telegramClient, sendMessage, type TelegramClient } from './telegram.ts';
import { paymentAlert, stoppedAlert, type MessageCtx } from './messages.ts';
import { loadState, saveState, diff, remember, agentStopped } from './state.ts';

const here = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = process.env.ORVANTRA_NOTIFIER_STATE ?? resolve(here, '../../data/notifier-state.json');
const POLL_MS = Number(process.env.ORVANTRA_NOTIFIER_POLL_MS ?? 15_000);
const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

async function buildCtx(cfg: ReturnType<typeof nearConfig>, payments: Payment[]): Promise<MessageCtx> {
  const conf = await getConfig(cfg).catch(() => null);
  const tokenId = (conf as { token?: string } | null)?.token ?? process.env.TOKEN_ID ?? null;
  const vendorNames = new Map<string, string>();
  for (const v of new Set(payments.map((p) => p.vendor))) {
    const entry = (await getVendor(cfg, v).catch(() => null)) as { display_name?: string } | null;
    if (entry?.display_name) vendorNames.set(v, entry.display_name);
  }
  return {
    network: cfg.network,
    unit: unitFor(cfg.network, tokenId),
    tokenId,
    appUrl: process.env.ORVANTRA_APP_URL ?? 'http://localhost:3100',
    treasuryId: cfg.treasuryId,
    autoPayThreshold: (conf as { auto_pay_threshold?: string } | null)?.auto_pay_threshold ?? null,
    minPayoutAgeSec: (conf as { min_payout_age_sec?: number } | null)?.min_payout_age_sec ?? null,
    vendorNames,
  };
}

async function link(client: TelegramClient) {
  const updates = await client.call<Array<{ update_id: number; message?: { chat: { id: number; first_name?: string; username?: string }; text?: string } }>>('getUpdates', { timeout: 0 });
  const chats = new Map<number, string>();
  for (const u of updates) {
    const m = u.message;
    if (m && m.text?.startsWith('/start')) chats.set(m.chat.id, m.chat.username ? `@${m.chat.username}` : m.chat.first_name ?? '');
  }
  if (!chats.size) {
    console.log('No /start found yet. Open your bot in Telegram, press Start (or send /start), then run this again.');
    return;
  }
  for (const [id, who] of chats) {
    console.log(`chat id ${id}  ${who}`);
    await sendMessage(client, String(id), `Orvantra alerts are almost set up — your chat id is <code>${id}</code>. Add it to .env as TELEGRAM_CHAT_ID.`);
  }
  console.log('Add the right one to .env as TELEGRAM_CHAT_ID=<id>, then run: npm run notifier -- --test');
}

async function test(client: TelegramClient, chatId: string) {
  const cfg = nearConfig();
  const payments = await getPayments(cfg);
  const ctx = await buildCtx(cfg, payments);
  const p: Payment = payments.filter((x) => x.status === 'Pending').at(-1) ?? payments.find((x) => (x.agent_flags ?? []).length) ?? {
    id: 0, invoice_hash: 'sample', vendor: 'acme.near', amount: '80000000', payout_version: 2, status: 'Pending',
    reasons: ['agent: invoice asks to pay a different address — ignored; registry is the source of truth (invoice says: 0x9999999999999999999999999999999999999999)'],
    direct: false, destination: null, created_at: '0', memo: 'INV-2026-0150',
    payout: { chain: 'base', asset_id: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', address: '0x3333333333333333333333333333333333333333' },
  } as Payment;
  const alert = paymentAlert({ ...p, status: 'Pending' }, ctx)!;
  await sendMessage(client, chatId, `<i>Test alert</i>\n${alert.text}`, alert.buttons);
  console.log(`Sent a test alert for payment #${p.id} to the configured chat.`);
}

async function watch(client: TelegramClient, chatId: string) {
  const cfg = nearConfig();
  const ledgerPath = defaultLedgerPath();
  let state = loadState(STATE_PATH, cfg.treasuryId);
  log(`watching ${cfg.treasuryId} on ${cfg.network} every ${POLL_MS / 1000}s${state.initialized ? '' : ' (first run: recording current state silently)'}`);
  for (;;) {
    try {
      clearViewCache();
      const payments = await getPayments(cfg);
      const stopped = agentStopped(readLedger(ledgerPath), cfg.treasuryId);
      const d = diff(state, payments, stopped);
      if (d.payments.length || d.stopped.length) {
        const ctx = await buildCtx(cfg, payments);
        const ledger = readLedger(ledgerPath);
        for (const p of d.payments) {
          const a = paymentAlert(p, ctx);
          try {
            if (a) { await sendMessage(client, chatId, a.text, a.buttons); log(`sent ${a.key}`); }
            state = remember(state, [p], []);
          } catch (e) {
            log(`could not send payment #${p.id} (${(e as Error).message}); will retry`);
            if (!(e as { retryable?: boolean }).retryable) state = remember(state, [p], []);
          }
        }
        for (const h of d.stopped) {
          const e = ledger[h];
          try {
            if (e) { const a = stoppedAlert(e, ctx); await sendMessage(client, chatId, a.text, a.buttons); log(`sent ${a.key}`); }
            state = remember(state, [], [h]);
          } catch (err) {
            log(`could not send stopped ${h.slice(0, 8)} (${(err as Error).message}); will retry`);
            if (!(err as { retryable?: boolean }).retryable) state = remember(state, [], [h]);
          }
        }
      } else if (!state.initialized) {
        state = remember(state, payments, stopped);
      }
      saveState(STATE_PATH, state);
    } catch (e) {
      log(`poll failed: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set in .env');
  const client = telegramClient(token, { log });
  const args = process.argv.slice(2);
  if (args.includes('--link')) return link(client);
  const chatId = process.env.TELEGRAM_CHAT_ID ?? '';
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID is not set. Run: npm run notifier -- --link');
  if (args.includes('--test')) return test(client, chatId);
  return watch(client, chatId);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
