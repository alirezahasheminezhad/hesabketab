// ============ فهرست ============
// ۱) ثابت‌ها و ابزارهای کوچک
// ۲) ورودی Worker (webhook تلگرام + خروجی داده برای اکسل)
// ۳) دسترسی به دیتابیس
// ۴) متن پیام‌ها و دکمه‌ها
// ۵) پردازش پیام‌ها و دستورها
// ۶) پردازش دکمه‌ها (callback)
// ۷) خروجی اکسل

import {
  norm, fa, num, money, intent, computeShares, balance, parseShareInput, jalaliDate,
} from './lib.js';

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

const say = (env, chat, text, extra = {}) =>
  tg(env, 'sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
const edit = (env, chat, mid, text, kb) =>
  tg(env, 'editMessageText', {
    chat_id: chat, message_id: mid, text, parse_mode: 'HTML',
    reply_markup: kb || { inline_keyboard: [] },
  });

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
        await handle(env, await req.json());
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
const clearState = (env, uid) => env.DB.prepare('DELETE FROM state WHERE user_id = ?').bind(uid).run();

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

// ---------- ۴) متن‌ها و دکمه‌ها ----------
const nm = (ms, id) => esc(ms.find((m) => m.id === id)?.name ?? `نفر ${fa(id)}`);
const short = (ms, id) => nm(ms, id).slice(0, 18);

const balLine = (b, ms) =>
  b.net1 === 0
    ? 'حساب‌ها صاف است ✅'
    : `${nm(ms, b.net1 > 0 ? 2 : 1)} ${money(b.net1)} به ${nm(ms, b.net1 > 0 ? 1 : 2)} بدهکار است`;

const HELP = `📒 <b>حساب‌کتاب</b>

<b>ثبت خرید</b> — مبلغ و شرح را بنویس:
<code>۵۰۰ هزار پوشک</code>
<code>۱.۲ میلیون شام نصف</code>
<code>۳۰۰ هزار کرایه حساب احمد</code>
<code>۸۰۰ هزار لوازم سهم احمد ۲۰۰ هزار</code>
اگر سهم را ننویسی، دکمه‌ها می‌آید. (پرداخت‌کننده = فرستندهٔ پیام؛ با دکمه قابل تغییر است)

<b>دستورها</b>
حساب — بدهکار/بستانکار
لیست — ۱۰ مورد آخر
تسویه ۵۰۰ هزار — من به او پرداخت کردم
دریافت ۵۰۰ هزار — از او گرفتم
تسویه کامل — بدهی را صفر کن
برگشت — حذف آخرین ثبت من
حذف ۱۲ — حذف شمارهٔ ۱۲
اکسل — فایل اکسل (داخل گروه و گیت‌هاب)
/name نام — تغییر نام نمایشی`;

function draftKb(e, ms) {
  const id = e.id;
  return {
    inline_keyboard: [
      [
        { text: `📗 همه حساب ${short(ms, 1)}`, callback_data: `a:${id}:o1` },
        { text: `📘 همه حساب ${short(ms, 2)}`, callback_data: `a:${id}:o2` },
      ],
      [{ text: '⚖️ نصف‌نصف', callback_data: `a:${id}:h` }],
      [
        { text: `✂️ سهم ${short(ms, 1)}`, callback_data: `a:${id}:p1` },
        { text: `✂️ سهم ${short(ms, 2)}`, callback_data: `a:${id}:p2` },
      ],
      [{ text: `💳 پرداخت‌کننده: ${short(ms, e.payer)} 🔁`, callback_data: `t:${id}` }],
      [{ text: '❌ لغو', callback_data: `x:${id}` }],
    ],
  };
}
const undoKb = (id) => ({ inline_keyboard: [[{ text: '↩️ برگشت (حذف)', callback_data: `u:${id}` }]] });

const draftText = (e, ms) =>
  `🧾 <b>${esc(e.descr)}</b>\n💰 ${money(e.amount)}\n💳 پرداخت‌کننده: ${nm(ms, e.payer)}\n\nاین خرید حساب کیست؟`;

function entryText(e, ms, rows) {
  const head =
    e.kind === 'settle'
      ? `💸 <b>تسویه ثبت شد</b> · #${fa(e.id)}\n${nm(ms, e.payer)} ${money(e.amount)} به ${nm(ms, 3 - e.payer)} پرداخت کرد`
      : `✅ <b>ثبت شد</b> · #${fa(e.id)}\n🧾 <b>${esc(e.descr)}</b> — ${money(e.amount)}\n💳 پرداخت: ${nm(ms, e.payer)}\n📊 سهم ${nm(ms, 1)}: ${money(e.share1)} · سهم ${nm(ms, 2)}: ${money(e.share2)}`;
  return `${head}\n\n⚖️ ${balLine(balance(rows), ms)}`;
}

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
    : `#${fa(r.id)} · ${d} · ${esc(r.descr)} · ${num(r.amount)} · 💳 ${nm(ms, r.payer)} · سهم: ${num(r.share1)} | ${num(r.share2)}`;
}

