/**
 * طبقه‌بندی نتیجهٔ یک عمل مالی (docs/UI_PATTERNS.md، «عمل مالی ایمن»).
 *
 *   failed   سرور صریحاً رد کرد (۴xx). اثری نمانده و پیامش فارسی و
 *            برای کاربر است؛ تکرار پس از اصلاح بی‌خطر است.
 *   unknown  پاسخ قطعی نرسید: قطع شبکه، ۵xx، پراکسی. ممکن است اثر
 *            نشسته باشد. **ارسال دوباره پیشنهاد نمی‌شود**؛ اول وضعیت از
 *            سرور خوانده می‌شود.
 */
import { ApiError } from "./api.ts";

export type SafeActionPhase = "idle" | "confirm" | "pending" | "failed" | "unknown" | "verifying" | "done";

export interface ActionFailure { kind: "failed" | "unknown"; message: string; reference: string | null }

export function classifyFailure(err: unknown): ActionFailure {
  if (err instanceof ApiError && err.status < 500) {
    return { kind: "failed", message: err.message, reference: err.correlationId };
  }
  return {
    kind: "unknown",
    message: "پاسخ قطعی از سرور نرسید. ممکن است عملیات انجام شده باشد یا نه؛ پیش از هر کار دیگری وضعیت را بررسی کنید.",
    reference: err instanceof ApiError ? err.correlationId : null,
  };
}

/** آیا دکمهٔ تأیید در این مرحله مجاز است؟ نامعلوم و در حال اجرا هرگز. */
export function mayConfirm(phase: SafeActionPhase): boolean {
  return phase === "confirm" || phase === "failed";
}
