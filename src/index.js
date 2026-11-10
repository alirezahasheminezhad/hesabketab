// ============ فهرست ============
// ۱) ثابت‌ها و ابزارهای کوچک
// ۲) ورودی Worker (webhook تلگرام + خروجی داده برای اکسل)
// ۳) دیتابیس
// ۴) متن‌ها و صفحه‌های دکمه‌ای (منو، مراحل ثبت خرید، تسویه)
// ۵) پیام‌های متنی (فقط /start، و شرح/نام وقتی ربات منتظر آن است)
// ۶) دکمه‌ها (callback)
// ۷) ثبت نهایی و اکسل
//
// همه‌چیز دکمه‌ای است: یک «پنل» (پیام منو) ویرایش می‌شود و هر مرحله جدا و قابل برگشت است.
// تنها ورودی متنی: شرح خرید و نام؛ آن هم با ریپلای روی پیام ربات (در حالت Privacy هم کار می‌کند).

import { fa, num, money, computeShares, balance, nextVal, jalaliDate } from './lib.js';

// ---------- ۱) ثابت‌ها ----------
const REPO = 'alirezahasheminezhad/hesabketab';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function sha(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
// کلیدها از روی توکن ربات ساخته می‌شوند تا فقط همان یک راز لازم باشد
// (ورک‌فلوها همین فرمول را با sha256sum حساب می‌کنند)
const keys = async (env) => ({
  webhook: await sha(env.BOT_TOKEN + ':wh'),
  export: await sha(env.BOT_TOKEN + ':export'),
});

const tg = (env, method, body) =>
  fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

const say = (env, chat, text, kb) =>
  tg(env, 'sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: kb });
const edit = (env, chat, mid, text, kb) =>
  tg(env, 'editMessageText', {
    chat_id: chat, message_id: mid, text, parse_mode: 'HTML', disable_web_page_preview: true,
    reply_markup: kb || { inline_keyboard: [] },
  });
const del = (env, chat, mid) => tg(env, 'deleteMessage', { chat_id: chat, message_id: mid });

// ---------- ۲) ورودی Worker ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const k = await keys(env);
    if (req.method === 'POST' && url.pathname === '/webhook') {
      if (req.headers.get('x-telegram-bot-api-secret-token') !== k.webhook) {
        return new Response('forbidden', { status: 403 });
      }
      try {
        const u = await req.json();
        await (u.callback_query ? onCallback(env, u.callback_query) : onMessage(env, u.message));
      } catch (e) {
        console.error(e.stack || e); // همیشه ۲۰۰ برمی‌گردانیم تا تلگرام پیام را تکرار نکند
      }
      return new Response('ok');
    }
    if (req.method === 'GET' && url.pathname === '/export') {
      if (url.searchParams.get('key') !== k.export) return new Response('forbidden', { status: 403 });
      return Response.json(await exportData(env));
    }
    return new Response('hesabketab ok');
  },
};

// ---------- ۳) دیتابیس ----------
const getMembers = async (env) =>
  (await env.DB.prepare('SELECT id, tg_id, name FROM members ORDER BY id').all()).results;
const okRows = async (env) =>
  (await env.DB.prepare("SELECT * FROM expenses WHERE status = 'ok' ORDER BY id").all()).results;
const getExpense = (env, id) => env.DB.prepare('SELECT * FROM expenses WHERE id = ?').bind(id).first();
const voidExpense = (env, id) => env.DB.prepare("UPDATE expenses SET status = 'void' WHERE id = ?").bind(id).run();
const getMeta = async (env, k) => (await env.DB.prepare('SELECT v FROM meta WHERE k = ?').bind(k).first())?.v ?? null;
const setMeta = (env, k, v) =>
  env.DB.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, v).run();
const clearState = (env, uid) => env.DB.prepare('DELETE FROM state WHERE user_id = ?').bind(uid).run();
// state: ربات منتظر یک پیام متنی از این کاربر است. idx 0 = شرح خرید، idx -1 = نام
const setState = (env, uid, eid, idx, chat, mid) =>
  env.DB.prepare(
    `INSERT INTO state (user_id, expense_id, idx, chat_id, msg_id) VALUES (?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET expense_id = excluded.expense_id, idx = excluded.idx,
       chat_id = excluded.chat_id, msg_id = excluded.msg_id, ts = datetime('now')`
  ).bind(uid, eid, idx, chat, mid).run();

