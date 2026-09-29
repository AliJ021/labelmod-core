import type { ReactNode } from "react";
import { Glass } from "../Glass.tsx";
import { Icon } from "../Icon.tsx";
import { FeatureSearch } from "../FeatureSearch.tsx";
import { useOnline } from "../../lib/use-online.ts";

/**
 * نوار بالای پوسته: نشان، جست‌وجوی سراسری، وضعیت اتصال و حساب.
 *
 * جای اعلان‌ها عمداً خالی است: هنوز منبع اعلان سروری وجود ندارد و
 * زنگوله‌ای که چیزی نمی‌شمارد، یک ادعای ساختگی است
 * (docs/UI_PATTERNS.md، «اعلان‌ها» و «سلامت عملیاتی»).
 */
export function ShellHeader({ searchKey, tools }: { searchKey: string; tools: ReactNode }) {
  const online = useOnline();
  return <>
    <Glass as="header" radius="md" className="workspace-header" refract={false}>
      <strong className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">لیبل مد</span>
      </strong>
      <FeatureSearch key={searchKey} />
      {tools}
    </Glass>
    {online ? null : <p className="shell-offline" role="alert">
      <Icon name="offline" size="sm" />
      <span>اتصال این دستگاه قطع است. تا برقراری دوباره، هیچ عمل مالی را دو بار تکرار نکنید؛ نتیجهٔ کارهای نیمه‌تمام را پس از اتصال بررسی کنید.</span>
    </p>}
  </>;
}
