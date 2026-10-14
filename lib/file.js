// Бриф файлом: HTML-страница, которая открывается в любом браузере и на телефоне
// и печатается в PDF. Отправляется владельцу и, если клиент попросил, клиенту.

import { esc } from './telegram.js';
import { BRIEF_SECTIONS, STEPS, TEXTS, isActive } from './flow.js';

const stepById = (id) => STEPS.find((x) => x.id === id);

export function briefFile(s, refsCount) {
  const date = new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });

  const sections = BRIEF_SECTIONS.map(([title, ids]) => {
    const rows = ids
      .filter((id) => s.answers[id] !== undefined && isActive(stepById(id), s.answers))
      .map((id) => `<tr><th>${esc(stepById(id).label)}</th><td>${esc(s.answers[id])}</td></tr>`);
    return rows.length ? `<h2>${esc(title)}</h2>\n<table>${rows.join('')}</table>` : '';
  }).join('\n');

  const links = (s.refLinks || []).map((t) => `<li>${esc(t)}</li>`).join('');
  const refs = refsCount
    ? `<p>Получено: ${refsCount} шт.${links ? ' Ссылки и тексты:' : ''}</p>${links ? `<ul>${links}</ul>` : ''}`
    : '<p>нет</p>';

  const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Бриф на видеопроект — ${esc(date)}</title>
<style>
  body { font: 16px/1.5 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #111; background: #fff;
         max-width: 720px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  .date { color: #666; margin: 0 0 24px; }
  h2 { font-size: 18px; margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #111; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; vertical-align: top; padding: 6px 0; border-bottom: 1px solid #e5e5e5; }
  th { width: 40%; padding-right: 12px; font-weight: 600; }
  td { white-space: pre-wrap; word-break: break-word; }
  ul { padding-left: 20px; word-break: break-word; }
</style>
</head>
<body>
<h1>Бриф на видеопроект</h1>
<p class="date">${esc(date)}</p>
${sections}
<h2>${esc(TEXTS.refsLabel)}</h2>
${refs}
</body>
</html>
`;

  const who = String(s.answers.name || 'клиент').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 40) || 'клиент';
  return { name: `Бриф — ${who} — ${date}.html`, html };
}
