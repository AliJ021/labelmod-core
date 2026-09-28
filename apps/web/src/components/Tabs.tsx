import { useEffect, useId, useRef, useState, type ReactNode, type CSSProperties } from "react";

export interface TabItem<K extends string> { key: K; label: string; group?: string }

/** تب‌ها دستی فعال می‌شوند؛ حرکت فوکوس، درخواست شبکه یا تغییر صفحه نمی‌سازد. */
export function TabList<K extends string>({ id, items, value, onChange, label, className = "subtabs", vertical = false, hrefFor }: {
  id: string;
  items: readonly TabItem<K>[];
  value: K;
  onChange: (value: K) => void;
  label: string;
  className?: string;
  vertical?: boolean;
  hrefFor?: (value: K) => string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [focusKey, setFocusKey] = useState(value);
  useEffect(() => {
    const update = () => {
      const visible = [...(root.current?.querySelectorAll<HTMLAnchorElement>("[role=tab]") ?? [])]
        .filter(tab => tab.getClientRects().length > 0);
      const selected = visible.find(tab => tab.getAttribute("aria-selected") === "true");
      const destination = selected ?? visible[0];
      if (destination) {
        const item = items.find(item => destination.id === `${id}-tab-${item.key}`);
        if (item) setFocusKey(item.key);
      }
    };
    update();
    const observer = new ResizeObserver(update);
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, [value, items, id, vertical]);
  return <div ref={root} className={className} role="tablist" aria-label={label} aria-orientation={vertical ? "vertical" : "horizontal"}>
    {items.map((item, index) => <div className="tab-item" role="presentation" key={item.key}>
      {item.group && items[index - 1]?.group !== item.group ? <span className="tab-group" role="presentation">{item.group}</span> : null}
      <a id={`${id}-tab-${item.key}`} href={hrefFor?.(item.key) ?? `#${id}-panel-${item.key}`} role="tab" aria-selected={value === item.key} aria-controls={`${id}-panel-${item.key}`} tabIndex={focusKey === item.key ? 0 : -1} className={value === item.key ? "on" : ""}
        onClick={e => { if ((e.ctrlKey || e.metaKey || e.shiftKey || e.altKey)) return; e.preventDefault(); onChange(item.key); }}
        onFocus={(e) => { setFocusKey(item.key); e.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" }); }}
        onKeyDown={(e) => {
          if (e.key === " ") { e.preventDefault(); onChange(item.key); return; }
          const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
          const tabs = [...(root.current?.querySelectorAll<HTMLAnchorElement>("[role=tab]") ?? [])]
            .filter(tab => tab.getClientRects().length > 0);
          const current = tabs.indexOf(e.currentTarget);
          let next: number | undefined;
          if (e.key === "Home") next = 0;
          else if (e.key === "End") next = tabs.length - 1;
          else if (e.key === (vertical ? "ArrowDown" : rtl ? "ArrowLeft" : "ArrowRight")) next = (current + 1) % tabs.length;
          else if (e.key === (vertical ? "ArrowUp" : rtl ? "ArrowRight" : "ArrowLeft")) next = (current - 1 + tabs.length) % tabs.length;
          if (next !== undefined) { e.preventDefault(); tabs[next]?.focus(); }

        }}>{item.label}</a>
    </div>)}
  </div>;
}

/** پنل غیرفعال خالی می‌ماند؛ شناسه‌های ARIA معتبرند و صفحه پنهان بارگذاری نمی‌شود. */
export function TabPanels<K extends string>({ id, items, value, children, className, style, mobileLabel = false }: {
  id: string; items: readonly TabItem<K>[]; value: K; children: ReactNode;
  className?: string; style?: CSSProperties; mobileLabel?: boolean;
}) {
  return <>{items.map(item => <div key={item.key} id={`${id}-panel-${item.key}`} role="tabpanel" aria-labelledby={mobileLabel ? undefined : `${id}-tab-${item.key}`} aria-label={mobileLabel ? item.label : undefined} tabIndex={0} hidden={value !== item.key} className={className} style={style}>
    {value === item.key ? children : null}
  </div>)}</>;
}

export function useTabsId() { return useId(); }

export function SettingsNavigation<K extends string>({ id, items, value, onChange, mobile, hrefFor }: {
  id: string; items: readonly TabItem<K>[]; value: K; onChange: (value: K) => void; mobile: boolean; hrefFor?: (value: K) => string;
}) {
  const area = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current) area.current?.querySelector<HTMLElement>('select, [role="tab"][aria-selected="true"]')?.focus();
  }, [mobile]);
  const groups = [...new Set(items.map(item => item.group ?? "بخش‌ها"))];
  return <div ref={area} className="settings-nav" onFocusCapture={() => { focused.current = true; }} onBlurCapture={e => { if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) focused.current = false; }}>
    {mobile ? <label className="settings-picker"><span>بخش تنظیمات</span><select value={value} aria-controls={`${id}-panel-${value}`} onChange={e => onChange(e.target.value as K)}>
      {groups.map(group => <optgroup label={group} key={group}>{items.filter(item => (item.group ?? "بخش‌ها") === group).map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</optgroup>)}
    </select></label> : <TabList id={id} items={items} value={value} onChange={onChange} label="بخش‌های تنظیمات" className="subtabs settings-tabs" vertical {...(hrefFor ? { hrefFor } : {})} />}
  </div>;
}
