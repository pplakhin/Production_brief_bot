import { handleUpdate } from '../lib/bot.js';

// Сюда Telegram присылает все сообщения и нажатия кнопок.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('Brief bot is running');

  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    return res.status(401).send('unauthorized');
  }

  try {
    await handleUpdate(req.body || {});
  } catch (e) {
    console.error(e);
  }
  // Всегда 200, иначе Telegram будет бесконечно повторять запрос.
  res.status(200).send('ok');
}
