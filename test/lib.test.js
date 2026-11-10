import test from 'node:test';
import assert from 'node:assert/strict';
import { computeShares, balance, nextVal, money, g2j, jalaliDate } from '../src/lib.js';

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

test('nextVal: کیبورد عددی', () => {
  assert.equal(nextVal(0, '5'), 5);
  assert.equal(nextVal(5, '00'), 500);
  assert.equal(nextVal(500, '000'), 500000);
  assert.equal(nextVal(0, '0'), 0);
  assert.equal(nextVal(0, '000'), 0);
  assert.equal(nextVal(500000, 'b'), 50000);
  assert.equal(nextVal(5, 'b'), 0);
  assert.equal(nextVal(0, 'b'), 0);
  assert.equal(nextVal(999999999999, '0'), 999999999999); // سقف ۱۲ رقم
  assert.equal(nextVal(7, 'ok'), 7);
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