// ---------- ۵) پیام‌ها ----------
async function handle(env, u) {
  if (u.callback_query) return onCallback(env, u.callback_query);
  const msg = u.message;
  if (!msg?.text || !msg.from || msg.from.is_bot) return;

  const members = await getMembers(env);
  let me = members.find((m) => m.tg_id === msg.from.id);

  if (me && (await onShareInput(env, msg, me, members))) return;

  const it = intent(msg.text, members, me ? me.id : Math.min(members.length + 1, 2));
  if (!it) return; // گپ معمولی گروه
  if (!me) {
    if (members.length >= 2) return; // این حساب فقط دو نفره است
    me = await register(env, msg.from);
    members.push(me);
  }
  if (msg.chat.type !== 'private') {
    // برای ارسال فایل اکسل به همین گروه
    await env.DB.prepare(
      'INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'
    ).bind('chat', String(msg.chat.id)).run();
  }
  const reply = (text, extra) =>
    say(env, msg.chat.id, text, { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true }, ...extra });

  if (it.type === 'hint') return reply('مبلغ را کامل‌تر بنویس، مثلاً <code>۵۰۰ هزار پوشک</code>');
  if (it.type === 'cmd') return onCommand(env, it, msg, me, members, reply);

  if (members.length < 2) return reply('⏳ نفر دوم هنوز ثبت نشده. از او بخواه یک بار /start بزند.');

  if (it.type === 'settle') return onSettle(env, it.p, me, members, reply);

  // خرید
  const { amount, descr, split } = it.p;
  if (split) {
    const sh = computeShares(amount, split);
    const e = await insertExpense(env, { status: 'ok', amount, payer: me.id, descr, by: me.id, ...sh });
    return reply(entryText(e, members, await okRows(env)), { reply_markup: undoKb(e.id) });
  }
  const e = await insertExpense(env, { status: 'draft', amount, payer: me.id, descr, by: me.id });
  return reply(draftText(e, members), { reply_markup: draftKb(e, members) });
}

async function onCommand(env, it, msg, me, members, reply) {
  switch (it.name) {
    case 'start':
    case 'help': {
      const wait = members.length < 2 ? '\n\n⏳ منتظر نفر دوم: او هم باید یک بار /start بزند.' : '';
      return reply(`سلام ${esc(me.name)} 👋\n\n${HELP}${wait}`);
    }
    case 'balance':
    case 'bal':
      return reply(balanceText(members, await okRows(env)));
    case 'list': {
      const rows = (await okRows(env)).slice(-10).reverse();
      return reply(rows.length ? `🗒 <b>۱۰ مورد آخر</b>\n\n${rows.map((r) => listLine(r, members)).join('\n')}` : 'هنوز چیزی ثبت نشده.');
    }
    case 'undo': {
      const r = await env.DB.prepare(
        "SELECT * FROM expenses WHERE status = 'ok' AND created_by = ? ORDER BY id DESC LIMIT 1"
      ).bind(me.id).first();
      if (!r) return reply('چیزی برای برگشت نیست.');
      return voidAndReport(env, r, members, reply);
    }
    case 'del': {
      const r = await getExpense(env, +it.arg);
      if (!r || r.status !== 'ok') return reply('این شماره پیدا نشد.');
      return voidAndReport(env, r, members, reply);
    }
    case 'name': {
      const name = it.arg.slice(0, 30).trim();
      if (!name) return reply('نام را بعد از دستور بنویس: <code>/name علیرضا</code>');
      await env.DB.prepare('UPDATE members SET name = ? WHERE id = ?').bind(name, me.id).run();
      return reply(`✅ نام تو «${esc(name)}» شد.`);
    }
    case 'excel':
      return reply(await requestExcel(env));
    default:
      return;
  }
}

