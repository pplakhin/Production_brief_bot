import { tg, esc, sendDocument } from './telegram.js';
import * as store from './store.js';
import { STEPS, TEXTS, BRIEF_SECTIONS, nextStepIndex, firstMissingIndex, isActive, wantsCopy } from './flow.js';
import { briefFile } from './file.js';

const MAX_TEXT = 1000;
const MAX_REFS = 30;
const MAX_IN_MESSAGE = 300; // длинные ответы в сообщениях обрезаются, в файле — полностью
const ROW_WIDTH = 32;       // сколько символов помещается в ряд кнопок на узком телефоне

// ---------- входная точка ----------

export async function handleUpdate(update) {
  if (update.update_id != null && !(await store.once(`brief:upd:${update.update_id}`))) return;
  if (update.callback_query) return onCallback(update.callback_query);
  if (update.message) return onMessage(update.message);
}

// ---------- клавиатуры ----------

// style: 'primary' — синяя кнопка с белым текстом, 'success' — зелёная.
function button(text, data, style) {
  const b = { text, callback_data: data };
  if (style) b.style = style;
  return b;
}

// Telegram делит ряд поровну между кнопками и обрезает текст, который не влез.
// Поэтому в ряд ставим столько кнопок, чтобы самая длинная из них помещалась целиком.
function layout(buttons) {
  const rows = [];
  let row = [];
  let widest = 0;
  for (const b of buttons) {
    const w = Math.max(widest, b.text.length);
    if (row.length && (row.length >= 5 || (row.length + 1) * (w + 2) > ROW_WIDTH)) {
      rows.push(row);
      row = [];
      widest = 0;
    }
    row.push(b);
    widest = Math.max(widest, b.text.length);
  }
  if (row.length) rows.push(row);
  return rows;
}

function welcomeKeyboard() {
  const rows = [[button(TEXTS.beginButton, 'begin', 'primary')]];
  const u = (process.env.CONTACT_USERNAME || '').replace(/^@/, '');
  if (u) rows.push([{ text: TEXTS.contactButton, url: `https://t.me/${u}` }]);
  return { inline_keyboard: rows };
}

function resumeKeyboard() {
  return {
    inline_keyboard: [
      [button(TEXTS.resumeButton, 'resume', 'primary')],
      [button(TEXTS.restartButton, 'restart')],
    ],
  };
}

export { resumeKeyboard };

function summaryKeyboard() {
  return {
    inline_keyboard: [
      [button(TEXTS.confirmButton, 'sum:confirm', 'success')],
      [button(TEXTS.editButton, 'sum:edit')],
    ],
  };
}

function editListKeyboard(s) {
  const items = STEPS
    .map((step, i) => ({ step, i }))
    .filter(({ step }) => isActive(step, s.answers))
    .map(({ step, i }) => button(step.label, `e:${i}`));
  return { inline_keyboard: [...layout(items), [button(TEXTS.toSummaryButton, 'sum:back')]] };
}

// ---------- сообщения ----------

async function onMessage(msg) {
  if (msg.chat.type !== 'private') return;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  if (text === '/myid') {
    return tg('sendMessage', { chat_id: chatId, text: `Ваш chat id: <code>${chatId}</code>`, parse_mode: 'HTML' });
  }
  if (text.startsWith('/start')) return onStart(chatId);

  const s = await loadSession(chatId);
  if (!s) return onStart(chatId);
  if (s.stage !== 'q') return tg('sendMessage', { chat_id: chatId, text: TEXTS.useButtons });

  const step = STEPS[s.idx];

  if (step.kind === 'choice') {
    return tg('sendMessage', { chat_id: chatId, text: TEXTS.useButtons });
  }

  if (step.kind === 'text') {
    if (!text) return tg('sendMessage', { chat_id: chatId, text: TEXTS.needText });
    await dropButtons(chatId, s.qMsgId);
    s.answers[step.id] = text.slice(0, MAX_TEXT);
    return advance(chatId, s);
  }

  if (step.kind === 'phone') {
    if (text === TEXTS.backButton) return goBack(chatId, s, { removeKeyboard: true });
    const phone = msg.contact?.phone_number || text;
    if (!phone) return tg('sendMessage', { chat_id: chatId, text: TEXTS.needText });
    s.answers.phone = phone.slice(0, 100);
    await tg('sendMessage', { chat_id: chatId, text: TEXTS.phoneThanks, reply_markup: { remove_keyboard: true } });
    return advance(chatId, s);
  }

  if (step.kind === 'refs') {
    await store.addRef(chatId, msg.message_id);
    // Ссылки и тексты сохраняем, чтобы они попали в файл брифа.
    if (text) {
      s.refLinks.push(text.slice(0, MAX_TEXT));
      await store.saveSession(chatId, s);
    }
    // На альбом из нескольких фото отвечаем один раз.
    if (msg.media_group_id && !(await store.once(`brief:mg:${msg.media_group_id}`))) return;
    return tg('sendMessage', { chat_id: chatId, text: TEXTS.refsAccepted });
  }
}

