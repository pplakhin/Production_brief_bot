import { tg, esc } from './telegram.js';
import * as store from './store.js';
import { STEPS, TEXTS, BRIEF_SECTIONS, nextStepIndex } from './flow.js';

const MAX_TEXT = 1000;
const MAX_REFS = 30;

// ---------- входная точка ----------

export async function handleUpdate(update) {
  if (update.update_id != null && !(await store.once(`brief:upd:${update.update_id}`))) return;
  if (update.callback_query) return onCallback(update.callback_query);
  if (update.message) return onMessage(update.message);
}

// ---------- клавиатуры ----------

function layout(buttons) {
  // Короткие варианты (цифры) — в один ряд, остальные — по одному в ряд.
  const short = buttons.every((b) => b.text.length <= 12);
  return short && buttons.length <= 5 ? [buttons] : buttons.map((b) => [b]);
}

function welcomeKeyboard() {
  const rows = [[{ text: TEXTS.beginButton, callback_data: 'begin' }]];
  const u = (process.env.CONTACT_USERNAME || '').replace(/^@/, '');
  if (u) rows.push([{ text: TEXTS.contactButton, url: `https://t.me/${u}` }]);
  return { inline_keyboard: rows };
}

function resumeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: TEXTS.resumeButton, callback_data: 'resume' }],
      [{ text: TEXTS.restartButton, callback_data: 'restart' }],
    ],
  };
}

export { resumeKeyboard };

// ---------- сообщения ----------

async function onMessage(msg) {
  if (msg.chat.type !== 'private') return;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  if (text === '/myid') {
    return tg('sendMessage', { chat_id: chatId, text: `Ваш chat id: <code>${chatId}</code>`, parse_mode: 'HTML' });
  }
  if (text.startsWith('/start')) return onStart(chatId);

  const s = await store.getSession(chatId);
  if (!s) return onStart(chatId);

  const step = STEPS[s.idx];

  if (step.kind === 'choice') {
    return tg('sendMessage', { chat_id: chatId, text: TEXTS.useButtons });
  }

  if (step.kind === 'text') {
    if (!text) return tg('sendMessage', { chat_id: chatId, text: TEXTS.needText });
    const answer = text.slice(0, MAX_TEXT);
    if (step.skip) await dropButtons(chatId, s.qMsgId);
    s.answers[step.id] = answer;
    return advance(chatId, s);
  }

  if (step.kind === 'phone') {
    const phone = msg.contact?.phone_number || text;
    if (!phone) return tg('sendMessage', { chat_id: chatId, text: TEXTS.needText });
    s.answers.phone = phone.slice(0, 100);
    await tg('sendMessage', { chat_id: chatId, text: TEXTS.phoneThanks, reply_markup: { remove_keyboard: true } });
    return advance(chatId, s);
  }

  if (step.kind === 'refs') {
    await store.addRef(chatId, msg.message_id);
    // На альбом из нескольких фото отвечаем один раз.
    if (msg.media_group_id && !(await store.once(`brief:mg:${msg.media_group_id}`))) return;
    return tg('sendMessage', { chat_id: chatId, text: TEXTS.refsAccepted });
  }
}

async function onStart(chatId) {
  const s = await store.getSession(chatId);
  if (s && s.idx > 0) {
    return tg('sendMessage', { chat_id: chatId, text: TEXTS.resumeAsk, reply_markup: resumeKeyboard() });
  }
  return tg('sendMessage', { chat_id: chatId, text: TEXTS.welcome, reply_markup: welcomeKeyboard() });
}

// ---------- кнопки ----------