async function insertExpense(env, e) {
  const r = await env.DB.prepare(
    'INSERT INTO expenses (kind, status, amount, payer, share1, share2, descr, created_by) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(e.kind || 'expense', e.status, e.amount, e.payer, e.share1 || 0, e.share2 || 0, e.descr || '', e.by).run();
  return getExpense(env, r.meta.last_row_id);
}

async function register(env, from) {
  const id = (await getMembers(env)).length + 1;
  const name = (from.first_name || from.username || `نفر ${id}`).slice(0, 30);
  await env.DB.prepare('INSERT INTO members (id, tg_id, name) VALUES (?,?,?)').bind(id, from.id, name).run();
  return { id, tg_id: from.id, name };
}

// ---------- ۴) صفحه‌های دکمه‌ای ----------
const nm = (ms, id) => esc(ms.find((m) => m.id === id)?.name ?? `نفر ${fa(id)}`); // برای متن (HTML)
const bn = (ms, id) => (ms.find((m) => m.id === id)?.name ?? `نفر ${fa(id)}`).slice(0, 18); // برای روی دکمه
const btn = (text, data) => ({ text, callback_data: data });
const BACK = [btn('🔙 منو', 'm')];
const descrOf = (e) => (e.descr ? esc(e.descr) : 'بدون شرح');

const balLine = (b, ms) =>
  b.net1 === 0
    ? 'حساب‌ها صاف است ✅'
    : `${nm(ms, b.net1 > 0 ? 2 : 1)} ${money(b.net1)} به ${nm(ms, b.net1 > 0 ? 1 : 2)} بدهکار است`;

const sum = (e, ms) =>
  `🧾 ${descrOf(e)} · 💰 ${money(e.amount)}${e.payer ? ` · 💳 ${nm(ms, e.payer)}` : ''}`;

function entryText(e, ms, rows) {
  const head =
    e.kind === 'settle'
      ? `💸 <b>تسویه ثبت شد</b> · #${fa(e.id)}\n${nm(ms, e.payer)} ${money(e.amount)} به ${nm(ms, 3 - e.payer)} پرداخت کرد`
      : `✅ <b>ثبت شد</b> · #${fa(e.id)}\n🧾 <b>${descrOf(e)}</b> — ${money(e.amount)}\n💳 پرداخت: ${nm(ms, e.payer)}\n📊 سهم ${nm(ms, 1)}: ${money(e.share1)} · سهم ${nm(ms, 2)}: ${money(e.share2)}`;
  return `${head}\n\n⚖️ ${balLine(balance(rows), ms)}`;
}
const undoKb = (id) => ({ inline_keyboard: [[btn('↩️ برگشت (حذف)', `u:${id}`)]] });

function balanceText(ms, rows) {
  const b = balance(rows);
  const lines = [1, 2].map(
    (i) => `<b>${nm(ms, i)}</b>\n  پرداخت کرده: ${money(b.paid[i - 1])}\n  سهم مصرف: ${money(b.share[i - 1])}`
  );
  const settled = b.setPaid[0] + b.setPaid[1] > 0
    ? `\n💸 تسویه‌ها: ${nm(ms, 1)} ${money(b.setPaid[0])} · ${nm(ms, 2)} ${money(b.setPaid[1])}\n`
    : '';
  return `⚖️ <b>تراز حساب</b>\n\n${lines.join('\n\n')}\n${settled}\n━━━━━━━━\n<b>${balLine(b, ms)}</b>`;
}

function listLine(r, ms) {
  const d = fa(jalaliDate(r.created_at).date.slice(5));
  return r.kind === 'settle'
    ? `#${fa(r.id)} · ${d} · 💸 ${nm(ms, r.payer)} ← ${nm(ms, 3 - r.payer)} · ${num(r.amount)}`
    : `#${fa(r.id)} · ${d} · ${descrOf(r)} · ${num(r.amount)} · 💳 ${nm(ms, r.payer)} · سهم: ${num(r.share1)} | ${num(r.share2)}`;
}

async function menuView(env, ms) {
  const wait = ms.length < 2 ? '\n\n⏳ نفر دوم هنوز ثبت نشده؛ کافی است او هم یکی از دکمه‌ها را بزند.' : '';
  return {
    text: `📒 <b>حساب‌کتاب</b>\n\n⚖️ ${balLine(balance(await okRows(env)), ms)}${wait}\n\nچه کاری می‌خواهی انجام بدهی؟`,
    kb: {
      inline_keyboard: [
        [btn('➕ ثبت خرید جدید', 'n')],
        [btn('⚖️ بدهکار / بستانکار', 'bal'), btn('🗒 ۱۰ مورد آخر', 'lst')],
        [btn('💸 تسویه', 'st'), btn('↩️ حذف آخرین ثبت من', 'ul')],
        [btn('📊 خروجی اکسل', 'xl'), btn('👤 نام من', 'nm')],
      ],
    },
  };
}

// کیبورد عددی: مقدار فعلی داخل callback_data می‌ماند (بدون ذخیره در دیتابیس)
function keypad(target, val, extra, back) {
  const k = (label, key) => btn(label, `k:${target}:${val}:${key}`);
  return {
    inline_keyboard: [
      [k('۱', '1'), k('۲', '2'), k('۳', '3')],
      [k('۴', '4'), k('۵', '5'), k('۶', '6')],
      [k('۷', '7'), k('۸', '8'), k('۹', '9')],
      [k('۰', '0'), k('۰۰', '00'), k('۰۰۰', '000')],
      ...extra,
      [k('⌫ پاک', 'b'), k('✔️ تأیید', 'ok')],
      back,
    ],
  };
}

const STEP = (n) => `➕ <b>خرید جدید</b> · مرحلهٔ ${fa(n)} از ۴`;
const VIEW = {
  // ۱) مبلغ
  a: (e) => ({
    text: `${STEP(1)}\nمبلغ را با دکمه‌ها وارد کن:\n\n💰 <b>${money(e.amount)}</b>`,
    kb: keypad(`a${e.id}`, e.amount, [], [btn('❌ لغو', `x:${e.id}`)]),
  }),
  // ۲) شرح (متنی، اختیاری)
  d: (e, ms) => ({
    text: `${STEP(2)}\n${sum(e, ms)}\n\n📝 شرح خرید را بنویس (روی <b>همین پیام ریپلای</b> کن و متن را بفرست)، یا ادامه بده:`,
    kb: {
      inline_keyboard: [
        [btn('⏭ ادامه (بدون شرح)', `g:${e.id}:p`)],
        [btn('🔙 مرحلهٔ قبل', `g:${e.id}:a`), btn('❌ لغو', `x:${e.id}`)],
      ],
    },
  }),
  // ۳) پرداخت‌کننده
  p: (e, ms) => ({
    text: `${STEP(3)}\n${sum(e, ms)}\n\n💳 چه کسی پول را پرداخت کرد؟`,
    kb: {
      inline_keyboard: [
        [btn(`${e.payer === 1 ? '✅ ' : ''}${bn(ms, 1)} پرداخت کرد`, `y:${e.id}:1`)],
        [btn(`${e.payer === 2 ? '✅ ' : ''}${bn(ms, 2)} پرداخت کرد`, `y:${e.id}:2`)],
        [btn('🔙 مرحلهٔ قبل', `g:${e.id}:d`), btn('❌ لغو', `x:${e.id}`)],
      ],
    },
  }),
  // ۴) این خرید حساب کیست؟
  s: (e, ms) => ({
    text: `${STEP(4)}\n${sum(e, ms)}\n\nاین خرید حساب کیست؟\n«همه حساب X» یعنی X باید کل مبلغ را بدهد.`,
    kb: {
      inline_keyboard: [
        [btn(`📗 همه حساب ${bn(ms, 1)}`, `o:${e.id}:o1`), btn(`📘 همه حساب ${bn(ms, 2)}`, `o:${e.id}:o2`)],
        [btn('⚖️ نصف‌نصف', `o:${e.id}:h`)],
        [btn('✂️ سهم‌بندی دقیق (مبلغ یا درصد)', `o:${e.id}:x`)],
        [btn('🔙 مرحلهٔ قبل', `g:${e.id}:p`), btn('❌ لغو', `x:${e.id}`)],
      ],
    },
  }),
  // سهم‌بندی دقیق: سهم کدام‌یک؟
  w: (e, ms) => ({
    text: `✂️ <b>سهم‌بندی دقیق</b>\n${sum(e, ms)}\n\nسهم کدام‌یک را وارد می‌کنی؟ (بقیه می‌شود سهم نفر دیگر)`,
    kb: {
      inline_keyboard: [
        [btn(`سهم ${bn(ms, 1)}`, `w:${e.id}:1`), btn(`سهم ${bn(ms, 2)}`, `w:${e.id}:2`)],
        [btn('🔙 مرحلهٔ قبل', `g:${e.id}:s`), btn('❌ لغو', `x:${e.id}`)],
      ],
    },
  }),
};

const shareView = (e, ms, idx, val) => ({
  text: `✂️ <b>سهم ${nm(ms, idx)}</b> از ${money(e.amount)}\n\n💰 <b>${money(val)}</b>\n(سهم ${nm(ms, 3 - idx)}: ${money(Math.max(e.amount - val, 0))})\n\nمبلغ را بزن یا یک درصد انتخاب کن:`,
  kb: keypad(
    `s${e.id}.${idx}`, val,
    [[20, 25, 30, 40].map((p) => btn(`${fa(p)}٪`, `k:s${e.id}.${idx}:${val}:p${p}`))],
    [btn('🔙 مرحلهٔ قبل', `o:${e.id}:x`), btn('❌ لغو', `x:${e.id}`)]
  ),
});

async function settleView(env, ms) {
  const b = balance(await okRows(env));
  const rows = [];
  if (b.net1 !== 0) {
    const payer = b.net1 > 0 ? 2 : 1;
    rows.push([btn(`✅ تسویه کامل (${bn(ms, payer)} می‌دهد: ${money(b.net1)})`, `sc:${payer}:${Math.abs(b.net1)}`)]);
  }
  rows.push([btn(`💳 ${bn(ms, 1)} پرداخت کرد (مبلغ دلخواه)`, 'tp:1')]);
  rows.push([btn(`💳 ${bn(ms, 2)} پرداخت کرد (مبلغ دلخواه)`, 'tp:2')]);
  rows.push(BACK);
  return { text: `💸 <b>تسویه</b>\n\n⚖️ ${balLine(b, ms)}\n\nکدام را ثبت کنم؟`, kb: { inline_keyboard: rows } };
}
const settleKeypadView = (payer, ms, val) => ({
  text: `💸 <b>تسویه</b>: ${nm(ms, payer)} به ${nm(ms, 3 - payer)} پرداخت کرد\n\nمبلغ را وارد کن:\n💰 <b>${money(val)}</b>`,
  kb: keypad(`t${payer}`, val, [], [btn('🔙 مرحلهٔ قبل', 'st')]),
});
const settleConfirm = (payer, amount, ms) => ({
  text: `💸 <b>تأیید تسویه</b>\n${nm(ms, payer)} مبلغ ${money(amount)} به ${nm(ms, 3 - payer)} پرداخت کرد.\n\nدرست است؟`,
  kb: { inline_keyboard: [[btn('✅ تأیید و ثبت', `sx:${payer}:${amount}`)], BACK] },
});

// آخرین پیام «پنل» را نگه می‌داریم تا همیشه یک منوی زنده پایین گروه باشد
async function sendPanel(env, chat) {
  const v = await menuView(env, await getMembers(env));
  const r = await say(env, chat, v.text, v.kb);
  if (r.ok) await setMeta(env, 'panel', `${chat}:${r.result.message_id}`);
}

// ---------- ۵) پیام‌های متنی ----------
// «ادمین ناشناس» گروه با این شناسه پیام می‌فرستد، نه با شناسهٔ واقعی خودش
const ANON = 1087968824;
const whoIs = (ms) => ms.map((m) => `«${esc(m.name)}»`).join(' و ');

async function onMessage(env, msg) {
  if (!msg?.text || !msg.from) return;
  const anon = msg.from.id === ANON || !!msg.sender_chat;
  if (msg.from.is_bot && !anon) return;
  const members = await getMembers(env);
  let me = members.find((m) => m.tg_id === msg.from.id);

  // تنها دستور: /start (یا /menu) برای ساخت منو. بعد از آن همه‌چیز دکمه است.
  if (/^\/(?:start|menu)(?:@\w+)?(?:\s|$)/.test(msg.text)) {
    // ادمین ناشناس ثبت‌نام نمی‌شود؛ با اولین دکمه‌ای که بزند با شناسهٔ واقعی‌اش ثبت می‌شود
    if (!me && !anon) {
      if (members.length >= 2) {
        return say(env, msg.chat.id, `⛔ این حساب فقط برای دو نفر است: ${whoIs(members)}.\nاگر شما یکی از آن‌ها هستید ولی با اکانت دیگری ثبت شده‌اید، به سازندهٔ ربات بگویید.`);
      }
      me = await register(env, msg.from);
    }
    if (msg.chat.type !== 'private') await setMeta(env, 'chat', String(msg.chat.id));
    const old = await getMeta(env, 'panel');
    if (old) {
      const [c, m] = old.split(':');
      await del(env, c, m); // منوی قبلی حذف شود تا فقط یکی بماند
    }
    return sendPanel(env, msg.chat.id);
  }
  if (me) await onTyped(env, msg, me);
}

// شرح خرید یا نام جدید (وقتی ربات منتظر آن است)
async function onTyped(env, msg, me) {
  const st = await env.DB.prepare('SELECT * FROM state WHERE user_id = ?').bind(me.tg_id).first();
  if (!st) return;
  if (Date.now() - Date.parse(st.ts + 'Z') > 30 * 60 * 1000) return clearState(env, me.tg_id);
  const text = msg.text.trim().slice(0, 60);
  if (!text || text.startsWith('/')) return;
  await clearState(env, me.tg_id);

  if (st.idx === -1) {
    await env.DB.prepare('UPDATE members SET name = ? WHERE id = ?').bind(text.slice(0, 30), me.id).run();
    const v = await menuView(env, await getMembers(env));
    return edit(env, st.chat_id, st.msg_id, v.text, v.kb);
  }
  const e = await getExpense(env, st.expense_id);
  if (!e || e.status !== 'draft') return;
  await env.DB.prepare('UPDATE expenses SET descr = ? WHERE id = ?').bind(text, e.id).run();
  e.descr = text;
  return edit(env, st.chat_id, st.msg_id, ...Object.values(VIEW.p(e, await getMembers(env))));
}

// ---------- ۶) دکمه‌ها ----------
async function onCallback(env, q) {
  const answer = (text, alert = false) =>
    tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text, show_alert: alert });
  const members = await getMembers(env);
  let me = members.find((m) => m.tg_id === q.from.id);
  if (!me) {
    // هر کس اولین‌بار دکمه‌ای بزند (تا سقف دو نفر) خودکار عضو می‌شود
    if (members.length >= 2) return answer(`فقط ${whoIs(members)} عضو این حساب‌اند.`, true);
    me = await register(env, q.from);
    members.push(me);
  }
  if (!q.message) return answer();
  await clearState(env, q.from.id); // هر دکمه، انتظار متن قبلی را لغو می‌کند

  const chat = q.message.chat.id;
  const mid = q.message.message_id;
  const show = (v) => edit(env, chat, mid, v.text, v.kb);
  const [op, a, b, c] = String(q.data).split(':');
  const id = +a;
  const gone = () => answer('این مورد قبلاً ثبت یا لغو شده.', true);
  const draft = async () => {
    const e = await getExpense(env, id);
    return e && e.status === 'draft' ? e : null;
  };
  // رفتن به یک مرحله؛ مرحلهٔ شرح منتظر متن می‌ماند
  const go = async (e, step) => {
    if (step === 'd') await setState(env, q.from.id, e.id, 0, chat, mid);
    await show(VIEW[step](e, members));
  };
  const done = async (e, split) =>
    (await finalize(env, e, split, chat, mid, members)) ? answer('ثبت شد ✅') : gone();

  switch (op) {
    case 'm':
      await show(await menuView(env, members));
      return answer();

    case 'n': {
      if (members.length < 2) return answer('نفر دوم هنوز ثبت نشده؛ از او بخواه یکی از دکمه‌ها را بزند.', true);
      const e = await insertExpense(env, { status: 'draft', amount: 0, payer: 0, descr: '', by: me.id });
      await show(VIEW.a(e));
      return answer();
    }

    case 'k': { // کیبورد عددی: k:هدف:مقدار:کلید
      const val = +b;
      if (a[0] === 't') { // تسویه با مبلغ دلخواه
        const payer = +a.slice(1);
        if (c !== 'ok') {
          await show(settleKeypadView(payer, members, nextVal(val, c)));
          return answer();
        }
        if (val < 1) return answer('مبلغ را وارد کن.', true);
        await show(settleConfirm(payer, val, members));
        return answer();
      }
      const [eid, idx] = a.slice(1).split('.').map(Number);
      const e = await getExpense(env, eid);
      if (!e || e.status !== 'draft') return gone();
      if (a[0] === 'a') { // مبلغ خرید
        if (c !== 'ok') {
          e.amount = nextVal(val, c);
          await show(VIEW.a(e));
          return answer();
        }
        if (val < 1) return answer('مبلغ را وارد کن.', true);
        await env.DB.prepare('UPDATE expenses SET amount = ? WHERE id = ?').bind(val, e.id).run();
        e.amount = val;
        await go(e, 'd');
        return answer();
      }
      // سهم دقیق
      if (c[0] === 'p') return done(e, { type: 'part', idx, pct: +c.slice(1) });
      if (c !== 'ok') {
        await show(shareView(e, members, idx, nextVal(val, c)));
        return answer();
      }
      if (val < 1 || val > e.amount) return answer(`مبلغ باید بین ۱ و ${money(e.amount)} باشد.`, true);
      return done(e, { type: 'part', idx, value: val });
    }

    case 'g': { // رفتن به یک مرحله
      const e = await draft();
      if (!e) return gone();
      if (b === 's' && !e.payer) return answer('اول پرداخت‌کننده را انتخاب کن.', true);
      await go(e, b);
      return answer();
    }
    case 'y': { // انتخاب پرداخت‌کننده
      const e = await draft();
      if (!e) return gone();
      await env.DB.prepare('UPDATE expenses SET payer = ? WHERE id = ?').bind(+b, e.id).run();
      e.payer = +b;
      await go(e, 's');
      return answer();
    }
    case 'o': { // انتخاب حساب
      const e = await draft();
      if (!e) return gone();
      if (b === 'x') {
        await show(VIEW.w(e, members));
        return answer();
      }
      return done(e, b === 'h' ? { type: 'half' } : { type: 'owner', idx: +b[1] });
    }
    case 'w': {
      const e = await draft();
      if (!e) return gone();
      await show(shareView(e, members, +b, 0));
      return answer();
    }
    case 'x': { // لغو خرید در حال ثبت (فقط پیش‌نویس؛ ثبت‌شده را با این دکمه نمی‌شود حذف کرد)
      await env.DB.prepare("UPDATE expenses SET status = 'void' WHERE id = ? AND status = 'draft'").bind(id).run();
      await show(await menuView(env, members));
      return answer('لغو شد');
    }

    case 'u': { // برگشتِ یک ثبت‌شده (دکمهٔ زیر پیام نتیجه)
      const r = await getExpense(env, id);
      if (!r || r.status !== 'ok') return gone();
      await voidExpense(env, id);
      await show({ text: `↩️ #${fa(id)} حذف شد.\n\n⚖️ ${balLine(balance(await okRows(env)), members)}` });
      return answer('حذف شد');
    }
    case 'ul': { // حذف آخرین ثبت من (با تأیید)
      const r = await env.DB.prepare(
        "SELECT * FROM expenses WHERE status = 'ok' AND created_by = ? ORDER BY id DESC LIMIT 1"
      ).bind(me.id).first();
      if (!r) return answer('چیزی برای حذف نیست.', true);
      await show({
        text: `↩️ آخرین ثبت تو:\n${listLine(r, members)}\n\nحذف شود؟`,
        kb: { inline_keyboard: [[btn('🗑 بله، حذف کن', `ud:${r.id}`)], BACK] },
      });
      return answer();
    }
    case 'ud': {
      const r = await getExpense(env, id);
      if (!r || r.status !== 'ok') return gone();
      await voidExpense(env, id);
      await show({
        text: `↩️ #${fa(id)} حذف شد.\n\n⚖️ ${balLine(balance(await okRows(env)), members)}`,
        kb: { inline_keyboard: [BACK] },
      });
      return answer('حذف شد');
    }

    case 'bal':
      await show({ text: balanceText(members, await okRows(env)), kb: { inline_keyboard: [BACK] } });
      return answer();
    case 'lst': {
      const rows = (await okRows(env)).slice(-10).reverse();
      await show({
        text: rows.length ? `🗒 <b>۱۰ مورد آخر</b>\n\n${rows.map((r) => listLine(r, members)).join('\n')}` : 'هنوز چیزی ثبت نشده.',
        kb: { inline_keyboard: [BACK] },
      });
      return answer();
    }
    case 'xl':
      await show({ text: await requestExcel(env), kb: { inline_keyboard: [BACK] } });
      return answer();
    case 'nm':
      await setState(env, q.from.id, 0, -1, chat, mid);
      await show({
        text: `👤 نام فعلی تو: <b>${nm(members, me.id)}</b>\nنام جدید را بنویس (روی <b>همین پیام ریپلای</b> کن و بفرست).`,
        kb: { inline_keyboard: [BACK] },
      });
      return answer();

    case 'st':
      await show(await settleView(env, members));
      return answer();
    case 'tp': // تسویه با مبلغ دلخواه: انتخاب پرداخت‌کننده
      await show(settleKeypadView(id, members, 0));
      return answer();
    case 'sc': // تأیید تسویه کامل
      await show(settleConfirm(id, +b, members));
      return answer();
    case 'sx': { // ثبت تسویه
      const payer = id, amount = +b;
      if ((payer !== 1 && payer !== 2) || !(amount >= 1)) return answer();
      // دوبار لمس دکمه نباید دو تسویه ثبت کند
      const dup = await env.DB.prepare(
        "SELECT 1 FROM expenses WHERE kind = 'settle' AND status = 'ok' AND payer = ? AND amount = ? AND created_at > datetime('now', '-15 seconds')"
      ).bind(payer, amount).first();
      if (dup) return answer('این تسویه همین الان ثبت شد.', true);
      const sh = payer === 1 ? { share1: 0, share2: amount } : { share1: amount, share2: 0 };
      const e = await insertExpense(env, { kind: 'settle', status: 'ok', amount, payer, descr: 'تسویه', by: me.id, ...sh });
      await show({ text: entryText(e, members, await okRows(env)), kb: undoKb(e.id) });
      await sendPanel(env, chat);
      return answer('ثبت شد ✅');
    }
    default:
      return answer();
  }
}

