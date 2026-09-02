/**
 * ناحیه انبار و خرید — چهار کار، یک ناحیه.
 *
 * ترتیب زبانه‌ها ترتیب واقعی کار است، نه الفبا:
 *
 *   سفارش خرید     تعهد — **هیچ اثر مالی و انباری ندارد**
 *   رسید خرید      کالا می‌آید، با سند تأمین‌کننده
 *   برگشت از خرید  کالا برمی‌گردد، با بهای همان رسید
 *   انبارگردانی    موجودی اصلاح می‌شود، **بدون هیچ سندی جز شمارش**
 *
 * اولی و آخری دو سرِ طیف‌اند: سفارش هیچ‌چیز را عوض نمی‌کند،
 * انبارگردانی همه‌چیز را بدون سند بیرونی عوض می‌کند. به همین دلیل
 * انبارگردانی مجوز جدا دارد (`stock.count`) — کسی که می‌تواند
 * بشمارد، می‌تواند کسری را پنهان کند.
 *
 * یک ناحیه با چهار زبانه، نه چهار ناحیه: انباردار میانشان جابه‌جا
 * می‌شود، ولی هرگز اشتباهشان نمی‌گیرد.
 */
import { useState } from "react";
import { Purchasing } from "./Purchasing.tsx";
import { StockCount } from "./StockCount.tsx";
import { PurchaseReturn } from "./PurchaseReturn.tsx";
import { PurchaseOrder } from "./PurchaseOrder.tsx";

type Tab = "orders" | "receipts" | "returns" | "count";

export function Warehouse() {
  const [tab, setTab] = useState<Tab>("receipts");

  return (
    <div className="stack" style={{ gap: "var(--s-3)" }}>
      <div className="zones wh-tabs" role="tablist" aria-label="انبار و خرید">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "orders"}
          className={tab === "orders" ? "on" : ""}
          onClick={() => setTab("orders")}
        >
          سفارش خرید
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "receipts"}
          className={tab === "receipts" ? "on" : ""}
          onClick={() => setTab("receipts")}
        >
          رسید خرید
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "returns"}
          className={tab === "returns" ? "on" : ""}
          onClick={() => setTab("returns")}
        >
          برگشت از خرید
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "count"}
          className={tab === "count" ? "on" : ""}
          onClick={() => setTab("count")}
        >
          انبارگردانی
        </button>
      </div>

      {tab === "orders" ? (
        <PurchaseOrder />
      ) : tab === "receipts" ? (
        <Purchasing />
      ) : tab === "returns" ? (
        <PurchaseReturn />
      ) : (
        <StockCount />
      )}
    </div>
  );
}
