/**
 * کارت همگام‌سازی سایت (داشبورد، دستهٔ C) — قرارداد پاسخ `/dashboard/stock-sync` و نمای خالص آن.
 *
 * دو جهت هرگز در یک عدد جمع نمی‌شوند. «نامعلوم» نه صفر است و نه سبز: شماری که سرور `null` داده
 * «—» با دلیل نشان داده می‌شود، و جهتی که خوانده نشد وضعیت «نامعلوم» می‌گیرد، نه «سالم».
 */
import { api, type RequestOptions } from "./api.ts";
import type { StatusState } from "./status.ts";
import { formatCount } from "./format.ts";

export type CoreSampleState = "retrying" | "leaseExpired" | "deadExhausted" | "deadRejected";

export interface CoreToWoo {
  enabled: boolean; misconfigured: boolean; reconcileMinutes: number;
  counts: { due: number; scheduled: number; retrying: number; running: number; leaseExpired: number; deadExhausted: number; deadRejected: number };
  oldestOpenSeconds: number | null;
  lastSentAt: string | null;
  sample: { total: number; items: { id: string; topic: string; state: CoreSampleState; attempts: number; ageSeconds: number; hasError: boolean }[] };
}

export interface WooCounts {
  due: number | null; scheduled: number | null; running: number | null; deferred: number | null;
  busy: number | null; stoppedTasks: number | null; failedRows: number | null;
}

export type WooToCore =
  | { state: "known"; backend: "action-scheduler" | "wp-cron"; counts: WooCounts; fetchedAt: string }
  | { state: "unknown"; code: string; message: string; fetchedAt: string };

export interface StockSync { checkedAt: string; coreToWoo: CoreToWoo; wooToCore: WooToCore }

export const stockSync = {
  read: (opts?: RequestOptions) => api.get<StockSync>("/dashboard/stock-sync", opts),
};

export interface SyncRow { key: string; label: string; count: number | null; hint: string; tone: "neutral" | "warn" | "crit" }

/** حالت‌های Core → سایت، هر کدام جدا. ترتیب: جریان عادی، بعد مشکل‌ها از سبک به سنگین. */
export function coreRows(c: CoreToWoo): SyncRow[] {
  const n = c.counts;
  return [
    { key: "due", label: "در صف", count: n.due, hint: "سررسیده، منتظر Worker", tone: "neutral" },
    { key: "scheduled", label: "زمان‌بندی‌شده", count: n.scheduled, hint: "هنوز سررسید نشده", tone: "neutral" },
    { key: "running", label: "در حال ارسال", count: n.running, hint: "اجارهٔ معتبر Worker", tone: "neutral" },
    { key: "retrying", label: "در انتظار تلاش دوباره", count: n.retrying, hint: "تلاش قبلی ناموفق؛ تأخیر تصاعدی", tone: n.retrying > 0 ? "warn" : "neutral" },
    { key: "leaseExpired", label: "اجارهٔ منقضی", count: n.leaseExpired, hint: "Worker پیش از پایان ایستاد (خرابی، نه تصمیم)؛ دوباره برداشته می‌شود", tone: n.leaseExpired > 0 ? "warn" : "neutral" },
    { key: "deadExhausted", label: "متوقف: تلاش‌ها تمام شد", count: n.deadExhausted, hint: "خودکار دوباره فرستاده نمی‌شود", tone: n.deadExhausted > 0 ? "crit" : "neutral" },
    { key: "deadRejected", label: "متوقف: رد قطعی", count: n.deadRejected, hint: "خودکار دوباره فرستاده نمی‌شود", tone: n.deadRejected > 0 ? "crit" : "neutral" },
  ];
}

export function coreVerdict(c: CoreToWoo): { state: StatusState; label: string } {
  const n = c.counts;
  const dead = n.deadExhausted + n.deadRejected;
  if (dead > 0) return { state: "attention", label: `${formatCount(dead)} پیام متوقف شده و خودکار دوباره فرستاده نمی‌شود` };
  if (c.enabled && c.misconfigured) return { state: "attention", label: "ارسال روشن است ولی انبار سایت تعیین نشده؛ هیچ پیامی ساخته نمی‌شود" };
  if (n.leaseExpired > 0) return { state: "warning", label: "Worker پیش از پایان کار ایستاده است" };
  if (n.retrying > 0) return { state: "warning", label: "ارسال‌هایی منتظر تلاش دوباره‌اند" };
  if (!c.enabled) return { state: "pending", label: "ارسال لحظه‌ای خاموش است؛ سایت فقط از خوراک دوره‌ای به‌روز می‌شود" };
  if (n.due + n.scheduled + n.running > 0) return { state: "active", label: "در جریان" };
  return { state: "completed", label: "صف خالی است" };
}

