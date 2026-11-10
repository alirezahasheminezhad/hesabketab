// ============ فهرست ============
// ۱) ثابت‌ها و ابزارهای کوچک
// ۲) ورودی Worker (webhook تلگرام + خروجی داده برای اکسل)
// ۳) دیتابیس
// ۴) متن‌ها و صفحه‌های دکمه‌ای (منو، مراحل ثبت خرید، تسویه)
// ۵) پیام‌های متنی (فقط /start، و شرح/نام وقتی ربات منتظر آن است)
// ۶) دکمه‌ها (callback)
// ۷) ثبت نهایی و اکسل
// (حذف خودکار پیام‌ها: بخش «حذف خودکار» زیر بخش ۳)
//
// همه‌چیز دکمه‌ای است: یک «پنل» (پیام منو) ویرایش می‌شود و هر مرحله جدا و قابل برگشت است.
// ورودی متنی فقط وقتی ربات منتظر است (مبلغ، شرح، سهم دقیق، نام) و با ریپلای روی پیام ربات؛ این در حالت Privacy هم کار می‌کند.

import { DurableObject } from 'cloudflare:workers';
import { fa, num, money, computeShares, balance, parseAmountText, parseShareInput, rtl, iso, jalaliDate } from './lib.js';

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
  tg(env, 'sendMessage', { chat_id: chat, text: rtl(text), parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: kb });