async function voidAndReport(env, r, members, reply) {
  await env.DB.prepare("UPDATE expenses SET status = 'void' WHERE id = ?").bind(r.id).run();
  const what = r.kind === 'settle' ? 'تسویه' : esc(r.descr);
  return reply(`↩️ #${fa(r.id)} (${what} — ${money(r.amount)}) حذف شد.\n\n⚖️ ${balLine(balance(await okRows(env)), members)}`);
}

async function onSettle(env, p, me, members, reply) {
  const rows = await okRows(env);
  let payer, amount;
  if (p.full) {
    const { net1 } = balance(rows);
    if (net1 === 0) return reply('حساب‌ها همین الان صاف است ✅');
    payer = net1 > 0 ? 2 : 1; // بدهکار پرداخت می‌کند
    amount = Math.abs(net1);
  } else {
    payer = p.kind === 'pay' ? me.id : 3 - me.id;
    amount = p.value;
  }
  const sh = payer === 1 ? { share1: 0, share2: amount } : { share1: amount, share2: 0 };
  const e = await insertExpense(env, { kind: 'settle', status: 'ok', amount, payer, descr: 'تسویه', by: me.id, ...sh });
  return reply(entryText(e, members, await okRows(env)), { reply_markup: undoKb(e.id) });
}

// کاربر دکمهٔ «سهم X» را زده و حالا مبلغ یا درصد می‌نویسد
async function onShareInput(env, msg, me, members) {
  const st = await env.DB.prepare('SELECT * FROM state WHERE user_id = ?').bind(me.tg_id).first();
  if (!st) return false;
  const e = await getExpense(env, st.expense_id);
  const expired = Date.now() - Date.parse(st.ts + 'Z') > 30 * 60 * 1000;
  if (!e || e.status !== 'draft' || expired) {
    await clearState(env, me.tg_id);
    return false;
  }
  const t = norm(msg.text);
  if (/^(?:لغو|انصراف)$/.test(t)) return backToDraft(env, st, e, members, me.tg_id), true;
  const v = parseShareInput(t, e.amount);
  if (v == null) {
    if (!/\d/.test(t)) return false; // گپ معمولی؛ منتظر می‌مانیم
    await say(env, msg.chat.id, `⚠️ مبلغ یا درصد معتبر نیست (حداکثر ${money(e.amount)}). مثلاً <code>۲۰۰ هزار</code> یا <code>۳۰٪</code>`);
    return true;
  }
  await clearState(env, me.tg_id);
  await finalize(env, e, { type: 'part', idx: st.idx, value: v }, st.chat_id, st.msg_id, members);
  return true;
}

async function backToDraft(env, st, e, members, uid) {
  await clearState(env, uid);
  await edit(env, st.chat_id, st.msg_id, draftText(e, members), draftKb(e, members));
}

async function finalize(env, e, split, chat, mid, members) {
  const sh = computeShares(e.amount, split);
  await env.DB.prepare("UPDATE expenses SET status = 'ok', share1 = ?, share2 = ? WHERE id = ? AND status = 'draft'")
    .bind(sh.share1, sh.share2, e.id).run();
  const done = { ...e, ...sh, status: 'ok' };
  await edit(env, chat, mid, entryText(done, members, await okRows(env)), undoKb(e.id));
}

