/**
 * ناحیه انبار و خرید — سه کار، یک ناحیه.
 *
 * هر سه کار انباردارند و هر سه موجودی را عوض می‌کنند، ولی از سه مسیر
 * متفاوت:
 *
 *   رسید خرید      کالا می‌آید، با سند تأمین‌کننده
 *   برگشت از خرید  کالا برمی‌گردد، با بهای همان رسید
 *   انبارگردانی    موجودی اصلاح می‌شود، **بدون هیچ سندی جز شمارش**
 *
 * سومی مجوز جدا دارد (`stock.count` در برابر `stock.receive`) و
 * دلیلش همان است: کسی که می‌تواند بشمارد، می‌تواند کسری را پنهان کند.
 *
 * یک ناحیه با سه زبانه، نه سه ناحیه: انباردار میانشان جابه‌جا
 * می‌شود، ولی هرگز اشتباهشان نمی‌گیرد.
 */
import { useState } from "react";
import { Purchasing } from "./Purchasing.tsx";
import { StockCount } from "./StockCount.tsx";
import { PurchaseReturn } from "./PurchaseReturn.tsx";

type Tab = "receipts" | "returns" | "count";

export function Warehouse() {
  const [tab, setTab] = useState<Tab>("receipts");

  return (
    <div className="stack" style={{ gap: "var(--s-3)" }}>
      <div className="zones wh-tabs" role="tablist" aria-label="انبار و خرید">
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

      {tab === "receipts" ? <Purchasing /> : tab === "returns" ? <PurchaseReturn /> : <StockCount />}
    </div>
  );
}