const edit = (env, chat, mid, text, kb) =>
  tg(env, 'editMessageText', {
    chat_id: chat, message_id: mid, text: rtl(text), parse_mode: 'HTML', disable_web_page_preview: true,
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
// state: ربات منتظر یک پیام متنی است (کلید = کسی که دکمه را زده).
// idx: 0 شرح خرید | -1 نام | -2 مبلغ خرید | -3 مبلغ تسویه (expense_id = پرداخت‌کننده) | 1 یا 2 سهم دقیق همان نفر
const setState = (env, uid, eid, idx, chat, mid) =>
  env.DB.prepare(
    `INSERT INTO state (user_id, expense_id, idx, chat_id, msg_id) VALUES (?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET expense_id = excluded.expense_id, idx = excluded.idx,
       chat_id = excluded.chat_id, msg_id = excluded.msg_id, ts = datetime('now')`
  ).bind(uid, eid, idx, chat, mid).run();

// ---------- حذف خودکار پیام‌ها ----------
// همهٔ پیام‌های ربات (از جمله منو) وقتی N ثانیه هیچ درخواستی نیامد پاک می‌شوند؛ هر دکمه یا پیام جدید موعد
// همه را از نو تمدید می‌کند. با /start منو دوباره می‌آید. زمان‌بندی دقیق با Durable Object (alarm).
// صفحه‌ای که ربات منتظر متن تایپی رویش است (state) پاک نمی‌شود، وگرنه ریپلای کاربر بی‌جواب می‌ماند.
const TTL_OPTIONS = [15, 30, 60, 120, 300, 0]; // ثانیه؛ ۰ = خاموش
const getTtl = async (env) => {
  const v = await getMeta(env, 'ttl');
  return v == null ? 30 : +v;
};
const ttlLabel = (s) => (s === 0 ? 'خاموش' : s < 60 ? `${fa(s)} ثانیه` : `${fa(s / 60)} دقیقه`);

// mid: پیامی که همین الان در صف می‌آید (اختیاری). موعد همهٔ پیام‌های این چت را از الان تا N ثانیه می‌برد.
async function expire(env, chat, mid) {
  try {
    const sec = await getTtl(env);
    if (!sec) return;
    const at = Date.now() + sec * 1000;
    if (mid) {
      await env.DB.prepare(
        'INSERT INTO ttl (chat_id, msg_id, del_at) VALUES (?,?,?) ON CONFLICT(chat_id, msg_id) DO UPDATE SET del_at = excluded.del_at'
      ).bind(chat, mid, at).run();
    }
    await env.DB.prepare('UPDATE ttl SET del_at = ? WHERE chat_id = ?').bind(at, chat).run();
    await env.REAPER.get(env.REAPER.idFromName('r')).fetch(`https://reaper/?at=${at}`);
  } catch (e) {
    console.error(e.stack || e); // خطا در پاک‌کردن پیام نباید ثبت حساب را خراب کند
  }
}

const HOLD = "EXISTS (SELECT 1 FROM state s WHERE s.chat_id = ttl.chat_id AND s.msg_id = ttl.msg_id AND s.ts > datetime('now', '-30 minutes'))";

export class Reaper extends DurableObject {
  async fetch(req) {
    const at = +new URL(req.url).searchParams.get('at');
    const cur = await this.ctx.storage.getAlarm();
    if (cur == null || at < cur) await this.ctx.storage.setAlarm(at);
    return new Response('ok');
  }
  async alarm() {
    const now = Date.now();
    const due = (await this.env.DB.prepare(`SELECT chat_id, msg_id FROM ttl WHERE del_at <= ? AND NOT ${HOLD}`).bind(now).all()).results;
    for (const r of due) {
      await del(this.env, r.chat_id, r.msg_id); // اگر قبلاً پاک شده باشد خطا نمی‌دهد
      await this.env.DB.prepare('DELETE FROM ttl WHERE chat_id = ? AND msg_id = ?').bind(r.chat_id, r.msg_id).run();
    }
    // موعدرسیده‌های باقی‌مانده فقط همان «منتظر متن» هستند؛ بعداً دوباره نگاه می‌کنیم
    const sec = (await getTtl(this.env)) || 30;
    await this.env.DB.prepare('UPDATE ttl SET del_at = ? WHERE del_at <= ?').bind(now + sec * 1000, now).run();
    const next = (await this.env.DB.prepare('SELECT MIN(del_at) AS m FROM ttl').first())?.m;
    if (next) await this.ctx.storage.setAlarm(next);
  }
}

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
// نام‌ها لاتین هم می‌شوند؛ هر نام داخل «جزیرهٔ» راست‌به‌چپ می‌رود تا جملهٔ فارسی به‌هم نریزد
const nameOf = (ms, id) => ms.find((m) => m.id === id)?.name ?? `نفر ${fa(id)}`;
const nm = (ms, id) => iso(esc(nameOf(ms, id))); // برای متن (HTML)
const bn = (ms, id) => iso(nameOf(ms, id).slice(0, 18)); // برای روی دکمه
const btn = (text, data) => ({ text: '\u200F' + text, callback_data: data }); // RLM: متن دکمه راست‌چین
const BACK = [btn('🔙 منو', 'm')];
const descrOf = (e) => (e.descr ? iso(esc(e.descr)) : 'بدون شرح');
const HOW = '(روی <b>همین پیام ریپلای</b> کن و بفرست)';
const W = (w) => (w ? `\n\n⚠️ ${w}` : '');
const BAD = 'مبلغ معتبر نیست. واحد را بنویس، مثلاً «۵۰۰ هزار» یا عدد کامل «۵۰۰۰۰۰».';

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

async function ttlView(env) {
  const cur = await getTtl(env);
  const row = TTL_OPTIONS.map((x) => btn(`${x === cur ? '✅ ' : ''}${x === 0 ? '🚫 خاموش' : ttlLabel(x)}`, `ts:${x}`));
  return {
    text: `⏱ <b>حذف خودکار پیام‌ها</b>\n\nوقتی این مدت هیچ دکمه یا پیامی نیامد، همهٔ پیام‌های ربات (از جمله همین منو) از گروه پاک می‌شوند تا شلوغ نشود. هر دکمه یا پیام جدید، زمان را از نو شروع می‌کند. برای آوردن منو دوباره <code>/start</code> بزن. حساب‌ها در ربات و اکسل می‌مانند.\n\nالان: <b>${ttlLabel(cur)}</b>`,
    kb: { inline_keyboard: [row.slice(0, 3), row.slice(3), BACK] },
  };
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
        [btn(`⏱ حذف خودکار پیام‌ها: ${ttlLabel(await getTtl(env))}`, 'tt')],
      ],
    },
  };
}

