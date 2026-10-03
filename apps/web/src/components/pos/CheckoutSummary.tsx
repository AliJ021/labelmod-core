import { Money } from "../ui/Money.tsx";
import type { CheckoutTotals } from "../../lib/pos-payments.ts";

/**
 * خلاصهٔ پرداخت صندوق — همهٔ اعداد از پاسخ سرور؛ فقط مانده و باقی پول با
 * bigint در `checkoutTotals()`. پول فقط با `Money` (رقم لاتین، برگ LTR، واحد
 * «تومان» بیرون از آن)؛ تبدیل ریال به تومان فقط در `money.ts`.
 *
 * سلسله‌مراتب (POS-12): ریز سه‌گانه کوچک ← **قابل پرداخت** غالب ← دریافت‌شده و
 * مانده (یا باقی پول) به‌عنوان وضعیت. تخفیف با علامت منفی، صفر کم‌رنگ و متمایز
 * از «—». حمل فقط وقتی هست که صفر نباشد — صندوق حضوری حمل ندارد.
 *
 * `totals === null` یعنی هنوز فاکتوری نیست: «—» نشان داده می‌شود، نه «۰ تومان»؛
 * صفر یک ادعای مالی است و سبدِ نساخته مبلغی ندارد.
 */
export function CheckoutSummary({ totals }: { totals: CheckoutTotals | null }) {
  const none = "هنوز کالایی در سبد نیست";
  const m = (v: bigint | undefined, size: "sm" | "md" | "lg" | "xl" = "sm") =>
    <Money rial={totals && v !== undefined ? v : null} size={size} unknownLabel={none} />;
  return <section className={`checkout-summary${totals ? "" : " checkout-summary--idle"}`} aria-label="خلاصهٔ مبلغ">
    <dl className="checkout-lines">
      <div><dt>جمع کالا</dt><dd>{m(totals?.gross)}</dd></div>
      <div><dt>تخفیف</dt><dd>{m(totals ? (totals.discount === 0n ? 0n : -totals.discount) : undefined)}</dd></div>
      <div><dt>مالیات</dt><dd>{m(totals?.tax)}</dd></div>
      {totals && totals.shipping !== 0n ? <div><dt>هزینهٔ ارسال</dt><dd>{m(totals.shipping)}</dd></div> : null}
    </dl>
    <div className="checkout-payable">
      <span className="checkout-payable-label">قابل پرداخت</span>
      {m(totals?.payable, "xl")}
    </div>
    <dl className="checkout-lines checkout-lines--state">
      <div><dt>دریافت‌شده</dt><dd>{m(totals?.received, "md")}</dd></div>
      {totals && totals.change > 0n
        ? <div className="checkout-change"><dt>باقی پول</dt><dd>{m(totals.change, "lg")}</dd></div>
        : <div className={totals && totals.remaining > 0n ? "checkout-due" : undefined}><dt>مانده</dt><dd>{m(totals?.remaining, "md")}</dd></div>}
    </dl>
  </section>;
}
