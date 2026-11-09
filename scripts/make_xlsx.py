"""ساخت اکسل حساب‌کتاب از exports/data.json

استفاده: python scripts/make_xlsx.py exports/data.json exports/hesabketab.xlsx

دو برگه: «خلاصه» (با فرمول زنده) و «رکوردها». خلاصه با SUMIFS از رکوردها حساب می‌شود،
پس اگر در اکسل ردیفی را ویرایش کنی، بدهکار/بستانکار خودکار به‌روز می‌شود.
"""
import json
import sys

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.worksheet.properties import PageSetupProperties

src, dst = sys.argv[1], sys.argv[2]
data = json.load(open(src, encoding="utf-8"))
names = {m["id"]: m["name"] for m in data["members"]}
n1, n2 = names.get(1, "نفر ۱"), names.get(2, "نفر ۲")

FONT = "Tahoma"
HEAD_FILL = PatternFill("solid", fgColor="1F4E78")
HEAD_FONT = Font(name=FONT, bold=True, color="FFFFFF")
BASE = Font(name=FONT)
MONEY = "#,##0"

wb = Workbook()
summary = wb.active
summary.title = "خلاصه"
rec = wb.create_sheet("رکوردها")
for ws in (summary, rec):
    ws.sheet_view.rightToLeft = True

# ---------- رکوردها ----------
heads = ["شماره", "تاریخ", "ساعت", "نوع", "شرح", "مبلغ (تومان)", "پرداخت‌کننده",
         f"سهم {n1}", f"سهم {n2}", "ثبت‌کننده", "کد پرداخت‌کننده"]
rec.append(heads)
for c in rec[1]:
    c.font, c.fill = HEAD_FONT, HEAD_FILL
    c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
for r in data["rows"]:
    rec.append([r["id"], r["date"], r["time"], r["type"], r["descr"], r["amount"],
                r["payer_name"], r["share1"], r["share2"], r["by"], r["payer"]])
for row in rec.iter_rows(min_row=2):
    for c in row:
        c.font = BASE
    for c in (row[5], row[7], row[8]):
        c.number_format = MONEY
for col, w in zip("ABCDEFGHIJK", (8, 12, 8, 9, 34, 16, 16, 16, 16, 14, 12)):
    rec.column_dimensions[col].width = w
rec.freeze_panes = "A2"
rec.auto_filter.ref = f"A1:K{max(rec.max_row, 2)}"

# ---------- خلاصه ----------
R = "'رکوردها'!"
summary["A1"] = "حساب‌کتاب"
summary["A1"].font = Font(name=FONT, bold=True, size=16)
summary.append([])
summary.append(["", n1, n2])
for c in summary[3]:
    c.font, c.fill = HEAD_FONT, HEAD_FILL
    c.alignment = Alignment(horizontal="center")
rows = [
    ("پرداخت‌شده برای خریدها",
     f'=SUMIFS({R}$F:$F,{R}$K:$K,1,{R}$D:$D,"خرید")', f'=SUMIFS({R}$F:$F,{R}$K:$K,2,{R}$D:$D,"خرید")'),
    ("سهم مصرف از خریدها",
     f'=SUMIFS({R}$H:$H,{R}$D:$D,"خرید")', f'=SUMIFS({R}$I:$I,{R}$D:$D,"خرید")'),
    ("تسویه‌های پرداخت‌شده",
     f'=SUMIFS({R}$F:$F,{R}$K:$K,1,{R}$D:$D,"تسویه")', f'=SUMIFS({R}$F:$F,{R}$K:$K,2,{R}$D:$D,"تسویه")'),
    ("تسویه‌های دریافت‌شده",
     f'=SUMIFS({R}$H:$H,{R}$D:$D,"تسویه")', f'=SUMIFS({R}$I:$I,{R}$D:$D,"تسویه")'),
    ("تراز نهایی (مثبت = بستانکار)", "=B4-B5+B6-B7", "=C4-C5+C6-C7"),
]
for label, f1, f2 in rows:
    summary.append([label, f1, f2])
for row in summary.iter_rows(min_row=4, max_row=8):
    row[0].font = BASE
    for c in row[1:]:
        c.font, c.number_format = BASE, MONEY
for c in summary[8]:
    c.font = Font(name=FONT, bold=True)

summary["A10"] = (
    f'=IF(B8>0,C3&" باید "&TEXT(B8,"#,##0")&" تومان به "&B3&" بدهد",'
    f'IF(B8<0,B3&" باید "&TEXT(-B8,"#,##0")&" تومان به "&C3&" بدهد","حساب‌ها صاف است ✅"))'
)
summary["A10"].font = Font(name=FONT, bold=True, size=13, color="C00000")
summary.column_dimensions["A"].width = 34
summary.column_dimensions["B"].width = 18
summary.column_dimensions["C"].width = 18

wb.calculation.fullCalcOnLoad = True  # اکسل موقع باز شدن فرمول‌ها را حساب کند
wb.save(dst)
print(f"{dst}: {len(data['rows'])} ردیف")
