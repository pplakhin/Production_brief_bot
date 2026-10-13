// Запуск бота на своём компьютере, без Vercel:  npm run local
// Бот сам забирает сообщения у Telegram (getUpdates), вебхук для этого снимается.
// Если в .env нет ключей Upstash, ответы хранятся в памяти до перезапуска.

import { readFileSync, existsSync } from 'node:fs';

// ---------- .env ----------

const envPath = new URL('../.env', import.meta.url);
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('Нет TELEGRAM_BOT_TOKEN. Скопируйте .env.example в .env и впишите токен.');
  process.exit(1);
}

// ---------- хранилище в памяти вместо Upstash ----------

if (!process.env.KV_REST_API_URL && !process.env.UPSTASH_REDIS_REST_URL) {
  const MEMORY_URL = 'http://memory.local/';
  process.env.KV_REST_API_URL = MEMORY_URL;
  process.env.KV_REST_API_TOKEN = 'local';

  const db = new Map();
  const run = ([cmd, key, ...args]) => {
    switch (cmd) {
      case 'GET': return db.get(key) ?? null;
      case 'SET':
        if (args.includes('NX') && db.has(key)) return null;
        db.set(key, args[0]);
        return 'OK';
      case 'DEL': [key, ...args].forEach((k) => db.delete(k)); return 1;
      case 'SADD': db.set(key, new Set(db.get(key)).add(args[0])); return 1;
      case 'SREM': db.get(key)?.delete(args[0]); return 1;
      case 'SMEMBERS': return [...(db.get(key) || [])];
      case 'RPUSH': db.set(key, [...(db.get(key) || []), args[0]]); return db.get(key).length;
      case 'LRANGE': return db.get(key) || [];
      case 'EXPIRE': return 1;
      default: throw new Error(`memory store: ${cmd} is not supported`);
    }
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url) !== MEMORY_URL) return realFetch(url, opts);
    const result = run(JSON.parse(opts.body));
    return { json: async () => ({ result }) };
  };
  console.log('Upstash не настроен — ответы хранятся в памяти до перезапуска.');
}

// ---------- опрос Telegram ----------

const { tg } = await import('../lib/telegram.js');
const { handleUpdate } = await import('../lib/bot.js');

const me = await tg('getMe');
if (!me.ok) {
  console.error('Telegram не принял токен. Проверьте TELEGRAM_BOT_TOKEN в .env.');
  process.exit(1);
}

// Пока у бота есть вебхук, Telegram не отдаёт сообщения через getUpdates.
await tg('deleteWebhook', {});
console.log(`Бот @${me.result.username} запущен. Остановить: Ctrl+C.`);
console.log('Вебхук снят. Чтобы снова работать через Vercel, откройте /api/setup?key=<WEBHOOK_SECRET>.');
if (!process.env.ADMIN_CHAT_ID) {
  console.log('ADMIN_CHAT_ID не задан: напишите боту /myid и впишите число в .env, затем перезапустите.');
}

let offset = 0;
for (;;) {
  try {
    const r = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
    if (!r.ok) {
      await new Promise((ok) => setTimeout(ok, 3000));
      continue;
    }
    for (const update of r.result) {
      offset = update.update_id + 1;
      try {
        await handleUpdate(update);
      } catch (e) {
        console.error(e);
      }
    }
  } catch (e) {
    console.error('Нет связи с Telegram, повторю через 5 секунд:', e.message);
    await new Promise((ok) => setTimeout(ok, 5000));
  }
}
