-- پیام‌هایی که ربات باید در زمان del_at (میلی‌ثانیه) پاکشان کند
CREATE TABLE ttl (
  chat_id INTEGER NOT NULL,
  msg_id  INTEGER NOT NULL,
  del_at  INTEGER NOT NULL,
  PRIMARY KEY (chat_id, msg_id)
);
CREATE INDEX idx_ttl_at ON ttl (del_at);