async function onStart(chatId) {
  const s = await loadSession(chatId);
  if (s && (s.idx > 0 || s.stage !== 'q')) {
    return tg('sendMessage', { chat_id: chatId, text: TEXTS.resumeAsk, reply_markup: resumeKeyboard() });
  }
  return tg('sendMessage', { chat_id: chatId, text: TEXTS.welcome, reply_markup: welcomeKeyboard() });
}

// ---------- кнопки ----------

async function onCallback(cq) {
  const chatId = cq.message?.chat?.id;
  const data = cq.data || '';
  const answerCq = (extra = {}) => tg('answerCallbackQuery', { callback_query_id: cq.id, ...extra });
  if (!chatId) return answerCq();

  if (data === 'begin' || data === 'restart') {
    await answerCq();
    await dropButtons(chatId, cq.message.message_id);
    return beginBrief(chatId, cq.from);
  }

  const s = await loadSession(chatId);
  if (!s) return answerCq({ text: TEXTS.expired, show_alert: true });

  if (data === 'resume') {
    await answerCq();
    await dropButtons(chatId, cq.message.message_id);
    s.reminded = false;
    return s.stage === 'q' ? askQuestion(chatId, s) : showSummary(chatId, s);
  }

  if (data.startsWith('sum:') || data.startsWith('e:')) return onSummaryButton(cq, s, data, answerCq);

  const [kind, idxStr, optStr] = data.split(':');
  if (s.stage !== 'q' || Number(idxStr) !== s.idx) return answerCq({ text: TEXTS.stale });

  const step = STEPS[s.idx];

  if (kind === 'back') {
    await answerCq();
    await dropButtons(chatId, cq.message.message_id);
    return goBack(chatId, s);
  }

  let answer;
  if (kind === 'a' && step.kind === 'choice') {
    answer = step.options[Number(optStr)];
    if (answer === undefined) return answerCq();
  } else if (kind === 'skip') {
    if (step.kind === 'refs') {
      await store.clearRefs(chatId);
      s.refLinks = [];
      answer = 'нет';
    } else {
      answer = step.skipValue || step.skip;
    }
  } else if (kind === 'refs') {
    const refs = await store.getRefs(chatId);
    if (!refs.length) return answerCq({ text: TEXTS.refsEmpty, show_alert: true });
    answer = `получено ${refs.length}`;
  } else {
    return answerCq();
  }

  await answerCq();
  await tg('editMessageText', {
    chat_id: chatId,
    message_id: cq.message.message_id,
    text: `${esc(step.q)}\n\n<b>${TEXTS.answerLabel}:</b> ${esc(answer)}`,
    parse_mode: 'HTML',
  });
  s.answers[step.id] = answer;
  return advance(chatId, s);
}

