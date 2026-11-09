// ============ فهرست ============
// ۱) نرمال‌سازی متن و ارقام
// ۲) تشخیص مبلغ (هزار / میلیون / «و»)
// ۳) تشخیص خرید، تسویه و دستورها از متن گروه
// ۴) سهم‌بندی و محاسبهٔ بدهکار/بستانکار
// ۵) قالب‌بندی پول و تاریخ شمسی
// منطق خالص و بدون وابستگی است تا با `node --test` تست شود.

// ---------- ۱) نرمال‌سازی ----------
export function norm(s = '') {
  return String(s)
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x6f0))
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660))
    .replace(/٬/g, ',')
    .replace(/٫/g, '.')
    .replace(/٪/g, '%')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[‌‎‏]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- ۲) مبلغ ----------
const UNITS = { 'هزار': 1e3, 'میلیون': 1e6, 'میلیارد': 1e9, k: 1e3, m: 1e6 };
const NUM =
  '(\\d[\\d,.]*)\\s*(هزار|میلیون|میلیارد|[kKmM](?![a-zA-Z]))?(\\s*(?:تومان|تومن|ت)(?=\\s|$))?';

function val(m) {
  let t = m[1].replace(/[.,]+$/, '');
  if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, ''); // 1.200.000
  else if (m[2] && /^\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.'); // 1,5 میلیون
  const n = parseFloat(t.replace(/,/g, ''));
  return n * (m[2] ? UNITS[m[2].toLowerCase()] : 1);
}

// مبلغ را از ابتدای متن می‌خواند. «۲ میلیون و ۵۰۰ هزار» هم پشتیبانی می‌شود.
export function amountAt(s) {
  const first = new RegExp('^' + NUM).exec(s);
  if (!first) return null;
  let total = val(first);
  let pos = first[0].length;
  let explicit = !!(first[2] || first[3]);
  const more = new RegExp('^\\s*و\\s*' + NUM);
  for (let r; (r = more.exec(s.slice(pos))); ) {
    total += val(r);
    pos += r[0].length;
    explicit = explicit || !!(r[2] || r[3]);
  }
  total = Math.round(total);
  return Number.isFinite(total) && total > 0 ? { value: total, end: pos, explicit } : null;
}

// ---------- ۳) تشخیص نیت پیام ----------
// برگرداندن شمارهٔ عضو (۱ یا ۲) از روی «من» یا نام؛ ۰ یعنی نامشخص
export function nameIdx(word, members, senderIdx) {
  const w = norm(word).toLowerCase();
  if (w === 'من' || w === 'خودم') return senderIdx;
  const m = members.find((x) => {
    const n = norm(x.name).toLowerCase();
    return n === w || n.split(' ')[0] === w;
  });
  return m ? m.id : 0;
}

const NOT_HALF = '(?!\\s+(?:کیلو|کیلوگرم|لیتر|متر|گرم|بسته|عدد|تا|من|روز|ساعت|بار)(?=\\s))';

// «۵۰۰ هزار پوشک نصف» | «۳۰۰ هزار کرایه حساب احمد» | «۸۰۰ هزار لوازم سهم احمد ۲۰۰ هزار»
export function parseExpense(text, members = [], senderIdx = 1) {
  let s = norm(text);
  const pre = /^(?:خرید|ثبت|\+)\s*/.exec(s);
  if (pre) s = s.slice(pre[0].length);
  const a = amountAt(s);
  if (!a) return null;
  // عدد کوچک بدون واحد (مثل «5 تا نون») خرید حساب نمی‌شود
  if (a.value < 1000 && !a.explicit) return pre ? { error: 'amount' } : null;

  let rest = ' ' + s.slice(a.end).trim() + ' ';
  let split = null;

  let m = /\sسهم\s+(\S+)\s+/.exec(rest);
  if (m) {
    const idx = nameIdx(m[1], members, senderIdx);
    const tail = rest.slice(m.index + m[0].length);
    const pm = /^(\d+(?:\.\d+)?)\s*(?:%|درصد)/.exec(tail);
    const am = pm ? null : amountAt(tail);
    if (idx && (pm || am)) {
      split = pm ? { type: 'part', idx, pct: parseFloat(pm[1]) } : { type: 'part', idx, value: am.value };
      rest = rest.slice(0, m.index) + ' ' + tail.slice(pm ? pm[0].length : am.end);
    }
  }
  if (!split && (m = /\sحساب\s+(\S+)\s/.exec(rest))) {
    const idx = nameIdx(m[1], members, senderIdx);
    if (idx) {
      split = { type: 'owner', idx };
      rest = rest.replace(m[0], ' ');
    }
  }
  if (!split) {
    const h = new RegExp(
      '\\s(?:نصف نصف|نصفه|نصف|تقسیم(?: بر (?:2|دو))?|مشترک|50 50|50-50)(?=\\s)' + NOT_HALF
    );
    if ((m = h.exec(rest))) {
      split = { type: 'half' };
      rest = rest.replace(m[0], ' ');
    }
  }
  return { amount: a.value, descr: rest.replace(/\s+/g, ' ').trim() || 'بدون شرح', split };
}

