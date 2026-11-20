import type { KeyValueStorage } from "./queue-store.ts";

export interface PendingScan {
  actorId: string;
  invoiceId: string;
  shiftId: string;
  key: string;
  draft?: { branchId: string; warehouseId: string; channel: "instagram" | "pos"; sellerId?: string };
  body: { qty: "1"; barcode?: string; variationId?: string };
}
const storageKey = (actorId: string) => `labelmod_pending_scan_v1:${actorId}`;
function validate(actorId: string, r: Partial<PendingScan>): PendingScan {
  const uuid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  if (!r || r.actorId !== actorId || !uuid(r.actorId) || !uuid(r.invoiceId) || !uuid(r.shiftId) || !uuid(r.key) || (r.draft && (!uuid(r.draft.branchId) || !uuid(r.draft.warehouseId) || !["pos","instagram"].includes(r.draft.channel) || (r.draft.sellerId !== undefined && !uuid(r.draft.sellerId)))) || !r.body || r.body.qty !== "1" ||
      Object.keys(r.body).some(k => !["qty", "barcode", "variationId"].includes(k)) ||
      (r.body.variationId !== undefined ? !uuid(r.body.variationId) || r.body.barcode !== undefined :
        typeof r.body.barcode !== "string" || r.body.barcode.length < 1 || r.body.barcode.length > 64))
    throw new Error("درخواست اسکن معلق خوانده نشد؛ داده حفظ شد. با پشتیبانی تماس بگیرید.");
  return r as PendingScan;
}
export function readScanQueue(actorId: string, store: KeyValueStorage = localStorage): PendingScan[] {
  const raw = store.getItem(storageKey(actorId));
  if (raw === null) return [];
  const value = JSON.parse(raw);
  const rows = (Array.isArray(value) ? value : [value]).map(row => validate(actorId,row));
  const first = rows[0];
  if (!first || rows.some(r => r.shiftId !== first.shiftId || r.invoiceId !== first.invoiceId || JSON.stringify(r.draft) !== JSON.stringify(first.draft)) ||
      new Set(rows.map(r => r.key)).size !== rows.length) throw new Error("صف اسکن ناسازگار است؛ بررسی صندوق لازم است.");
  return rows;
}
export function readPendingScan(actorId: string, store: KeyValueStorage = localStorage): PendingScan | null {
  return readScanQueue(actorId,store)[0] ?? null;
}
export function appendScans(scans: PendingScan[], store: KeyValueStorage = localStorage): void {
  if (!scans.length) return;
  const first = scans[0]!;
  const rows = readScanQueue(first.actorId,store);
  for (const scan of scans) {
    validate(first.actorId, scan);
    const head = rows[0];
    if (head && (head.shiftId !== scan.shiftId || head.invoiceId !== scan.invoiceId || JSON.stringify(head.draft) !== JSON.stringify(scan.draft))) throw new Error("صف به سبد دیگری تعلق دارد.");
    if (rows.some(r => r.key === scan.key)) throw new Error("شناسهٔ اسکن تکراری است.");
    rows.push(scan);
  }
  store.setItem(storageKey(first.actorId),JSON.stringify(rows.length === 1 ? rows[0] : rows));
}
export function bindScanCart(actorId:string, createKey:string, invoiceId:string, store:KeyValueStorage = localStorage) {
  const rows = readScanQueue(actorId,store);
  if (!rows.length || rows.some(r => r.invoiceId !== createKey || !r.draft)) throw new Error("سبد در حال ساخت تغییر کرده است.");
  const bound = rows.map(({draft: _draft, ...row}) => ({...row,invoiceId}));
  store.setItem(storageKey(actorId),JSON.stringify(bound.length === 1 ? bound[0] : bound));
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
  const remaining = readScanQueue(actorId,store).slice(1);
  if (remaining.length) store.setItem(storageKey(actorId),JSON.stringify(remaining.length === 1 ? remaining[0] : remaining));
  else store.removeItem(storageKey(actorId));
}
