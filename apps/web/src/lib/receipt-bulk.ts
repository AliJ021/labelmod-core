/**
 * افزودن گروهی به رسید خرید — منطق خالص، بی React (test/receipt-bulk.test.ts).
 *
 * مرورگر **هیچ تصمیم مالی** نمی‌گیرد: تعداد و قیمت خرید را فقط می‌سنجد و همان
 * را می‌فرستد. جمع سطر، ادغام با سطر هم‌قیمت و هویت تنوع کار سرور است
 * (`POST /receipts/:id/lines/bulk`). هر تنوع یک بار در درخواست می‌آید، چون
 * انتخاب یک Map از شناسهٔ تنوع است، نه فهرست.
 */
import { normalizeDigits } from "./settings-value.ts";
import type { ReceiptVariation } from "./purchasing.ts";

/** تعداد `platform.qty` — تا سه رقم اعشار و بزرگ‌تر از صفر؛ رقم فارسی هم. `null` = نامعتبر. */
export function parseQty(raw: string): string | null {
  const v = normalizeDigits(raw);
  if (!/^\d+(\.\d{1,3})?$/.test(v)) return null;
  if (!/[1-9]/.test(v)) return null;
  return v;
}

export interface BulkLine { variationId: string; qty: string; unitPrice: string }

/**
 * انتخاب → بدنهٔ درخواست. قیمت ریالی از سطح بالا (یک فاکتور، یک نرخ برای همهٔ
 * تنوع‌های انتخاب‌شده). تعداد نامعتبر هیچ درخواستی نمی‌سازد و شناسه‌اش برمی‌گردد.
 */
export function bulkLines(selection: ReadonlyMap<string, string>, unitPriceRial: bigint | null):
  { ok: true; lines: BulkLine[] } | { ok: false; reason: "empty" | "price" | "qty"; invalid: string[] } {
  if (selection.size === 0) return { ok: false, reason: "empty", invalid: [] };
  if (unitPriceRial === null || unitPriceRial <= 0n) return { ok: false, reason: "price", invalid: [] };
  const invalid: string[] = [];
  const lines: BulkLine[] = [];
  for (const [variationId, raw] of selection) {
    const qty = parseQty(raw);
    if (qty === null) invalid.push(variationId);
    else lines.push({ variationId, qty, unitPrice: unitPriceRial.toString() });
  }
  return invalid.length ? { ok: false, reason: "qty", invalid } : { ok: true, lines };
}

/** تنوع‌ها گروه‌بندی‌شده با رنگ، سایزها به ترتیب سرور (ترتیب واقعی پوشاک). */
export function byColor(variations: readonly ReceiptVariation[]): { color: string; items: ReceiptVariation[] }[] {
  const groups = new Map<string, ReceiptVariation[]>();
  for (const v of variations) {
    const key = v.color ?? "بی‌رنگ";
    groups.set(key, [...(groups.get(key) ?? []), v]);
  }
  return [...groups].map(([color, items]) => ({ color, items }));
}
