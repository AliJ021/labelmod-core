/**
 * فیلد تاریخ جلالی — تنها پیاده‌سازی ورود تاریخ برای فیلترها (گزارش‌ها و فاکتورها).
 *
 * کاربر جلالی می‌نویسد و می‌بیند؛ نشانی و درخواست همان ISO میلادی می‌مانند.
 * تجزیه و تبدیل فقط در `lib/report-filters.ts` است؛ اینجا فقط پیوند آن با
 * وضعیت نشانی و راهنمای کنار فیلد. دو صفحه یک نسخه دارند تا دو سامانهٔ جلالیِ
 * واگرا ساخته نشود.
 */
import { useCallback, useState } from "react";
import { formatGregorian, formatJalali } from "../../lib/format.ts";
import { jalaliInputOf, parseJalaliDate } from "../../lib/report-filters.ts";
import { Ltr } from "./Bidi.tsx";

/**
 * متن فیلد تاریخ جلالی برای یک ISO در نشانی. تایپ نیمه‌کاره محلی می‌ماند و به
 * نشانی نمی‌رود؛ تغییر نشانی از بیرون (بازنشانی، بازگشت مرورگر، بارگذاری) متن را از
 * همان ISO از نو می‌سازد — مگر متن فعلی همان تاریخ باشد (همان‌که کاربر نوشت).
 */
export function useJalaliDraft(iso: string): [string, (text: string) => void] {
  const [draft, setDraft] = useState(() => ({ iso, text: jalaliInputOf(iso) }));
  const set = useCallback((text: string) => setDraft(d => ({ ...d, text })), []);
  if (draft.iso !== iso) {
    const current = parseJalaliDate(draft.text);
    const next = { iso, text: current.kind === "ok" && current.iso === iso ? draft.text : jalaliInputOf(iso) };
    setDraft(next);
    return [next.text, set];
  }
  return [draft.text, set];
}

/** راهنمای فیلد: جلالی کامل (اصلی) و میلادی فقط ثانوی و کم‌رنگ در برگ LTR. */
export function JalaliDateHint({ iso, example }: { iso: string | null; example: string }) {
  if (iso === null) return <>{example}</>;
  return <>{formatJalali(iso, true)} <span className="field-hint-secondary"><Ltr mono={false}>{formatGregorian(iso)}</Ltr></span></>;
}
