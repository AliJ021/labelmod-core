/**
 * پاسخ سرور به «این کاربر کدام بخش‌ها را می‌بیند؟» — فقط برای نمایش ناوبری
 * و بخش‌های تنظیمات. دروازهٔ واقعی همچنان سرور است.
 *
 * همهٔ پرسش‌ها موازی و با یک AbortController: قفل و خروج پوسته را
 * Unmount می‌کنند و هیچ درخواستی نباید پس از آن فرستاده شود (همان قاعدهٔ
 * داشبورد).
 *
 * وضعیت صریح است، نه «نقشهٔ خالی یعنی همه» (یافتهٔ F-110-01):
 *   loading   پرسش‌ها در راه‌اند؛ مقصد مجوزدار هنوز دیده نمی‌شود.
 *   ready     همه برگشتند.
 *   degraded  دست‌کم یکی نرسید؛ همان‌ها «نامعلوم» و پنهان می‌مانند و
 *             `retry` فقط همان‌ها را دوباره می‌پرسد. نامعلوم هرگز «allow» نمی‌شود.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { NAV_OPERATIONS, type AccessState, type NavAccess, type Verdict } from "./navigation.ts";

interface Snapshot { key: string | null; state: AccessState; verdicts: ReadonlyMap<string, Verdict> }
const NONE: ReadonlyMap<string, Verdict> = new Map();

export function useNavAccess(userKey: string | null): NavAccess {
  const [snapshot, setSnapshot] = useState<Snapshot>({ key: userKey, state: "loading", verdicts: NONE });
  const [attempt, setAttempt] = useState(0);
  // پاسخ‌های صریحِ همین کاربر؛ تلاش دوباره فقط بقیه را می‌پرسد.
  const memory = useRef<{ key: string | null; verdicts: Map<string, Verdict> }>({ key: null, verdicts: new Map() });
  // کاربر یا ارتقای نشست عوض شد: پاسخ‌های قبلی مال کس دیگری است.
  const current = snapshot.key === userKey ? snapshot : { key: userKey, state: "loading" as const, verdicts: NONE };
  useEffect(() => {
    if (userKey === null) return;
    if (memory.current.key !== userKey) memory.current = { key: userKey, verdicts: new Map() };
    const known = memory.current.verdicts;
    const controller = new AbortController();
    setSnapshot({ key: userKey, state: "loading", verdicts: new Map(known) });
    const ask = NAV_OPERATIONS.filter(op => !known.has(op));
    void Promise.allSettled(ask.map(async operation => {
      const answer = await api.get<{ verdict: string }>(`/auth/can?operation=${encodeURIComponent(operation)}`, { signal: controller.signal });
      return [operation, answer.verdict === "allow" ? "allow" : "deny"] as const;
    })).then(results => {
      if (controller.signal.aborted) return;
      for (const r of results) if (r.status === "fulfilled") known.set(r.value[0], r.value[1]);
      setSnapshot({ key: userKey, state: results.every(r => r.status === "fulfilled") ? "ready" : "degraded", verdicts: new Map(known) });
    });
    return () => controller.abort();
  }, [userKey, attempt]);
  const retry = useCallback(() => setAttempt(n => n + 1), []);
  return { state: current.state, verdicts: current.verdicts, retry };
}
