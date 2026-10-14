// Минимальный клиент Telegram Bot API без сторонних библиотек.

export async function tg(method, payload = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({ ok: false, description: 'bad json' }));
  if (!data.ok) console.error(`Telegram ${method} failed:`, data.description);
  return data;
}

// Отправка файла: Telegram принимает его только как multipart/form-data.
export async function sendDocument(chatId, filename, content, caption = '') {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  form.append('document', new Blob([content], { type: 'text/html' }), filename);
  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({ ok: false, description: 'bad json' }));
  if (!data.ok) console.error('Telegram sendDocument failed:', data.description);
  return data;
}

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
