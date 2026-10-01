import { Ltr } from "../ui/Bidi.tsx";
import { Money } from "../ui/Money.tsx";
import { SafeAction } from "../ui/SafeAction.tsx";
import type { InvoiceCustomer } from "../../lib/pos.ts";

/**
 * «ثبت نسیه» — نهایی‌سازی با مانده، نه یک روش پرداخت (Batch 2.1).
 *
 * هیچ ردیف `treasury.payment` نمی‌سازد. همان `POST /invoices/:id/finalize`
 * است: سرور زیر قفل فاکتور می‌بیند پول کامل نرسیده و سه دروازهٔ موجود را
 * می‌راند — مشتری (۴۲۲ `credit_needs_customer`)، `sale.credit` با مبلغ (۴۰۳)،
 * و در SQL سقف اعتبار و مسدودی مشتری. این صفحه فقط آن مسیر را **صریح** می‌کند
 * تا نسیه تصادفی نباشد: دکمهٔ معمولی نهایی‌سازی همچنان فقط با پرداخت کامل باز است.
 *
 * پنهان وقتی `/auth/can` برای `sale.credit` «allow» نمی‌گوید (صندوق‌دار)؛ این
 * نمایش است، دروازه سرور است. بی مشتری، به‌جای عمل، راه وصل‌کردن مشتری.
 */
export function CreditCheckout({ allowed, customer, remaining, received, payable, disabled, onAttachCustomer, run, verify, onDone }: {
  allowed: boolean;
  customer: InvoiceCustomer | null;
  remaining: bigint;
  received: bigint;
  payable: bigint;
  disabled: boolean;
  onAttachCustomer: () => void;
  run: () => Promise<void>;
  verify: () => Promise<boolean>;
  onDone: (outcome: "done" | "verified") => void;
}) {
  if (!allowed || remaining <= 0n) return null;
  if (!customer) {
    return <div className="credit-checkout">
      <p className="field-hint">برای فروش نسیه ابتدا مشتری را انتخاب کنید.</p>
      <button type="button" className="btn btn--quiet" disabled={disabled} onClick={onAttachCustomer}>وصل کردن مشتری برای نسیه</button>
    </div>;
  }
  return <div className="credit-checkout">
    <SafeAction trigger="ثبت نسیه" triggerVariant="button" title="ثبت فروش نسیه" disabled={disabled}
      confirmLabel="تأیید و ثبت نسیه" pendingLabel="در حال ثبت…" run={run} verify={verify} onDone={onDone}
      summary={<dl className="checkout-lines">
        <div><dt>مشتری</dt><dd>{customer.fullName?.trim() ? customer.fullName : "مشتری بی‌نام"}{customer.mobile ? <> · <Ltr>{customer.mobile}</Ltr></> : null}</dd></div>
        <div><dt>قابل پرداخت</dt><dd><Money rial={payable} /></dd></div>
        <div><dt>دریافت‌شده</dt><dd><Money rial={received} /></dd></div>
        <div><dt>بدهی مشتری (نسیه)</dt><dd><Money rial={remaining} size="lg" /></dd></div>
      </dl>}
      consequence="فاکتور نهایی و کالا از انبار خارج می‌شود و مانده به حساب بدهی همین مشتری می‌نشیند. سقف اعتبار و وضعیت مشتری را سرور می‌سنجد؛ اصلاح بعدی فقط با مرجوعی یا دریافت ممکن است." />
  </div>;
}