// Кнопки под проверкой ответов: отправить, исправить, выбрать вопрос.
async function onSummaryButton(cq, s, data, answerCq) {
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;

  if (data === 'sum:confirm' && s.stage === 'summary') {
    // Двойное нажатие не должно отправить бриф дважды.
    if (!(await store.once(`brief:done:${chatId}:${s.startedAt}`, 24 * 3600))) return answerCq();
    await answerCq();
    await dropButtons(chatId, messageId);
    return finish(chatId, s);
  }

  if (data === 'sum:edit' && s.stage === 'summary') {
    await answerCq();
    s.stage = 'edit';
    await tg('editMessageText', { chat_id: chatId, message_id: messageId, text: TEXTS.editAsk, reply_markup: editListKeyboard(s) });
    return store.saveSession(chatId, s);
  }

  if (data === 'sum:back' && s.stage === 'edit') {
    await answerCq();
    s.stage = 'summary';
    await tg('editMessageText', {
      chat_id: chatId, message_id: messageId, text: await summaryText(chatId, s), parse_mode: 'HTML', reply_markup: summaryKeyboard(),
    });
    return store.saveSession(chatId, s);
  }

  if (data.startsWith('e:') && s.stage === 'edit') {
    const i = Number(data.slice(2));
    const step = STEPS[i];
    if (!step || !isActive(step, s.answers)) return answerCq();
    await answerCq();
    await tg('editMessageText', { chat_id: chatId, message_id: messageId, text: `${TEXTS.editingLabel}: ${step.label}` });
    s.stage = 'q';
    s.idx = i;
    return askQuestion(chatId, s);
  }

  return answerCq({ text: TEXTS.stale });
}

// ---------- ход брифа ----------

// Сессии, сохранённые до появления «Назад» и проверки ответов, дополняем полями по умолчанию.
async function loadSession(chatId) {
  const s = await store.getSession(chatId);
  if (!s) return null;
  s.history ||= [];
  s.refLinks ||= [];
  s.stage ||= 'q';
  return s;
}

async function beginBrief(chatId, from = {}) {
  await store.clearRefs(chatId);
  const s = {
    idx: nextStepIndex(0, {}),
    answers: {},
    history: [],
    refLinks: [],
    stage: 'q',
    editing: false,
    user: { id: from.id, username: from.username || '', name: [from.first_name, from.last_name].filter(Boolean).join(' ') },
    startedAt: Date.now(),
    reminded: false,
  };
  return askQuestion(chatId, s);
}

async function askQuestion(chatId, s) {
  s.stage = 'q';
  const step = STEPS[s.idx];
  const back = s.editing || s.history.length ? [button(TEXTS.backButton, `back:${s.idx}`)] : null;
  const rows = [];
  let reply_markup;

  if (step.kind === 'choice') {
    rows.push(...layout(step.options.map((o, i) => button(o, `a:${s.idx}:${i}`, 'primary'))));
  } else if (step.kind === 'text' && step.skip) {
    rows.push([button(step.skip, `skip:${s.idx}`, 'primary')]);
  } else if (step.kind === 'refs') {
    rows.push([button(TEXTS.refsDone, `refs:${s.idx}`, 'primary'), button(TEXTS.refsSkip, `skip:${s.idx}`, 'primary')]);
  }

  if (step.kind === 'phone') {
    const keyboard = [[{ text: TEXTS.phoneButton, request_contact: true }]];
    if (back) keyboard.push([{ text: TEXTS.backButton }]);
    reply_markup = { keyboard, resize_keyboard: true, one_time_keyboard: true };
  } else {
    if (back) rows.push(back);
    if (rows.length) reply_markup = { inline_keyboard: rows };
  }

  // При возврате назад или исправлении показываем, что было отвечено раньше.
  const prev = s.answers[step.id];
  const text = prev !== undefined && step.kind !== 'refs' ? `${step.q}\n\n${TEXTS.currentLabel}: ${prev}` : step.q;

  const r = await tg('sendMessage', { chat_id: chatId, text, reply_markup });
  s.qMsgId = r.result?.message_id;
  await store.saveSession(chatId, s);
}

