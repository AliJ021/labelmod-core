import { useEffect, useRef } from "react";
import { Glass } from "../Glass.tsx";
import { Icon } from "../Icon.tsx";
import { TabList } from "../Tabs.tsx";
import { routeUrl, type NavItem, type Zone } from "../../lib/navigation.ts";

/**
 * ناوبری اصلی — یک tablist، سه نمایش (docs/UI_PATTERNS.md، «پوسته»).
 *
 *   ≥ ۹۰۰px  نوار کناری گروه‌بندی‌شده با آیکون.
 *   < ۹۰۰px  نوار پایین با مقصدهای `mobilePrimary` + «بیشتر».
 *   «بیشتر»  برگهٔ گروه‌بندی‌شدهٔ همهٔ مقصدها روی همان tablist.
 *
 * «بیشتر» الگوی disclosure است نه Dialog: همان tablist باز می‌شود تا
 * ترتیب کیبورد و یک توقف Tab حفظ شود. Esc و لمس پس‌زمینه می‌بندند و
 * فوکوس به دکمهٔ «بیشتر» برمی‌گردد.
 */
export function ShellNav({ id, items, zone, onZone, compact, more, onMore }: {
  id: string;
  items: readonly NavItem[];
  zone: Zone;
  onZone: (next: Zone) => void;
  compact: boolean;
  more: boolean;
  onMore: (open: boolean) => void;
}) {
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!more || !compact) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onMore(false);
      toggle.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [more, compact, onMore]);
  // بخش باز که در نوار پایین نیست: «بیشتر» حالت انتخاب می‌گیرد تا کاربر بداند کجاست.
  const current = items.find(z => z.key === zone);
  const insideMore = compact && !more && current !== undefined && !current.mobilePrimary;
  const tabs = items.map(z => ({ key: z.key, label: z.label, group: z.group, primary: z.mobilePrimary, icon: <Icon name={z.icon} /> }));
  return <>
    {compact && more ? <div className="nav-scrim" aria-hidden="true" onClick={() => onMore(false)} /> : null}
    <Glass as="nav" className="workspace-nav" refract={false} aria-label="ناوبری اصلی">
      {compact && more ? <p className="nav-sheet-title">همهٔ بخش‌ها</p> : null}
      <TabList id={id} items={tabs} value={zone} onChange={onZone} label="بخش‌ها" className="zones workspace-zones" vertical={!compact} hrefFor={key => routeUrl(key)} />
      <button ref={toggle} type="button" className="workspace-more" aria-expanded={more} aria-label={more ? "بستن بخش‌های بیشتر" : "بخش‌های بیشتر"}
        aria-description={insideMore ? `بخش باز: ${current.label}` : undefined} data-current={insideMore ? "" : undefined} onClick={() => onMore(!more)}>
        <Icon name={more ? "close" : "more"} />
        <span className="tab-label">{more ? "بستن" : "بیشتر"}</span>
      </button>
    </Glass>
  </>;
}
