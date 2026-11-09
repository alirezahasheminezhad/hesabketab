import test from 'node:test';
import assert from 'node:assert/strict';
import {
  norm, amountAt, parseExpense, parseSettle, parseShareInput, intent,
  computeShares, balance, money, g2j, jalaliDate,
} from '../src/lib.js';

const members = [{ id: 1, name: 'علیرضا' }, { id: 2, name: 'احمد' }];

test('norm: ارقام فارسی و جداکننده', () => {
  assert.equal(norm('۵۰۰٬۰۰۰  تومان'), '500,000 تومان');
});

test('amountAt: واحدها و ترکیب', () => {
  const v = (s) => amountAt(norm(s))?.value;
  assert.equal(v('500 هزار'), 500000);
  assert.equal(v('۱.۵ میلیون'), 1500000);
  assert.equal(v('۱٫۵ میلیون'), 1500000);
  assert.equal(v('1,5 میلیون'), 1500000);
  assert.equal(v('2 میلیون و 500 هزار'), 2500000);
  assert.equal(v('1,200,000'), 1200000);
  assert.equal(v('1.200.000'), 1200000);
  assert.equal(v('500000 تومان'), 500000);
  assert.equal(v('300k'), 300000);
  assert.equal(v('پوشک'), undefined);
});

test('parseExpense: بدون سهم', () => {
  const p = parseExpense('۵۰۰ هزار پوشک', members, 1);
  assert.deepEqual(p, { amount: 500000, descr: 'پوشک', split: null });
});

test('parseExpense: نصف', () => {
  assert.equal(parseExpense('۱.۲ میلیون شام نصف', members, 1).split.type, 'half');
  assert.equal(parseExpense('۱ میلیون نصف نصف اجاره', members, 1).descr, 'اجاره');
});

test('parseExpense: «نصف کیلو» نباید تقسیم حساب شود', () => {
  const p = parseExpense('2 میلیون نصف کیلو زعفران', members, 1);
  assert.equal(p.split, null);
  assert.equal(p.descr, 'نصف کیلو زعفران');
});

test('parseExpense: حساب احمد / حساب من', () => {
  assert.deepEqual(parseExpense('300 هزار کرایه حساب احمد', members, 1).split, { type: 'owner', idx: 2 });
  assert.deepEqual(parseExpense('300 هزار کرایه حساب من', members, 2).split, { type: 'owner', idx: 2 });
  // نام ناشناس = بی‌اثر
  assert.equal(parseExpense('300 هزار حساب بانکی', members, 1).split, null);
});

test('parseExpense: سهم مبلغی و درصدی', () => {
  const a = parseExpense('800 هزار لوازم سهم احمد 200 هزار', members, 1);
  assert.deepEqual(a.split, { type: 'part', idx: 2, value: 200000 });
  assert.equal(a.descr, 'لوازم');
  const b = parseExpense('1 میلیون سهم احمد ۳۰٪ هدیه', members, 1);
  assert.deepEqual(b.split, { type: 'part', idx: 2, pct: 30 });
  assert.equal(b.descr, 'هدیه');
});

test('parseExpense: چت معمولی خرید حساب نمی‌شود', () => {
  assert.equal(parseExpense('5 تا نون گرفتم', members, 1), null);
  assert.equal(parseExpense('سلام', members, 1), null);
  assert.deepEqual(parseExpense('خرید 5', members, 1), { error: 'amount' });
});

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

test('parseSettle', () => {
  assert.deepEqual(parseSettle('تسویه ۵۰۰ هزار'), { kind: 'pay', value: 500000 });
  assert.deepEqual(parseSettle('دریافت 1 میلیون'), { kind: 'recv', value: 1000000 });
  assert.deepEqual(parseSettle('تسویه کامل'), { kind: 'pay', full: true });
  assert.equal(parseSettle('تسویه کردم'), null);
});

test('parseShareInput', () => {
  assert.equal(parseShareInput('200 هزار', 800000), 200000);
  assert.equal(parseShareInput('۲۵٪', 800000), 200000);
  assert.equal(parseShareInput('2 میلیون', 800000), null); // بیشتر از کل مبلغ
  assert.equal(parseShareInput('200', 800000), null); // بدون واحد، مبهم
});

test('intent', () => {
  assert.equal(intent('/balance@hesabketab_bot', members, 1).name, 'balance');
  assert.equal(intent('/name علی', members, 1).arg, 'علی');
  assert.equal(intent('حساب', members, 1).name, 'balance');
  assert.equal(intent('حذف ۱۲', members, 1).arg, '12');
  assert.equal(intent('تسویه ۵۰۰ هزار', members, 1).type, 'settle');
  assert.equal(intent('500 هزار پوشک', members, 1).type, 'expense');
  assert.equal(intent('سلام خوبی؟', members, 1), null);
  assert.equal(intent('خرید 5', members, 1).type, 'hint');
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
