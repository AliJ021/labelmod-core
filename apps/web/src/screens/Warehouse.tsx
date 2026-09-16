import { TabList, TabPanels, useTabsId } from "../components/Tabs.tsx";
/**
 * ناحیه انبار و خرید — چهار کار، یک ناحیه.
 *
 * ترتیب زبانه‌ها ترتیب واقعی کار است، نه الفبا:
 *
 *   سفارش خرید     تعهد — **هیچ اثر مالی و انباری ندارد**
 *   رسید خرید      کالا می‌آید، با سند تأمین‌کننده
 *   برگشت از خرید  کالا برمی‌گردد، با بهای همان رسید
 *   انتقال         کالا جابه‌جا می‌شود، **بدون هیچ سند حسابداری**
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
import { Transfer } from "./Transfer.tsx";

type Tab = "orders" | "receipts" | "returns" | "transfer" | "count";

const TABS = [
  { key: "orders", label: "سفارش خرید" }, { key: "receipts", label: "رسید خرید" },
  { key: "returns", label: "برگشت از خرید" }, { key: "transfer", label: "انتقال بین انبار" },
  { key: "count", label: "انبارگردانی" },
] as const;

export function Warehouse() {
  const tabsId = useTabsId();
  const [tab, setTab] = useState<Tab>("receipts");

  return (
    <div className="stack" style={{ gap: "var(--s-3)" }}>
      <TabList id={tabsId} items={TABS} value={tab} onChange={setTab} label="انبار و خرید" className="zones wh-tabs" />
      <TabPanels id={tabsId} items={TABS} value={tab}>

      {tab === "orders" ? (
        <PurchaseOrder />
      ) : tab === "receipts" ? (
        <Purchasing />
      ) : tab === "returns" ? (
        <PurchaseReturn />
      ) : tab === "transfer" ? (
        <Transfer />
      ) : (
        <StockCount />
      )}
      </TabPanels>
    </div>
  );
}
