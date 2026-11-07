// Minimal Telegram Bot API client: plain fetch, no framework. The bot token is part of the request URL, so it is
// redacted from every error message and never logged.

export const TELEGRAM_API = 'https://api.telegram.org';

export interface TelegramDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

export interface TelegramOptions {
  /** Attempts per call, including the first (default 5). */
  maxAttempts?: number;
  /** Backoff for network errors and 5xx: base * 2^n, capped (defaults 1s, 30s). */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Longest retry_after we wait for on a 429 (default 5 min); longer waits are cut to this. */
  maxRetryAfterMs?: number;
  /** Timeout of one HTTP attempt (default 15s; getUpdates adds its long-poll timeout). */
  attemptTimeoutMs?: number;
  log?: (msg: string) => void;
  deps?: Partial<TelegramDeps>;
}

/**
 * `retryable` = worth trying again later (network, 5xx, rate limit after all attempts, auth/chat problems the owner
 * can fix). Not retryable = Telegram refused this exact request (HTTP 400: the message itself is bad).
 */
export class TelegramError extends Error {
  constructor(message: string, readonly code: number | null, readonly retryable: boolean) {
    super(message);
    this.name = 'TelegramError';
  }
}

export interface UrlButton {
  text: string;
  url: string;
}

export interface TelegramClient {
  call<T>(method: string, body?: Record<string, unknown>): Promise<T>;
}

interface ApiReply<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

const defaultDeps: TelegramDeps = {
  fetch: (...a) => fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export function telegramClient(token: string, opts: TelegramOptions = {}): TelegramClient {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  const d: TelegramDeps = { ...defaultDeps, ...opts.deps };
  const maxAttempts = opts.maxAttempts ?? 5;
  const base = opts.baseDelayMs ?? 1_000;
  const maxDelay = opts.maxDelayMs ?? 30_000;
  const maxRetryAfter = opts.maxRetryAfterMs ?? 300_000;
  const attemptTimeout = opts.attemptTimeoutMs ?? 15_000;
  const log = opts.log ?? (() => {});
  const redact = (s: string) => s.split(token).join('<token>');

  return {
    async call<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
      const longPoll = typeof body.timeout === 'number' ? body.timeout * 1000 : 0;
      let last: TelegramError | null = null;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let wait = Math.min(maxDelay, base * 2 ** attempt);
        try {
          let res: Response;
          try {
            res = await d.fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'user-agent': 'orvantra-notifier/0.1' },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(attemptTimeout + longPoll),
            });
          } catch (err) {
            throw new TelegramError(`network error: ${redact(err instanceof Error ? err.message : String(err))}`, null, true);
          }
          let reply: ApiReply<T> | null = null;
          try {
            reply = (await res.json()) as ApiReply<T>;
          } catch {
            reply = null;
          }
          if (reply?.ok) return reply.result as T;
          const code = reply?.error_code ?? res.status;
          const desc = redact(reply?.description ?? `HTTP ${res.status}`);
          if (code === 429) {
            const after = reply?.parameters?.retry_after;
            if (typeof after === 'number' && after >= 0) wait = Math.min(maxRetryAfter, after * 1000);
            throw new TelegramError(`rate limited (${desc})`, 429, true);
          }
          if (code >= 500) throw new TelegramError(`server error ${code} (${desc})`, code, true);
          // 400: Telegram refused this request; retrying the same body will not help.
          // 401/403/404: bad token, bot blocked, chat not found: the owner can fix it, so keep the alert for later.
          throw new TelegramError(`${method} failed: ${code} ${desc}`, code, code !== 400);
        } catch (err) {
          const e = err as TelegramError;
          if (e.code !== null && e.code < 500 && e.code !== 429) throw e;
          last = e;
          if (attempt + 1 >= maxAttempts) break;
          log(`telegram ${method}: ${e.message}; retrying in ${Math.round(wait / 100) / 10}s`);
          await d.sleep(wait);
        }
      }
      throw last ?? new TelegramError(`${method} failed`, null, true);
    },
  };
}

/** sendMessage in HTML parse mode, with one row of URL buttons. */
export function sendMessage(client: TelegramClient, chatId: string, text: string, buttons: UrlButton[] = []): Promise<unknown> {
  return client.call('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(buttons.length ? { reply_markup: { inline_keyboard: [buttons.map((b) => ({ text: b.text, url: b.url }))] } } : {}),
  });
}
