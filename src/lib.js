// ============ فهرست ============
// ۱) نرمال‌سازی متن و ارقام
// ۲) تشخیص مبلغ (هزار / میلیون / «و»)
// ۳) سهم‌بندی و محاسبهٔ بدهکار/بستانکار
// ۴) قالب‌بندی پول و تاریخ شمسی
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

// متنی که کاربر در مرحلهٔ «مبلغ» می‌نویسد: مبلغ + (اختیاری) شرح.
// عدد کوچک بدون واحد («500») مبهم است (تومان یا هزار تومان؟) و رد می‌شود.
export function parseAmountText(text) {
  const s = norm(text);
  const a = amountAt(s);
  if (!a || (a.value < 1000 && !a.explicit)) return null;
  return { value: a.value, rest: s.slice(a.end).trim() };
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

// کیبورد عددی روی دکمه‌ها: رقم/«۰۰»/«۰۰۰» اضافه می‌کند، 'b' آخرین رقم را پاک می‌کند.
// سقف ۱۲ رقم؛ هر کلید دیگر (مثل 'ok') مقدار را عوض نمی‌کند.
export function nextVal(val, key) {
  if (key === 'b') return Math.floor(val / 10);
  if (!/^\d+$/.test(key)) return val;
  const n = val * 10 ** key.length + parseInt(key, 10);
  return n > 999999999999 ? val : n;
}

// ---------- ۳) سهم‌بندی و تراز ----------
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

// ---------- ۴) قالب‌بندی ----------
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