// ---------- ۷) ثبت نهایی و اکسل ----------
// پیام پنل به نتیجهٔ ثبت تبدیل می‌شود (ماندگار) و یک منوی تازه پایین‌تر می‌آید
async function finalize(env, e, split, chat, mid, ms) {
  if (e.payer !== 1 && e.payer !== 2) return false;
  const sh = computeShares(e.amount, split);
  const r = await env.DB.prepare(
    "UPDATE expenses SET status = 'ok', share1 = ?, share2 = ? WHERE id = ? AND status = 'draft'"
  ).bind(sh.share1, sh.share2, e.id).run();
  if (!r.meta.changes) return false;
  await edit(env, chat, mid, entryText({ ...e, ...sh, status: 'ok' }, ms, await okRows(env)), undoKb(e.id));
  await sendPanel(env, chat);
  return true;
}

async function requestExcel(env) {
  const file = `https://github.com/${REPO}/blob/main/exports/hesabketab.xlsx`;
  const actions = `https://github.com/${REPO}/actions/workflows/export.yml`;
  if (!env.GH_PAT) {
    return `📊 برای ساخت اکسل با دکمه، یک‌بار توکن گیتهاب (GH_PAT) را در تنظیمات ریپو اضافه کن؛ طبق README.\nفعلاً از اینجا دستی اجرا کن (Run workflow): ${actions}\nفایل ساخته‌شده: ${file}`;
  }
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/export.yml/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GH_PAT}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'hesabketab-bot',
    },
    body: JSON.stringify({ ref: 'main' }),
  });
  return r.status === 204
    ? `⏳ در حال ساخت اکسل… حدود یک دقیقه دیگر داخل همین گروه می‌آید و در گیتهاب هم ذخیره می‌شود:\n${file}`
    : `❌ شروع نشد (کد ${r.status}). توکن GH_PAT یا دسترسی Actions را چک کن.`;
}

async function exportData(env) {
  const members = await getMembers(env);
  const chat = await getMeta(env, 'chat');
  const name = (id) => members.find((m) => m.id === id)?.name ?? `نفر ${id}`;
  const rows = (await okRows(env)).map((r) => ({
    id: r.id,
    type: r.kind === 'settle' ? 'تسویه' : 'خرید',
    date: jalaliDate(r.created_at).date,
    time: jalaliDate(r.created_at).time,
    descr: r.descr,
    amount: r.amount,
    payer: r.payer,
    payer_name: name(r.payer),
    share1: r.share1,
    share2: r.share2,
    by: name(r.created_by),
  }));
  return { chat, members: members.map((m) => ({ id: m.id, name: m.name })), rows };
}
