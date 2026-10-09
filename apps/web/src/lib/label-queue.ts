/**
 * فهرست چاپ گروهی لیبل — میان کالاها می‌ماند.
 *
 * صفحهٔ کالا با هر انتخاب دوباره ساخته می‌شود، پس فهرست بیرون از
 * کامپوننت نگه داشته می‌شود. در `sessionStorage` هم می‌نشیند تا Reload
 * فهرست نیمه‌کاره را نخورد؛ نبودِ ذخیره‌ساز (حالت خصوصی) فقط پایداری را
 * از دست می‌دهد، نه کار را. این فهرست هیچ اثر مالی یا انباری ندارد.
 */
import { useSyncExternalStore } from "react";
import { mergeQueue, setQueueCount, syncQueueMeta, type QueueItem } from "./label-print.ts";

const KEY = "labelmod.label-queue.v1";
let items: QueueItem[] = read();
const listeners = new Set<() => void>();

function read(): QueueItem[] {
  try {
    const raw = globalThis.sessionStorage?.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((i): i is QueueItem => typeof i === "object" && i !== null
        && typeof (i as QueueItem).variationId === "string" && typeof (i as QueueItem).count === "number")
      : [];
  } catch { return []; }
}

function commit(next: QueueItem[]) {
  items = next;
  try { globalThis.sessionStorage?.setItem(KEY, JSON.stringify(next)); } catch { /* فقط پایداری از دست می‌رود */ }
  for (const l of listeners) l();
}

export const labelQueue = {
  add: (adds: QueueItem[]) => commit(mergeQueue(items, adds)),
  setCount: (variationId: string, count: number) => commit(setQueueCount(items, variationId, count)),
  clear: () => commit([]),
  /** دادهٔ تازهٔ کاتالوگ (پس از تعیین قیمت) به تنوع‌های موجود فهرست می‌رسد. */
  syncMeta: (facts: Parameters<typeof syncQueueMeta>[1]) => {
    const next = syncQueueMeta(items, facts);
    if (next !== items) commit([...next]);
  },
};

export function useLabelQueue(): QueueItem[] {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => items,
    () => items,
  );
}
