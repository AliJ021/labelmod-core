/**
 * پاسخ سرور به «این کاربر کدام بخش‌ها را می‌بیند؟» — فقط برای نمایش ناوبری.
 *
 * همهٔ پرسش‌ها موازی و با یک AbortController: قفل و خروج پوسته را
 * Unmount می‌کنند و هیچ درخواستی نباید پس از آن فرستاده شود (همان قاعدهٔ
 * داشبورد). پاسخ ناموفق «نامعلوم» است نه «رد»؛ `visibleZones` نامعلوم را
 * نشان می‌دهد و سرور دروازه می‌ماند.
 */
import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { NAV_OPERATIONS, type Verdict } from "./navigation.ts";

export function useNavAccess(userKey: string | null): ReadonlyMap<string, Verdict> {
  const [verdicts, setVerdicts] = useState<ReadonlyMap<string, Verdict>>(new Map());
  useEffect(() => {
    setVerdicts(new Map());
    if (userKey === null) return;
    const controller = new AbortController();
    void Promise.allSettled(NAV_OPERATIONS.map(async operation => {
      const answer = await api.get<{ verdict: string }>(`/auth/can?operation=${encodeURIComponent(operation)}`, { signal: controller.signal });
      return [operation, answer.verdict === "allow" ? "allow" : "deny"] as const;
    })).then(results => {
      if (controller.signal.aborted) return;
      setVerdicts(new Map(results.flatMap(r => r.status === "fulfilled" ? [r.value] : [])));
    });
    return () => controller.abort();
  }, [userKey]);
  return verdicts;
}