// «تسویه ۵۰۰ هزار» (من پرداخت کردم) | «دریافت ۵۰۰ هزار» (من گرفتم) | «تسویه کامل»
export function parseSettle(text) {
  const m = /^(تسویه|دریافت)(?:\s+(.*))?$/.exec(norm(text));
  if (!m) return null;
  const kind = m[1] === 'تسویه' ? 'pay' : 'recv';
  const rest = (m[2] || '').trim();
  if (!rest || /^(?:کامل|همه|کل)$/.test(rest)) return { kind, full: true };
  const a = amountAt(rest);
  return a && (a.value >= 1000 || a.explicit) ? { kind, value: a.value } : null;
}

// ورودی «سهم بخشی»: مبلغ (۲۰۰ هزار) یا درصد (۳۰٪)؛ نامعتبر = null
export function parseShareInput(text, amount) {
  const s = norm(text);
  const pm = /^(\d+(?:\.\d+)?)\s*(?:%|درصد)/.exec(s);
  if (pm) {
    const p = parseFloat(pm[1]);
    return p >= 0 && p <= 100 ? Math.round((amount * p) / 100) : null;
  }
  const a = amountAt(s);
  if (!a || (a.value < 1000 && !a.explicit)) return null;
  return a.value <= amount ? a.value : null;
}

const WORDS = {
  'حساب': 'balance', 'مانده': 'balance', 'تراز': 'balance',
  'لیست': 'list', 'فهرست': 'list',
  'برگشت': 'undo', 'اکسل': 'excel', 'خروجی': 'excel', 'راهنما': 'help',
};

export function intent(text, members, senderIdx) {
  const t = norm(text);
  let m = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(t);
  if (m) return { type: 'cmd', name: m[1].toLowerCase(), arg: m[2] || '' };
  if (WORDS[t]) return { type: 'cmd', name: WORDS[t], arg: '' };
  if ((m = /^(?:حذف|پاک)\s+(\d+)$/.exec(t))) return { type: 'cmd', name: 'del', arg: m[1] };
  if (/^(?:تسویه|دریافت)(?:\s|$)/.test(t)) {
    const p = parseSettle(t);
    if (p) return { type: 'settle', p };
  }
  const p = parseExpense(t, members, senderIdx);
  if (p?.error) return { type: 'hint' };
  return p ? { type: 'expense', p } : null;
}

// ---------- ۴) سهم‌بندی و تراز ----------
// خروجی: سهم نفر ۱ و نفر ۲ (جمعشان همیشه برابر مبلغ است)
export function computeShares(amount, split) {
  if (split.type === 'half') {
    const share1 = Math.floor(amount / 2);
    return { share1, share2: amount - share1 };
  }
  if (split.type === 'owner') {
    return split.idx === 1 ? { share1: amount, share2: 0 } : { share1: 0, share2: amount };
  }
  const v = split.pct != null ? Math.round((amount * split.pct) / 100) : split.value;
  const mine = Math.min(Math.max(v, 0), amount);
  return split.idx === 1 ? { share1: mine, share2: amount - mine } : { share1: amount - mine, share2: mine };
}

// هر ردیف = «payer مبلغ را داده و سهم هر نفر share1/share2 است».
// تسویه هم همین شکل است: پرداخت‌کننده پول داده و سهم گیرنده = کل مبلغ.
// net1 > 0 یعنی نفر ۲ به نفر ۱ بدهکار است.
export function balance(rows) {
  const paid = [0, 0], share = [0, 0], setPaid = [0, 0], setGot = [0, 0];
  let net1 = 0;
  for (const r of rows) {
    if (r.kind === 'settle') {
      setPaid[r.payer - 1] += r.amount;
      setGot[0] += r.share1;
      setGot[1] += r.share2;
    } else {
      paid[r.payer - 1] += r.amount;
      share[0] += r.share1;
      share[1] += r.share2;
    }
    net1 += (r.payer === 1 ? r.amount : 0) - r.share1;
  }
  return { paid, share, setPaid, setGot, net1 };
}

// ---------- ۵) قالب‌بندی ----------
export const fa = (s) => String(s).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
export const num = (n) =>
  fa(String(Math.abs(Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, '٬'));
export const money = (n) => num(n) + ' تومان';

// تبدیل میلادی به شمسی (الگوریتم JDF)
export function g2j(gy, gm, gd) {
  const gdm = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  let jy = gy <= 1600 ? 0 : 979;
  gy -= gy <= 1600 ? 621 : 1600;
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days =
    365 * gy + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) +
    Math.floor((gy2 + 399) / 400) - 80 + gd + gdm[gm - 1];
  jy += 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  jy += Math.trunc((days - 1) / 365); // trunc، نه floor: روز اول فروردین کبیسه‌ها
  if (days > 365) days = (days - 1) % 365;
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  return [jy, jm, jd];
}

// ورودی: زمان UTC دیتابیس («YYYY-MM-DD HH:MM:SS»)؛ خروجی: تاریخ و ساعت به وقت تهران
export function jalaliDate(sqlUtc) {
  const d = new Date(sqlUtc.replace(' ', 'T') + 'Z');
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map((x) => [x.type, x.value])
  );
  const [y, m, dd] = g2j(+p.year, +p.month, +p.day);
  const z = (n) => String(n).padStart(2, '0');
  return { date: `${y}/${z(m)}/${z(dd)}`, time: `${p.hour}:${p.minute}` };
}
