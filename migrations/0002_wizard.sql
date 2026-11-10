-- ثبت مرحله‌به‌مرحله با دکمه: پیش‌نویس هر خرید/تسویه مرحلهٔ فعلی‌اش را نگه می‌دارد
ALTER TABLE expenses ADD COLUMN step TEXT;
ALTER TABLE expenses ADD COLUMN pidx INTEGER;

-- منتظر چه ورودی تایپی از کاربر هستیم (amount | descr | part | name) و پیام درخواست کدام است
ALTER TABLE state ADD COLUMN kind TEXT;
ALTER TABLE state ADD COLUMN prompt_id INTEGER;
