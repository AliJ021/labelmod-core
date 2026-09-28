import { useCallback, useSyncExternalStore } from "react";

const changed = "labelmod:navigation";
function subscribe(listener: () => void) {
  window.addEventListener("popstate", listener);
  window.addEventListener(changed, listener);
  return () => { window.removeEventListener("popstate", listener); window.removeEventListener(changed, listener); };
}
const snapshot = () => window.location.search;

export function navigate(href: string, replace = false): void {
  const target = new URL(href, window.location.href);
  if (target.origin !== window.location.origin) return;
  if (target.href === window.location.href) return;
  window.history[replace ? "replaceState" : "pushState"](null, "", target);
  window.dispatchEvent(new Event(changed));
}

export function useUrlState(key: string, fallback = "", replace = false): [string, (value: string) => void] {
  const search = useSyncExternalStore(subscribe, snapshot, () => "");
  const value = new URLSearchParams(search).get(key) ?? fallback;
  const set = useCallback((next: string) => {
    const url = new URL(window.location.href);
    if (next === fallback) url.searchParams.delete(key); else url.searchParams.set(key, next);
    navigate(url.href, replace);
  }, [key, fallback, replace]);
  return [value, set];
}

export function useUrlTab<K extends string>(key: string, items: readonly { key: K }[], fallback: K): [K, (value: K) => void] {
  const [raw, set] = useUrlState(key, fallback);
  return [items.find(item => item.key === raw)?.key ?? fallback, set];
}

export function useUrlFlag(key: string): [boolean, (value: boolean) => void] {
  const [value,setValue]=useUrlState(key);
  const set=useCallback((next:boolean)=>setValue(next?"1":""),[setValue]);
  return [value==="1",set];
}
