/**
 * «نیاز به رسیدگی» داشبورد — منطق خالص، بی React (test/dashboard-attention.test.ts).
 *
 * هر مورد سه چیز به کاربر می‌گوید: **چه شده** (عنوان)، **چرا مهم است** (علت)،
 * و **چه باید کرد** (دکمهٔ مجاز، پیوند مجاز، یا جمله‌ای که می‌گوید کار چه کسی
 * است). «هیچ» بدتر از یک جمله است.
 *
 * و سه حالتِ «چیزی نیست» هرگز یکی نمی‌شوند:
 *   خالی     سنجیدیم و درآمد ثبت‌نشده‌ای از روزهای گذشته نیست — «همه‌چیز مرتب».
 *   بی‌دسترسی این نقش اجازهٔ دیدنش را ندارد — «مرتب» گفتن به او اطمینان بی‌پشتوانه است.
 *   خطا      نتوانستیم بسنجیم — ممکن است موردی منتظر باشد؛ «بررسی دوباره».
 *
 * دورهٔ **امروز** نیاز به رسیدگی نیست: باز می‌ماند تا فروش‌های بعدی به آن
 * بنشیند (بستنش هر فروش بعدی را رد می‌کرد). پس «اطلاع» است، نه هشدار، و در
 * شمارش مورد نمی‌آید.
 */
import type { UnpostedRow } from "./pos.ts";
import { canClosePeriod, periodNote } from "./pos.ts";
import { channelLabel, formatCount, formatJalali } from "./format.ts";

export type AttentionAction =
  | { kind: "close" }
  | { kind: "link"; href: string; label: string };

export interface AttentionItem {
  key: string;
  /** `attention`: کاری مانده؛ `info`: فقط اطلاع، کاری لازم نیست. */
  tone: "attention" | "info";
  title: string;
  cause: string;
  action: AttentionAction | null;
  /** وقتی دکمه/پیوندی نیست: کار چه کسی است یا چرا لازم نیست. */
  note: string | null;
  row: UnpostedRow;
}

/**
 * @param mayClose  پاسخ `period.close` — راحتی است، نه دروازه؛ سرور دوباره می‌سنجد.
 * @param posHref   نشانی صندوق اگر این نقش به آن دسترسی **صریح** دارد، وگرنه `null`.
 */
export function attentionItems(rows: readonly UnpostedRow[], today: string, mayClose: boolean, posHref: string | null): AttentionItem[] {
  const items = rows.map((r): AttentionItem => {
    const isToday = r.businessDate === today;
    const title = `${formatCount(r.invoiceCount)} فاکتور ${channelLabel(r.channel)} در ${formatJalali(r.businessDate)} هنوز به دفتر نرفته`;
    // یادداشت «چرا دکمه‌ای نیست» یک تعریف دارد: `periodNote` (test/posting.test.ts).
    const note = periodNote(r, today, mayClose) ?? null;
    if (r.batchKind !== "channel_day") {
      // دورهٔ شیفت: با شمارش و بستن کشو بسته می‌شود، نه از داشبورد.
      const link = !isToday && posHref ? { kind: "link" as const, href: posHref, label: "رفتن به صندوق" } : null;
      return {
        key: r.batchId, tone: isToday ? "info" : "attention", row: r, title,
        cause: isToday
          ? "فاکتورهای شیفت باز صندوق؛ با شمارش کشو و بستن شیفت به دفتر می‌روند. کاری لازم نیست."
          : "شیفت صندوقِ این فاکتورها هنوز بسته نشده؛ تا صندوق‌دار کشو را نشمارد و شیفت را نبندد، فروش و بهای تمام‌شده‌شان در دفتر نیست.",
        action: link, note: link ? null : note,
      };
    }
    if (isToday) {
      return {
        key: r.batchId, tone: "info", row: r, title,
        cause: "دورهٔ امروز تا پایان روز باز می‌ماند تا فروش‌های بعدی هم به آن بنشیند؛ پس از آن بسته و در دفتر ثبت می‌شود. کاری لازم نیست.",
        action: null, note,
      };
    }
    const closable = canClosePeriod(r, today, mayClose);
    return {
      key: r.batchId, tone: "attention", row: r, title,
      cause: closable
        ? "تا این دوره بسته نشود، فروش و بهای تمام‌شدهٔ آن روز در دفتر حسابداری نیست و سود و ترازنامه ناقص‌اند."
        : "تا این دوره بسته نشود، سود و ترازنامه ناقص‌اند؛ به حسابدار یا مدیر خبر دهید.",
      action: closable ? { kind: "close" } : null,
      note: closable ? null : note,
    };
  });
  // کارهای مانده اول، اطلاع‌ها بعد؛ ترتیب سرور درون هر دسته حفظ می‌شود.
  return [...items.filter(i => i.tone === "attention"), ...items.filter(i => i.tone === "info")];
}
