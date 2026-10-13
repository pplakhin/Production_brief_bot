import { tg } from '../lib/telegram.js';
import * as store from '../lib/store.js';
import { TEXTS } from '../lib/flow.js';
import { resumeKeyboard } from '../lib/bot.js';

const HOUR = 60 * 60 * 1000;

// Vercel запускает раз в день (см. vercel.json).
// Тем, кто бросил бриф больше суток назад, бот один раз напоминает.
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).send('unauthorized');
  }

  const now = Date.now();
  let reminded = 0;

  for (const chatId of await store.listActive()) {
    const s = await store.getSession(chatId);
    if (!s) { await store.forgetActive(chatId); continue; }

    const idle = now - (s.lastActivity || s.startedAt || now);
    if (idle > 7 * 24 * HOUR) { await store.forgetActive(chatId); continue; }

    if (!s.reminded && idle >= 24 * HOUR) {
      await tg('sendMessage', { chat_id: chatId, text: TEXTS.reminder, reply_markup: resumeKeyboard() });
      s.reminded = true;
      await store.saveSession(chatId, s, { touch: false });
      reminded++;
    }
  }

  res.status(200).json({ ok: true, reminded });
}