const STEP = (n) => `➕ <b>خرید جدید</b> · مرحلهٔ ${fa(n)} از ۴`;
const VIEW = {
  // ۱) مبلغ (متنی)
  a: (e, ms, warn) => ({
    text: `${STEP(1)}\n\n💰 مبلغ خرید را بنویس.\n${HOW}\nمثلاً: <code>۵۰۰۰۰۰</code> یا <code>۵۰۰ هزار</code> یا <code>۱.۵ میلیون</code>${W(warn)}`,
    kb: { inline_keyboard: [[btn('❌ لغو', `x:${e.id}`)]] },
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

const shareView = (e, ms, idx, warn) => ({
  text: `✂️ <b>سهم ${nm(ms, idx)}</b> از ${money(e.amount)}\n\nمبلغ یا درصد را بنویس.\n${HOW}\nمثلاً: <code>۲۰۰ هزار</code> یا <code>۳۰٪</code>\n(بقیه می‌شود سهم ${nm(ms, 3 - idx)})${W(warn)}\n\nیا یک درصد آماده را بزن:`,
  kb: {
    inline_keyboard: [
      [20, 25, 30, 40, 50].map((p) => btn(`${fa(p)}٪`, `pc:${e.id}:${idx}:${p}`)),
      [btn('🔙 مرحلهٔ قبل', `o:${e.id}:x`), btn('❌ لغو', `x:${e.id}`)],
    ],
  },
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
const settleAskView = (payer, ms, warn) => ({
  text: `💸 <b>تسویه</b>: ${nm(ms, payer)} به ${nm(ms, 3 - payer)} پرداخت کرد\n\nمبلغ را بنویس.\n${HOW}\nمثلاً: <code>۲۰۰ هزار</code>${W(warn)}`,
  kb: { inline_keyboard: [[btn('🔙 مرحلهٔ قبل', 'st')]] },
});
const settleConfirm = (payer, amount, ms) => ({
  text: `💸 <b>تأیید تسویه</b>\n${nm(ms, payer)} مبلغ ${money(amount)} به ${nm(ms, 3 - payer)} پرداخت کرد.\n\nدرست است؟`,
  kb: { inline_keyboard: [[btn('✅ تأیید و ثبت', `sx:${payer}:${amount}`)], BACK] },
});

// آخرین پیام «پنل» را نگه می‌داریم تا همیشه یک منوی زنده پایین گروه باشد
async function sendPanel(env, chat) {
  const v = await menuView(env, await getMembers(env));
  const r = await say(env, chat, v.text, v.kb);
  if (r.ok) {
    await setMeta(env, 'panel', `${chat}:${r.result.message_id}`);
    await expire(env, chat, r.result.message_id);
  }
}

// ---------- ۵) پیام‌های متنی ----------
// «ادمین ناشناس» گروه با این شناسه پیام می‌فرستد، نه با شناسهٔ واقعی خودش
const ANON = 1087968824;
const whoIs = (ms) => ms.map((m) => `«${iso(esc(m.name))}»`).join(' و '); // برای متن HTML
const whoPlain = (ms) => ms.map((m) => `«${iso(m.name)}»`).join(' و '); // برای هشدار دکمه

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
        const r = await say(env, msg.chat.id, `⛔ این حساب فقط برای دو نفر است: ${whoIs(members)}.\nاگر شما یکی از آن‌ها هستید ولی با اکانت دیگری ثبت شده‌اید، به سازندهٔ ربات بگویید.`);
        if (r.ok) await expire(env, msg.chat.id, r.result.message_id);
        return;
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
  await onTyped(env, msg, members, anon);
}

// متنی که ربات منتظرش است: مبلغ، شرح، سهم، نام.
// صفحه از روی «ریپلای به همان پیام» پیدا می‌شود. «ادمین ناشناس» با شناسهٔ واقعی‌اش نمی‌نویسد،
// پس شناسهٔ فرستنده برای او فایده‌ای ندارد؛ بدون ریپلای آخرین انتظارِ همان چت را می‌گیریم.
async function onTyped(env, msg, members, anon) {
  const text = msg.text.trim().replace(/\s+/g, ' ');
  if (!text || text.startsWith('/')) return;
  const replyTo = msg.reply_to_message?.message_id;
  const rows = (await env.DB.prepare('SELECT * FROM state WHERE chat_id = ? ORDER BY ts DESC').bind(msg.chat.id).all()).results;
  const st = rows.find((r) => (!replyTo || r.msg_id === replyTo) && (anon || r.user_id === msg.from.id));
  if (!st) return;
  const me = members.find((m) => m.tg_id === st.user_id);
  if (!me) return;
  if (Date.now() - Date.parse(st.ts + 'Z') > 30 * 60 * 1000) return clearState(env, st.user_id);
  await expire(env, st.chat_id, st.msg_id); // هر پیام تایپی هم موعد حذف را تمدید می‌کند
  const show = (v) => edit(env, st.chat_id, st.msg_id, v.text, v.kb);

  if (st.idx === -1) { // نام
    await clearState(env, st.user_id);
    await env.DB.prepare('UPDATE members SET name = ? WHERE id = ?').bind(text.slice(0, 30), me.id).run();
    return show(await menuView(env, await getMembers(env)));
  }
  if (st.idx === -3) { // مبلغ تسویه؛ expense_id = پرداخت‌کننده
    const p = parseAmountText(text);
    if (!p) return show(settleAskView(st.expense_id, members, BAD));
    await clearState(env, st.user_id);
    return show(settleConfirm(st.expense_id, p.value, members));
  }
  const e = await getExpense(env, st.expense_id);
  if (!e || e.status !== 'draft') return clearState(env, st.user_id);
  if (st.idx === -2) { // مبلغ خرید
    const p = parseAmountText(text);
    if (!p) return show(VIEW.a(e, members, BAD));
    await env.DB.prepare('UPDATE expenses SET amount = ? WHERE id = ?').bind(p.value, e.id).run();
    e.amount = p.value;
    await setState(env, st.user_id, e.id, 0, st.chat_id, st.msg_id);
    return show(VIEW.d(e, members));
  }
  if (st.idx === 0) { // شرح
    await clearState(env, st.user_id);
    e.descr = text.slice(0, 60);
    await env.DB.prepare('UPDATE expenses SET descr = ? WHERE id = ?').bind(e.descr, e.id).run();
    return show(VIEW.p(e, members));
  }
  // سهم دقیق (idx = ۱ یا ۲): مبلغ یا درصد
  const v = parseShareInput(text, e.amount);
  if (v == null) return show(shareView(e, members, st.idx, `عدد معتبر نیست (حداکثر ${money(e.amount)}).`));
  await clearState(env, st.user_id);
  await finalize(env, e, { type: 'part', idx: st.idx, value: v }, st.chat_id, st.msg_id, members);
}

// ---------- ۶) دکمه‌ها ----------
async function onCallback(env, q) {
  const answer = (text, alert = false) =>
    tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text, show_alert: alert });
  const members = await getMembers(env);
  let me = members.find((m) => m.tg_id === q.from.id);
  if (!me) {
    // هر کس اولین‌بار دکمه‌ای بزند (تا سقف دو نفر) خودکار عضو می‌شود
    if (members.length >= 2) return answer(`فقط ${whoPlain(members)} عضو این حساب‌اند.`, true);
    me = await register(env, q.from);
    members.push(me);
  }
  if (!q.message) return answer();
  await clearState(env, q.from.id); // هر دکمه، انتظار متن قبلی را لغو می‌کند

  const chat = q.message.chat.id;
  const mid = q.message.message_id;
  await expire(env, chat, mid); // هر دکمه، موعد حذف را تمدید می‌کند
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
    if (step === 'a') await setState(env, q.from.id, e.id, -2, chat, mid);
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
      await go(e, 'a');
      return answer();
    }

    case 'pc': { // درصدِ آماده برای سهم دقیق: pc:خرید:نفر:درصد
      const e = await draft();
      if (!e) return gone();
      return done(e, { type: 'part', idx: +b, pct: +c });
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
      await setState(env, q.from.id, e.id, +b, chat, mid);
      await show(shareView(e, members, +b));
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

    case 'tt':
      await show(await ttlView(env));
      return answer();
    case 'ts': {
      const sec = +a;
      if (!TTL_OPTIONS.includes(sec)) return answer();
      await setMeta(env, 'ttl', String(sec));
      if (sec === 0) await env.DB.prepare('DELETE FROM ttl').run(); // خاموش: چیزی در صف نماند
      await show(await ttlView(env));
      return answer('ذخیره شد');
    }

    case 'st':
      await show(await settleView(env, members));
      return answer();
    case 'tp': // تسویه با مبلغ دلخواه: مبلغ را می‌نویسد
      await setState(env, q.from.id, id, -3, chat, mid);
      await show(settleAskView(id, members));
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
