/**
 * ناحیه انبار و خرید — دو کار، یک ناحیه.
 *
 * رسید خرید و انبارگردانی هر دو کار انباردارند و هر دو موجودی را
 * عوض می‌کنند، ولی از دو مسیر کاملاً متفاوت: یکی با سند تأمین‌کننده،
 * دیگری **بدون هیچ سندی جز شمارش خودِ انباردار**. مجوزشان هم جداست
 * (`stock.receive` در برابر `stock.count`).
 *
 * پس یک ناحیه با دو زبانه، نه دو ناحیه: انباردار میان این دو
 * جابه‌جا می‌شود، ولی هرگز اشتباهشان نمی‌گیرد.
 */
import { useState } from "react";
import { Purchasing } from "./Purchasing.tsx";
import { StockCount } from "./StockCount.tsx";

type Tab = "receipts" | "count";

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
          aria-selected={tab === "count"}
          className={tab === "count" ? "on" : ""}
          onClick={() => setTab("count")}
        >
          انبارگردانی
        </button>
      </div>

      {tab === "receipts" ? <Purchasing /> : <StockCount />}
    </div>
  );
}
