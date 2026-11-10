import test from 'node:test';
import assert from 'node:assert/strict';
import { computeShares, balance, parseAmountText, parseShareInput, rtl, iso, money, g2j, jalaliDate } from '../src/lib.js';

test('computeShares', () => {
  assert.deepEqual(computeShares(1001, { type: 'half' }), { share1: 500, share2: 501 });
  assert.deepEqual(computeShares(900, { type: 'owner', idx: 2 }), { share1: 0, share2: 900 });
  assert.deepEqual(computeShares(900, { type: 'part', idx: 2, value: 200 }), { share1: 700, share2: 200 });
  assert.deepEqual(computeShares(900, { type: 'part', idx: 1, pct: 25 }), { share1: 225, share2: 675 });
  assert.deepEqual(computeShares(900, { type: 'part', idx: 2, value: 5000 }), { share1: 0, share2: 900 });
});

test('balance: خرید، تسویه و برعکس شدن بدهی', () => {
  const rows = [];
  // علیرضا ۵۰۰ هزار می‌دهد، نصف‌نصف → احمد ۲۵۰ هزار بدهکار
  rows.push({ kind: 'expense', payer: 1, amount: 500000, ...computeShares(500000, { type: 'half' }) });
  assert.equal(balance(rows).net1, 250000);
  // احمد ۱۰۰ هزار تسویه می‌کند
  rows.push({ kind: 'settle', payer: 2, amount: 100000, share1: 100000, share2: 0 });
  assert.equal(balance(rows).net1, 150000);
  // احمد ۳۰۰ هزار می‌دهد و همه‌اش حساب علیرضا → حالا علیرضا ۱۵۰ هزار بدهکار است
  rows.push({ kind: 'expense', payer: 2, amount: 300000, ...computeShares(300000, { type: 'owner', idx: 1 }) });
  assert.equal(balance(rows).net1, -150000);
  // خرید شخصی (پرداخت‌کننده = صاحب حساب) روی تراز اثری ندارد
  rows.push({ kind: 'expense', payer: 1, amount: 90000, ...computeShares(90000, { type: 'owner', idx: 1 }) });
  assert.equal(balance(rows).net1, -150000);
});

test('parseAmountText: مبلغ تایپی', () => {
  const v = (t) => parseAmountText(t)?.value;
  assert.equal(v('۵۰۰ هزار'), 500000);
  assert.equal(v('۵۰۰٬۰۰۰'), 500000);
  assert.equal(v('1.5 میلیون'), 1500000);
  assert.equal(v('2 میلیون و 500 هزار'), 2500000);
  assert.equal(v('500'), undefined); // بدون واحد و کمتر از ۱۰۰۰ مبهم است
  assert.equal(v('پوشک'), undefined);
});

test('parseShareInput: مبلغ یا درصد', () => {
  assert.equal(parseShareInput('200 هزار', 800000), 200000);
  assert.equal(parseShareInput('۲۵٪', 800000), 200000);
  assert.equal(parseShareInput('2 میلیون', 800000), null);
});

test('rtl/iso: هر خط RLM می‌گیرد، خط خالی نه', () => {
  assert.equal(rtl('a\n\nb'), '\u200Fa\n\n\u200Fb');
  assert.equal(iso('ahmad'), '\u2067ahmad\u2069');
});

test('money', () => {
  assert.equal(money(1250000), '۱٬۲۵۰٬۰۰۰ تومان');
});

test('تاریخ شمسی با Intl برابر است (۲۰۱۵ تا ۲۰۳۵)', () => {
  const fmt = new Intl.DateTimeFormat('en-u-ca-persian', {
    timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric',
  });
  for (let t = Date.UTC(2015, 0, 1); t < Date.UTC(2035, 0, 1); t += 86400000) {
    const d = new Date(t);
    const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
    const want = [parseInt(p.relatedYear || p.year), +p.month, +p.day];
    const got = g2j(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    assert.deepEqual(got, want, d.toISOString());
  }
  assert.deepEqual(g2j(2026, 11, 9), [1405, 8, 18]);
});

test('jalaliDate: وقت تهران (۲۰:۳۰ UTC = ۰۰:۰۰ روز بعد)', () => {
  assert.deepEqual(jalaliDate('2026-11-09 20:30:00'), { date: '1405/08/19', time: '00:00' });
});