async function advance(chatId, s) {
  s.reminded = false;
  // Ответы на вопросы, которые после нового ответа стали не нужны, стираем:
  // если вопрос снова понадобится, его зададут заново, а не подставят старый ответ.
  for (const step of STEPS) {
    if (!isActive(step, s.answers)) delete s.answers[step.id];
  }
  if (s.editing) {
    // После исправления задаём вопросы, которые стали нужны, и возвращаемся к проверке.
    const missing = firstMissingIndex(s.answers);
    if (missing === -1) return showSummary(chatId, s);
    s.idx = missing;
    return askQuestion(chatId, s);
  }
  const n = nextStepIndex(s.idx + 1, s.answers);
  if (n === -1) return showSummary(chatId, s);
  s.history.push(s.idx);
  s.idx = n;
  return askQuestion(chatId, s);
}

async function goBack(chatId, s, { removeKeyboard = false } = {}) {
  if (removeKeyboard) {
    await tg('sendMessage', { chat_id: chatId, text: TEXTS.backNote, reply_markup: { remove_keyboard: true } });
  }
  if (s.editing) return showSummary(chatId, s);
  const prev = s.history.pop();
  if (prev !== undefined) s.idx = prev;
  return askQuestion(chatId, s);
}

async function dropButtons(chatId, messageId) {
  if (!messageId) return;
  await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
}

// ---------- проверка ответов ----------

// Ответы по разделам. Ответы на вопросы, которые после исправлений стали не нужны, не показываются.
function answerSections(s, limit) {
  const cut = (v) => (limit && v.length > limit ? `${v.slice(0, limit)}…` : v);
  const lines = [];
  for (const [title, ids] of BRIEF_SECTIONS) {
    const rows = ids
      .map((id) => STEPS.find((x) => x.id === id))
      .filter((step) => s.answers[step.id] !== undefined && isActive(step, s.answers))
      .map((step) => `${esc(step.label)}: ${esc(cut(String(s.answers[step.id])))}`);
    if (rows.length) lines.push('', `<b>${title}</b>`, ...rows);
  }
  return lines;
}

async function summaryText(chatId, s) {
  const refs = (await store.getRefs(chatId)).length;
  return [
    `<b>${TEXTS.summaryTitle}</b>`,
    ...answerSections(s, MAX_IN_MESSAGE),
    '',
    `<b>${TEXTS.refsLabel}:</b> ${refs ? `${refs} шт.` : 'нет'}`,
  ].join('\n');
}

async function showSummary(chatId, s) {
  s.stage = 'summary';
  s.editing = true;
  const r = await tg('sendMessage', {
    chat_id: chatId, text: await summaryText(chatId, s), parse_mode: 'HTML', reply_markup: summaryKeyboard(),
  });
  s.qMsgId = r.result?.message_id;
  await store.saveSession(chatId, s);
}

// ---------- отправка брифа ----------

export function formatBrief(s, refsCount) {
  const lines = ['<b>Новый бриф</b>', ...answerSections(s, MAX_IN_MESSAGE)];
  const u = s.user || {};
  const tgLine = u.username ? `@${esc(u.username)}` : `<a href="tg://user?id=${u.id}">${esc(u.name || 'профиль')}</a>`;
  lines.push('', `<b>Telegram клиента:</b> ${tgLine}`);
  lines.push(`<b>Референсы:</b> ${refsCount ? `${refsCount} шт., пересылаю ниже` : 'нет'}`);
  return lines.join('\n');
}

async function finish(chatId, s) {
  const admin = process.env.ADMIN_CHAT_ID;
  const refs = (await store.getRefs(chatId)).slice(0, MAX_REFS);
  const file = briefFile(s, refs.length);

  if (admin) {
    await tg('sendMessage', { chat_id: admin, text: formatBrief(s, refs.length), parse_mode: 'HTML', disable_web_page_preview: true });
    await sendDocument(admin, file.name, file.html, TEXTS.adminFileCaption);
    for (const id of refs) {
      await tg('copyMessage', { chat_id: admin, from_chat_id: chatId, message_id: id });
    }
  } else {
    console.error('ADMIN_CHAT_ID is not set, brief was not delivered');
  }

  await tg('sendMessage', { chat_id: chatId, text: TEXTS.finish });
  if (wantsCopy(s.answers)) await sendDocument(chatId, file.name, file.html, TEXTS.clientFileCaption);
  await store.deleteSession(chatId);
}