/**
 * سایت → Core. هر شماری که افزونه نداده («—») نامعلوم است. `failedRows` سطر نگه‌داشتهٔ Action Scheduler
 * است، نه کار منطقی؛ «متوقف» فقط شکست غیرمنتظره است — توقف تجاری (رد قطعی سفارش) شمرده نمی‌شود.
 */
export function wooRows(c: WooCounts): SyncRow[] {
  const w = (v: number | null, tone: SyncRow["tone"]) => v !== null && v > 0 ? tone : "neutral";
  return [
    { key: "due", label: "در صف", count: c.due, hint: "سررسیده، منتظر اجرای افزونه", tone: "neutral" },
    { key: "scheduled", label: "زمان‌بندی‌شده", count: c.scheduled, hint: "شامل تلاش دوباره با تأخیر", tone: "neutral" },
    { key: "running", label: "در حال اجرا", count: c.running, hint: "اقدام در دست اجرا", tone: "neutral" },
    { key: "deferred", label: "معوق", count: c.deferred, hint: "منتظر آزاد شدن قفل صف", tone: w(c.deferred, "warn") },
    { key: "busy", label: "مشغول", count: c.busy, hint: "کار هم‌زمان در حال اجرا", tone: "neutral" },
    { key: "stoppedTasks", label: "متوقف با شکست غیرمنتظره", count: c.stoppedTasks, hint: "توقف تجاری (رد قطعی) اینجا شمرده نمی‌شود؛ خودکار تکرار نمی‌شود", tone: w(c.stoppedTasks, "crit") },
    { key: "failedRows", label: "سطرهای ناموفق Action Scheduler", count: c.failedRows, hint: "سطر نگه‌داشته، نه شمار کارها", tone: w(c.failedRows, "warn") },
  ];
}

export function wooVerdict(w: WooToCore): { state: StatusState; label: string } {
  if (w.state === "unknown") return { state: "unknown", label: `نامعلوم — ${w.message}` };
  const c = w.counts;
  if (c.stoppedTasks !== null && c.stoppedTasks > 0) return { state: "attention", label: `${formatCount(c.stoppedTasks)} کار با شکست غیرمنتظره متوقف شده است` };
  const missing = wooRows(c).filter(r => r.count === null).length;
  // تا وقتی حتی یک شمار نامعلوم است، «سالم» گفته نمی‌شود.
  if (missing > 0) return { state: "unknown", label: "بخشی از وضعیت صف را افزونه گزارش نکرد" };
  if ((c.deferred ?? 0) > 0 || (c.failedRows ?? 0) > 0) return { state: "warning", label: "صف افزونه کار معوق یا سطر ناموفق دارد" };
  if ((c.due ?? 0) + (c.scheduled ?? 0) + (c.running ?? 0) > 0) return { state: "active", label: "در جریان" };
  return { state: "completed", label: "صف خالی است" };
}

/** «۳ دقیقه»، «۲ ساعت»، «۱ روز» — بازهٔ تقریبی برای سن پیام، با رقم فارسی. */
export function formatAge(seconds: number): string {
  if (seconds < 60) return "کمتر از یک دقیقه";
  if (seconds < 3600) return `${formatCount(Math.floor(seconds / 60))} دقیقه`;
  if (seconds < 86400) return `${formatCount(Math.floor(seconds / 3600))} ساعت`;
  return `${formatCount(Math.floor(seconds / 86400))} روز`;
}

const TOPICS: Record<string, string> = {
  "web.stock_push": "موجودی", "web.price_push": "قیمت", "web.instore_push": "خرید حضوری",
};
export function topicLabel(topic: string): string {
  return TOPICS[topic] ?? "موضوع دیگر";
}

export const SAMPLE_STATE_LABEL: Record<CoreSampleState, string> = {
  retrying: "تلاش دوباره", leaseExpired: "اجارهٔ منقضی", deadExhausted: "متوقف: تلاش‌ها تمام شد", deadRejected: "متوقف: رد قطعی",
};
