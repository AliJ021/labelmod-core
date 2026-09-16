import { useEffect, useId, useRef, useState, type ReactNode, type CSSProperties } from "react";

export interface TabItem<K extends string> { key: K; label: string; group?: string }

/** تب‌ها دستی فعال می‌شوند؛ حرکت فوکوس، درخواست شبکه یا تغییر صفحه نمی‌سازد. */
export function TabList<K extends string>({ id, items, value, onChange, label, className = "subtabs", vertical = false }: {
  id: string;
  items: readonly TabItem<K>[];
  value: K;
  onChange: (value: K) => void;
  label: string;
  className?: string;
  vertical?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [focusKey, setFocusKey] = useState(value);
  useEffect(() => setFocusKey(value), [value]);
  return <div ref={root} className={className} role="tablist" aria-label={label} aria-orientation={vertical ? "vertical" : "horizontal"}>
    {items.map((item, index) => <div className="tab-item" role="presentation" key={item.key}>
      {item.group && items[index - 1]?.group !== item.group ? <span className="tab-group" role="presentation">{item.group}</span> : null}
      <button id={`${id}-tab-${item.key}`} type="button" role="tab" aria-selected={value === item.key} aria-controls={`${id}-panel-${item.key}`} tabIndex={focusKey === item.key ? 0 : -1} className={value === item.key ? "on" : ""}
        onClick={() => onChange(item.key)}
        onFocus={(e) => { setFocusKey(item.key); e.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" }); }}
        onKeyDown={(e) => {
          const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
          let next: number | undefined;
          if (e.key === "Home") next = 0;
          else if (e.key === "End") next = items.length - 1;
          else if (e.key === (vertical ? "ArrowDown" : rtl ? "ArrowLeft" : "ArrowRight")) next = (index + 1) % items.length;
          else if (e.key === (vertical ? "ArrowUp" : rtl ? "ArrowRight" : "ArrowLeft")) next = (index - 1 + items.length) % items.length;
          if (next !== undefined) {
            e.preventDefault();
            root.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
          }
        }}>{item.label}</button>
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

export function SettingsNavigation<K extends string>({ id, items, value, onChange, mobile }: {
  id: string; items: readonly TabItem<K>[]; value: K; onChange: (value: K) => void; mobile: boolean;
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
    </select></label> : <TabList id={id} items={items} value={value} onChange={onChange} label="بخش‌های تنظیمات" className="subtabs settings-tabs" vertical />}
  </div>;
}
