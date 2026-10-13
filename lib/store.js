// Хранение незаконченных брифов в Upstash Redis через REST API.
// Vercel-функции не помнят ничего между запросами, поэтому ответы лежат здесь.

const DAY = 24 * 60 * 60;
const SESSION_TTL = 30 * DAY;

function cfg() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis is not configured: set KV_REST_API_URL and KV_REST_API_TOKEN');
  return { url, token };
}

export async function redis(...cmd) {
  const { url, token } = cfg();
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd.map(String)),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Redis: ${data.error}`);
  return data.result;
}

const sKey = (id) => `brief:s:${id}`;
const rKey = (id) => `brief:refs:${id}`;
const ACTIVE = 'brief:active';

export async function getSession(chatId) {
  const v = await redis('GET', sKey(chatId));
  return v ? JSON.parse(v) : null;
}

// touch=false — не сдвигать время последней активности (для напоминаний).
export async function saveSession(chatId, s, { touch = true } = {}) {
  if (touch) s.lastActivity = Date.now();
  await redis('SET', sKey(chatId), JSON.stringify(s), 'EX', SESSION_TTL);
  await redis('SADD', ACTIVE, chatId);
}

export async function deleteSession(chatId) {
  await redis('DEL', sKey(chatId), rKey(chatId));
  await redis('SREM', ACTIVE, chatId);
}

export async function forgetActive(chatId) {
  await redis('SREM', ACTIVE, chatId);
}

export async function listActive() {
  return (await redis('SMEMBERS', ACTIVE)) || [];
}

// Референсы пишутся отдельным списком: альбом из нескольких фото приходит
// параллельными запросами, а RPUSH атомарный и ничего не теряет.
export async function addRef(chatId, messageId) {
  await redis('RPUSH', rKey(chatId), messageId);
  await redis('EXPIRE', rKey(chatId), SESSION_TTL);
}

export async function getRefs(chatId) {
  return ((await redis('LRANGE', rKey(chatId), 0, -1)) || []).map(Number);
}

export async function clearRefs(chatId) {
  await redis('DEL', rKey(chatId));
}

// true, если ключ поставлен впервые. Нужно для защиты от повторов.
export async function once(key, ttl = 3600) {
  return (await redis('SET', key, '1', 'NX', 'EX', ttl)) === 'OK';
}
