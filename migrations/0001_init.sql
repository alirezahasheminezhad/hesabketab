-- دو عضو حساب (نفر ۱ و ۲)؛ با اولین /start هر نفر ثبت می‌شود
CREATE TABLE members (
  id    INTEGER PRIMARY KEY CHECK (id IN (1, 2)),
  tg_id INTEGER NOT NULL UNIQUE,
  name  TEXT NOT NULL
);

-- هر خرید یا تسویه یک ردیف است.
-- payer = کسی که پول را داده؛ share1/share2 = سهم هر نفر (جمع = amount)
-- status: draft (منتظر انتخاب سهم) | ok | void (حذف‌شده، برای سابقه نگه داشته می‌شود)
CREATE TABLE expenses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL DEFAULT 'expense',
  status     TEXT NOT NULL DEFAULT 'ok',
  amount     INTEGER NOT NULL,
  payer      INTEGER NOT NULL,
  share1     INTEGER NOT NULL DEFAULT 0,
  share2     INTEGER NOT NULL DEFAULT 0,
  descr      TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_expenses_status ON expenses (status);

-- وقتی کاربر دکمهٔ «سهم بخشی» را زده و منتظر نوشتن مبلغ/درصد هستیم
CREATE TABLE state (
  user_id    INTEGER PRIMARY KEY,
  expense_id INTEGER NOT NULL,
  idx        INTEGER NOT NULL,
  chat_id    INTEGER NOT NULL,
  msg_id     INTEGER NOT NULL,
  ts         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
