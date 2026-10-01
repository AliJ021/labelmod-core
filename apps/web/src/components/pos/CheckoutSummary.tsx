import { Money } from "../ui/Money.tsx";
import type { CheckoutTotals } from "../../lib/pos-payments.ts";

/**
 * خلاصهٔ پرداخت صندوق — همهٔ اعداد از پاسخ سرور؛ فقط مانده و باقی پول با
 * bigint در `checkoutTotals()`. پول فقط با `Money` (رقم لاتین، برگ LTR، واحد
 * «تومان» بیرون از آن)؛ تبدیل ریال به تومان فقط در `money.ts`.
 *
 * تخفیف و مالیات همیشه دیده می‌شوند (صفرِ کم‌رنگ هم یک ادعای درست است)؛ حمل
 * فقط وقتی هست که صفر نباشد — صندوق حضوری حمل ندارد.
 */
export function CheckoutSummary({ totals }: { totals: CheckoutTotals }) {
  return <div className="checkout-summary">
    <dl className="checkout-lines">
      <div><dt>جمع کالا</dt><dd><Money rial={totals.gross} size="sm" /></dd></div>
      <div><dt>تخفیف</dt><dd><Money rial={totals.discount === 0n ? 0n : -totals.discount} size="sm" /></dd></div>
      <div><dt>مالیات</dt><dd><Money rial={totals.tax} size="sm" /></dd></div>
      {totals.shipping !== 0n ? <div><dt>هزینهٔ ارسال</dt><dd><Money rial={totals.shipping} size="sm" /></dd></div> : null}
    </dl>
    <div className="checkout-payable">
      <span className="checkout-payable-label">قابل پرداخت</span>
      <Money rial={totals.payable} size="xl" />
    </div>
    <dl className="checkout-lines checkout-lines--state">
      <div><dt>دریافت‌شده</dt><dd><Money rial={totals.received} size="sm" /></dd></div>
      {totals.change > 0n
        ? <div className="checkout-change"><dt>باقی پول</dt><dd><Money rial={totals.change} size="lg" /></dd></div>
        : <div><dt>مانده</dt><dd><Money rial={totals.remaining} size={totals.remaining > 0n ? "lg" : "sm"} /></dd></div>}
    </dl>
  </div>;
}
