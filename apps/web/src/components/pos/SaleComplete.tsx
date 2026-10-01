import { useEffect, useRef, useState } from "react";
import { Ltr } from "../ui/Bidi.tsx";
import { Money } from "../ui/Money.tsx";
import { Button } from "../ui/Controls.tsx";
import { StatusBadge } from "../ui/Status.tsx";
import { Icon } from "../Icon.tsx";
import { pos } from "../../lib/pos.ts";
import type { FinalAmounts } from "../../lib/pos-payments.ts";

/** فروش تمام‌شده — آنچه پس از نهایی‌سازی تا «فروش بعدی» روی صفحه می‌ماند. */
export interface CompletedSale {
  invoiceId: string;
  /** `null` یعنی هنوز در صف آفلاین است و شماره ندارد. */
  number: string | null;
  queued: boolean;
  /**
   * تسویهٔ قطعی سرور (F-115-02) — پاسخ نهایی‌سازی یا خواندن دوبارهٔ فاکتور.
   * `null` یعنی خوانده نشد (یا هنوز در صف است)؛ آن‌وقت عددی «قطعی» نشان داده نمی‌شود.
   */
  amounts: FinalAmounts | null;
  /** فقط فروش در صف: آخرین عدد سرور پیش از قطع شبکه — صریحاً «برآورد». */
  estimate: { payable: bigint; received: bigint } | null;
}

/**
 * وضعیت موفق صندوق (Batch 2.1). **باقی پول تا «فروش بعدی» دیده می‌ماند** — همان
 * لحظه‌ای که صندوق‌دار لازمش دارد؛ پیش از این با نهایی‌سازی از صفحه می‌رفت.
 *
 * ⚠️ همهٔ مبلغ‌ها از تسویهٔ قطعی سرور‌اند، نه از «دریافتی» صفحه پیش از نهایی‌سازی:
 *    پرداختی که از تب یا دستگاه دیگر میان آن دو نشسته، باقی پول یا نسیه را عوض
 *    می‌کند و نهایی‌سازی آن را زیر قفل دیده است.
 *
 * چاپ دستی است و فقط یک پیوند به صفحهٔ چاپ رسید؛ شکستش هیچ اثر مالی ندارد.
 * فروش در صف آفلاین شماره و رسید ندارد و همین را صریح می‌گوید.
 */
export function SaleComplete({ sale, onNext }: { sale: CompletedSale; onNext: () => void }) {
  const [payments, setPayments] = useState<Array<{ id: string; name: string; amount: string }> | null>(null);
  const [failed, setFailed] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    if (sale.queued) return;
    const c = new AbortController();
    pos.invoicePayments(sale.invoiceId, { signal: c.signal })
      .then((r) => { if (!c.signal.aborted) setPayments(r.payments); })
      .catch(() => { if (!c.signal.aborted) setFailed(true); });
    return () => c.abort();
  }, [sale.invoiceId, sale.queued]);

  return <section className="solid pad sale-complete" aria-labelledby="sale-complete-title">
    <div className="sale-complete-head">
      <StatusBadge state={sale.queued ? "pending" : "completed"} label={sale.queued ? "در صف ارسال" : "ثبت شد"} />
      <h2 id="sale-complete-title" ref={heading} tabIndex={-1}>
        {sale.queued ? "فروش در صف ارسال است" : <>فاکتور <Ltr>{sale.number ?? ""}</Ltr> ثبت شد</>}
      </h2>
    </div>
    {sale.queued ? <p className="field-hint">شبکه قطع بود؛ فروش با همان شناسهٔ درخواست در صف نشست و با وصل‌شدن ارسال می‌شود. شماره و رسید پس از ثبت در سرور، از بخش فاکتورها در دسترس است.</p> : null}

    {sale.amounts ? <>
      {sale.amounts.change > 0n ? <div className="sale-complete-change" role="status">
        <span>باقی پول به مشتری</span><Money rial={sale.amounts.change} size="xl" />
      </div> : null}
      <dl className="checkout-lines">
        <div><dt>قابل پرداخت</dt><dd><Money rial={sale.amounts.payable} /></dd></div>
        <div><dt>دریافت‌شده</dt><dd><Money rial={sale.amounts.received} /></dd></div>
        {sale.amounts.credit > 0n ? <div><dt>نسیه به حساب مشتری</dt><dd><Money rial={sale.amounts.credit} /></dd></div> : null}
        {sale.amounts.change === 0n ? <div><dt>باقی پول</dt><dd><Money rial={0n} /></dd></div> : null}
      </dl>
    </> : sale.estimate ? <>
      <dl className="checkout-lines" aria-label="برآورد پیش از ثبت">
        <div><dt>قابل پرداخت (برآورد)</dt><dd><Money rial={sale.estimate.payable} /></dd></div>
        <div><dt>دریافتی تا قطع شبکه (برآورد)</dt><dd><Money rial={sale.estimate.received} /></dd></div>
      </dl>
      <p className="field-hint">این عددها قطعی نیستند؛ باقی پول و نسیهٔ قطعی پس از ثبت در سرور، در بخش فاکتورها دیده می‌شود.</p>
    </> : <p role="alert" className="field-hint">مبلغ‌های قطعی این فاکتور خوانده نشد؛ فروش ثبت شده است. باقی پول را از بخش فاکتورها ببینید و حدس نزنید.</p>}

    {!sale.queued ? <section aria-label="ریز پرداخت‌ها" className="sale-complete-payments">
      <h3>ریز پرداخت‌ها</h3>
      {failed ? <p role="alert" className="field-hint">ریز پرداخت‌ها خوانده نشد؛ از بخش فاکتورها ببینید. فروش ثبت شده است.</p>
        : payments === null ? <p className="muted small">در حال خواندن…</p>
          : payments.length === 0 ? <p className="muted small">پرداختی ثبت نشده است.</p>
            : <ul>{payments.map((p) => <li key={p.id}><span>{p.name}</span><Money rial={p.amount} size="sm" /></li>)}</ul>}
    </section> : null}

    <div className="row sale-complete-actions">
      {!sale.queued && sale.number ? <a className="btn" href={`/api/invoices/${sale.invoiceId}/print`} target="_blank" rel="noopener">
        <Icon name="print" size="sm" /> چاپ رسید</a> : null}
      <Button variant="primary" onClick={onNext}>فروش بعدی</Button>
    </div>
  </section>;
}