async function onCallback(cq) {
  const chatId = cq.message?.chat?.id;
  const data = cq.data || '';
  if (!chatId) return tg('answerCallbackQuery', { callback_query_id: cq.id });

  if (data === 'begin' || data === 'restart') {
    await tg('answerCallbackQuery', { callback_query_id: cq.id });
    await dropButtons(chatId, cq.message.message_id);
    return beginBrief(chatId, cq.from);
  }

  const s = await store.getSession(chatId);
  if (!s) {
    return tg('answerCallbackQuery', { callback_query_id: cq.id, text: TEXTS.expired, show_alert: true });
  }

  if (data === 'resume') {
    await tg('answerCallbackQuery', { callback_query_id: cq.id });
    await dropButtons(chatId, cq.message.message_id);
    s.reminded = false;
    return askQuestion(chatId, s);
  }

  const [kind, idxStr, optStr] = data.split(':');
  if (Number(idxStr) !== s.idx) {
    return tg('answerCallbackQuery', { callback_query_id: cq.id, text: TEXTS.stale });
  }
  const step = STEPS[s.idx];
  let answer;

  if (kind === 'a' && step.kind === 'choice') {
    answer = step.options[Number(optStr)];
    if (answer === undefined) return tg('answerCallbackQuery', { callback_query_id: cq.id });
  } else if (kind === 'skip') {
    answer = step.kind === 'refs' ? 'нет' : (step.skipValue || step.skip);
  } else if (kind === 'refs') {
    const refs = await store.getRefs(chatId);
    if (!refs.length) {
      return tg('answerCallbackQuery', { callback_query_id: cq.id, text: TEXTS.refsEmpty, show_alert: true });
    }
    answer = `получено ${refs.length}`;
  } else {
    return tg('answerCallbackQuery', { callback_query_id: cq.id });
  }

  await tg('answerCallbackQuery', { callback_query_id: cq.id });
  await tg('editMessageText', {
    chat_id: chatId,
    message_id: cq.message.message_id,
    text: `${esc(step.q)}\n\n<b>${TEXTS.answerLabel}:</b> ${esc(answer)}`,
    parse_mode: 'HTML',
  });
  s.answers[step.id] = answer;
  return advance(chatId, s);
}

// ---------- ход брифа ----------

async function beginBrief(chatId, from = {}) {
  await store.clearRefs(chatId);
  const s = {
    idx: nextStepIndex(0, {}),
    answers: {},
    user: { id: from.id, username: from.username || '', name: [from.first_name, from.last_name].filter(Boolean).join(' ') },
    startedAt: Date.now(),
    reminded: false,
  };
  return askQuestion(chatId, s);
}

async function askQuestion(chatId, s) {
  const step = STEPS[s.idx];
  let reply_markup;

  if (step.kind === 'choice') {
    reply_markup = { inline_keyboard: layout(step.options.map((o, i) => ({ text: o, callback_data: `a:${s.idx}:${i}` }))) };
  } else if (step.kind === 'text' && step.skip) {
    reply_markup = { inline_keyboard: [[{ text: step.skip, callback_data: `skip:${s.idx}` }]] };
  } else if (step.kind === 'refs') {
    reply_markup = { inline_keyboard: [[
      { text: TEXTS.refsDone, callback_data: `refs:${s.idx}` },
      { text: TEXTS.refsSkip, callback_data: `skip:${s.idx}` },
    ]] };
  } else if (step.kind === 'phone') {
    reply_markup = { keyboard: [[{ text: TEXTS.phoneButton, request_contact: true }]], resize_keyboard: true, one_time_keyboard: true };
  }

  const r = await tg('sendMessage', { chat_id: chatId, text: step.q, reply_markup });
  s.qMsgId = r.result?.message_id;
  await store.saveSession(chatId, s);
}

async function advance(chatId, s) {
  const n = nextStepIndex(s.idx + 1, s.answers);
  if (n === -1) return finish(chatId, s);
  s.idx = n;
  s.reminded = false;
  return askQuestion(chatId, s);
}

async function dropButtons(chatId, messageId) {
  if (!messageId) return;
  await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
}

// ---------- отправка брифа ----------

export function formatBrief(s, refsCount) {
  const lines = ['<b>Новый бриф</b>'];
  for (const [title, ids] of BRIEF_SECTIONS) {
    const rows = ids
      .filter((id) => s.answers[id] !== undefined)
      .map((id) => `${esc(STEPS.find((x) => x.id === id).label)}: ${esc(s.answers[id])}`);
    if (!rows.length) continue;
    lines.push('', `<b>${title}</b>`, ...rows);
  }
  const u = s.user || {};
  const tgLine = u.username ? `@${esc(u.username)}` : `<a href="tg://user?id=${u.id}">${esc(u.name || 'профиль')}</a>`;
  lines.push('', `<b>Telegram клиента:</b> ${tgLine}`);
  lines.push(`<b>Референсы:</b> ${refsCount ? `${refsCount} шт., пересылаю ниже` : 'нет'}`);
  return lines.join('\n');
}

async function finish(chatId, s) {
  const admin = process.env.ADMIN_CHAT_ID;
  const refs = (await store.getRefs(chatId)).slice(0, MAX_REFS);

  if (admin) {
    await tg('sendMessage', { chat_id: admin, text: formatBrief(s, refs.length), parse_mode: 'HTML', disable_web_page_preview: true });
    for (const id of refs) {
      await tg('copyMessage', { chat_id: admin, from_chat_id: chatId, message_id: id });
    }
  } else {
    console.error('ADMIN_CHAT_ID is not set, brief was not delivered');
  }

  await tg('sendMessage', { chat_id: chatId, text: TEXTS.finish });
  await store.deleteSession(chatId);
}
