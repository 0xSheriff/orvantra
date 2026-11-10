// `npm run notifier -- --link`: which chats may the bot answer? Anyone can find a bot and press Start, so once a chat
// id is configured only that chat is answered; the bot never reveals a chat id (or says anything) to strangers.

/** Chats that pressed Start, filtered: all of them while no TELEGRAM_CHAT_ID is configured, else only that one. */
export function linkableChats(chats: Map<number, string>, configuredChatId: string | undefined): Map<number, string> {
  const configured = (configuredChatId ?? '').trim();
  if (!configured) return chats;
  return new Map([...chats].filter(([id]) => String(id) === configured));
}
