import { useState } from "react";
import type { Receipt } from "../lib/purchasing.ts";
import { MAX_ITEMS, MAX_PER_VARIANT, MAX_TOTAL, labelRequestBody, labelSizeProblem } from "../lib/label-print.ts";
import { LabelPreviewFrame, LabelSizeFields, useLabelPreview, useLabelSize } from "./LabelPrint.tsx";

interface Cursor { index: number; used: number }
interface Item { variationId: string; count: number }

export function receiptLabelBatch(items: Item[], cursor: Cursor) {
  const batch: Item[] = [];
  let { index, used } = cursor;
  let total = 0;
  while (index < items.length && total < MAX_TOTAL && batch.length < MAX_ITEMS) {
    const item = items[index]!;
    const count = Math.min(item.count - used, MAX_PER_VARIANT, MAX_TOTAL - total);
    batch.push({ variationId: item.variationId, count });
    total += count;
    used += count;
    if (used < item.count) break;
    index++;
    used = 0;
  }
  return { batch, total, next: index < items.length ? { index, used } : null };
}

export function ReceiptLabels({ receipt }: { receipt: Receipt }) {
  const [opened, setOpened] = useState(false);
  const [history, setHistory] = useState<Cursor[]>([]);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const size = useLabelSize();
  const preview = useLabelPreview();
  const quantities = new Map<string, number>();
  const fractional = receipt.lines.filter(line => !Number.isSafeInteger(Number(line.qty)));
  for (const line of receipt.lines) {
    const count = Number.isSafeInteger(Number(line.qty)) ? Number(line.qty) : Number(overrides[line.id] || 0);
    quantities.set(line.variationId, (quantities.get(line.variationId) ?? 0) + count);
  }
  const items = Array.from(quantities, ([variationId, count]) => ({ variationId, count }));
  const invalid = fractional.some(line => !/^\d+$/.test(overrides[line.id] ?? "")) ||
    items.some(item => !Number.isSafeInteger(item.count) || item.count < 0);
  const current = receiptLabelBatch(invalid ? [] : items.filter(item => item.count > 0), history.at(-1) ?? { index: 0, used: 0 });
  const body = labelRequestBody(current.batch, size.size);
  const key = JSON.stringify(body);
  return <section className="stack"><button className="btn" type="button" aria-expanded={opened} onClick={() => setOpened(!opened)}>چاپ لیبل به تعداد خرید</button>
    {opened && <div className="solid pad stack"><h3>لیبل‌های همین رسید</h3>
      {fractional.map(line => <label key={line.id}>{line.productName} · مقدار خرید {line.qty} · تعداد برچسب
        <input inputMode="numeric" value={overrides[line.id] ?? ""} onChange={e => { setOverrides({ ...overrides, [line.id]: e.target.value }); setHistory([]); preview.reset(); }} /></label>)}
      <LabelSizeFields state={size} onChange={preview.reset} idPrefix="receipt-label" />
      <p>مجموع {items.reduce((n, item) => n + item.count, 0).toLocaleString("fa-IR")} لیبل · نوبت {(history.length + 1).toLocaleString("fa-IR")}</p>
      <div className="row"><button className="btn" disabled={!history.length || preview.busy} onClick={() => { setHistory(history.slice(0, -1)); preview.reset(); }}>نوبت قبل</button>
        <button className="btn btn--primary" disabled={invalid || !current.total || !!labelSizeProblem(size.size) || preview.busy} onClick={() => void preview.preview(body, key)}>پیش‌نمایش {current.total.toLocaleString("fa-IR")} لیبل</button>
        <button className="btn" disabled={!current.next || preview.busy} onClick={() => { if (current.next) setHistory([...history, current.next]); preview.reset(); }}>نوبت بعد</button></div>
      {preview.error && <p role="alert">{preview.error}</p>}
      {preview.html && preview.key === key && <LabelPreviewFrame html={preview.html} />}
    </div>}
  </section>;
}