// ---------- ۶) دکمه‌ها ----------
async function onCallback(env, q) {
  const answer = (text) => tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text });
  const members = await getMembers(env);
  const me = members.find((m) => m.tg_id === q.from.id);
  if (!me) return answer('شما عضو این حساب نیستید.');
  if (!q.message) return answer();

  const [op, idStr, arg] = String(q.data).split(':');
  const e = await getExpense(env, +idStr);
  const chat = q.message.chat.id;
  const mid = q.message.message_id;
  if (!e || e.status === 'void') return answer('این مورد دیگر وجود ندارد.');

  if (op === 'u') {
    await env.DB.prepare("UPDATE expenses SET status = 'void' WHERE id = ?").bind(e.id).run();
    await edit(env, chat, mid, `↩️ #${fa(e.id)} حذف شد.\n\n⚖️ ${balLine(balance(await okRows(env)), members)}`);
    return answer('حذف شد');
  }
  if (e.status !== 'draft') return answer('این مورد قبلاً ثبت شده.');

  if (op === 'x') {
    await env.DB.prepare("UPDATE expenses SET status = 'void' WHERE id = ?").bind(e.id).run();
    await clearState(env, q.from.id);
    await edit(env, chat, mid, `❌ لغو شد: ${esc(e.descr)} — ${money(e.amount)}`);
    return answer('لغو شد');
  }
  if (op === 't') {
    e.payer = 3 - e.payer;
    await env.DB.prepare('UPDATE expenses SET payer = ? WHERE id = ?').bind(e.payer, e.id).run();
    await edit(env, chat, mid, draftText(e, members), draftKb(e, members));
    return answer();
  }
  if (op === 'c') {
    await backToDraft(env, { chat_id: chat, msg_id: mid }, e, members, q.from.id);
    return answer();
  }
  if (op === 'a') {
    if (arg === 'h' || arg[0] === 'o') {
      await finalize(env, e, arg === 'h' ? { type: 'half' } : { type: 'owner', idx: +arg[1] }, chat, mid, members);
      return answer('ثبت شد');
    }
    const idx = +arg[1]; // p1 | p2
    await env.DB.prepare(
      `INSERT INTO state (user_id, expense_id, idx, chat_id, msg_id) VALUES (?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET expense_id = excluded.expense_id, idx = excluded.idx,
         chat_id = excluded.chat_id, msg_id = excluded.msg_id, ts = datetime('now')`
    ).bind(q.from.id, e.id, idx, chat, mid).run();
    await edit(
      env, chat, mid,
      `✂️ سهم <b>${nm(members, idx)}</b> از ${money(e.amount)} چقدر است؟\nمبلغ (مثلاً <code>۲۰۰ هزار</code>) یا درصد (<code>۳۰٪</code>) را بنویس.`,
      { inline_keyboard: [[{ text: 'بازگشت', callback_data: `c:${e.id}` }]] }
    );
    return answer();
  }
  return answer();
}

// ---------- ۷) اکسل ----------
async function requestExcel(env) {
  const file = `https://github.com/${REPO}/blob/main/exports/hesabketab.xlsx`;
  const actions = `https://github.com/${REPO}/actions/workflows/export.yml`;
  if (!env.GH_PAT) {
    return `📊 برای دستور «اکسل» یک‌بار توکن گیت‌هاب (GH_PAT) را در تنظیمات ریپو اضافه کن؛ طبق README.\nفعلاً می‌توانی از اینجا دستی اجرا کنی: ${actions}\nفایل (اگر ریپو خصوصی باشد): ${file}`;
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
    ? '⏳ در حال ساخت اکسل… حدود یک دقیقه دیگر داخل همین گروه می‌آید و (اگر ریپو خصوصی باشد) در گیت‌هاب هم ذخیره می‌شود.'
    : `❌ شروع نشد (کد ${r.status}). توکن GH_PAT یا دسترسی Actions را چک کن.`;
}

async function exportData(env) {
  const members = await getMembers(env);
  const chat = (await env.DB.prepare("SELECT v FROM meta WHERE k = 'chat'").first())?.v ?? null;
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
