import type { KeyValueStorage } from "./queue-store.ts";

export interface PendingScan {
  actorId: string;
  invoiceId: string;
  shiftId: string;
  key: string;
  body: { qty: "1"; barcode?: string; variationId?: string };
}
const storageKey = (actorId: string) => `labelmod_pending_scan_v1:${actorId}`;
export function readPendingScan(actorId: string, store: KeyValueStorage = localStorage): PendingScan | null {
  const raw = store.getItem(storageKey(actorId));
  if (!raw) return null;
  const r = JSON.parse(raw) as Partial<PendingScan>;
  const uuid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  if (!r || r.actorId !== actorId || !uuid(r.actorId) || !uuid(r.invoiceId) || !uuid(r.shiftId) || !uuid(r.key) || !r.body || r.body.qty !== "1" ||
      Object.keys(r.body).some(k => !["qty", "barcode", "variationId"].includes(k)) ||
      (r.body.variationId !== undefined ? !uuid(r.body.variationId) || r.body.barcode !== undefined :
        typeof r.body.barcode !== "string" || r.body.barcode.length < 1 || r.body.barcode.length > 64))
    throw new Error("درخواست اسکن معلق خوانده نشد؛ داده حفظ شد. با پشتیبانی تماس بگیرید.");
  return r as PendingScan;
}
export function writePendingScan(scan: PendingScan, store: KeyValueStorage = localStorage): void {
  const existing = readPendingScan(scan.actorId, store);
  if (existing && JSON.stringify(existing) !== JSON.stringify(scan))
    throw new Error("اسکن دیگری هنوز تعیین تکلیف نشده است؛ درخواست قبلی حفظ شد.");
  store.setItem(storageKey(scan.actorId), JSON.stringify(scan));
}
export function clearPendingScan(actorId: string, expectedKey: string, store: KeyValueStorage = localStorage): void {
  const existing = readPendingScan(actorId, store);
  if (existing && existing.key !== expectedKey)
    throw new Error("درخواست معلق تغییر کرده است؛ درخواست جدید پاک نشد.");
  store.removeItem(storageKey(actorId));
}
