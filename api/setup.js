import { tg } from '../lib/telegram.js';

// Одноразовая настройка: открыть в браузере
// https://<ваш-проект>.vercel.app/api/setup?key=<WEBHOOK_SECRET>
export default async function handler(req, res) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret || req.query.key !== secret) return res.status(401).send('unauthorized');

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `https://${host}/api/webhook`;

  const webhook = await tg('setWebhook', {
    url,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  const commands = await tg('setMyCommands', {
    commands: [{ command: 'start', description: 'Заполнить бриф' }],
  });

  res.status(200).json({ webhook_url: url, webhook, commands });
}
