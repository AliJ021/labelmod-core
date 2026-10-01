import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Money } from "../ui/Money.tsx";
import { Button, Field } from "../ui/Controls.tsx";
import { StatusBadge } from "../ui/Status.tsx";
import { rialFromTomanInput } from "../../lib/money.ts";
import { allOptions, checkAmount, maxAmount, paymentLocked, type PaymentLayout, type PaymentOption, type PaymentPhase } from "../../lib/pos-payments.ts";

/**
 * انتخاب‌گر پرداخت صندوق (Batch 2.1) — چیدمان از `paymentLayout()`.
 *
 * کارت‌خوان تمام‌عرض؛ نقدی و اسنپ‌پی (فقط اگر سرور برای این شعبه فرستاده)
 * کنار هم؛ بقیه زیر «روش‌های بیشتر». نسیه اینجا نیست (CreditCheckout)،
 * دیجی‌پی و لینک پرداخت هم نیستند.
 *
 * ⚠️ کارت‌خوان و اسنپ‌پی **ثبت دستی** پرداخت تأییدشده‌اند؛ این صفحه به هیچ
 *    دستگاه یا سرویسی وصل نیست و چیزی را «پرداخت‌شده» نشان نمی‌دهد که صندوق‌دار
 *    خودش ثبت نکرده باشد.
 *
 * ⚠️ تا وقتی نتیجهٔ یک پرداخت روشن نیست (`phase` غیر از `idle`)، روش و مبلغ
 *    **قفل**‌اند (F-115-01). نخست فقط «بررسی وضعیت» — خواندن **همان شناسه**، نه جمع
 *    دریافتی. «هنوز پیدا نشد» یعنی «ثبت نشد» نیست، پس آنجا دو راه هست: «ارسال
 *    دوبارهٔ همین پرداخت» با همان شناسه (اگر نشسته بود Replay می‌شود)، یا «این
 *    پرداخت انجام نشده» که شناسه را در سرور مهر می‌کند. ارسال کور ندارد.
 */
const UNRESOLVED_TEXT: Record<"ambiguous" | "not_found_yet" | "retry_rejected" | "mismatch", string> = {
  ambiguous: "پاسخ قطعی از سرور نرسید؛ ممکن است این پرداخت ثبت شده باشد یا نه. دوباره پرداخت نگیرید و روش را عوض نکنید — اول وضعیت را بررسی کنید.",
  not_found_yet: "سرور هنوز پرداختی با شناسهٔ همین درخواست ندارد — این یعنی «ثبت نشد» نیست؛ ممکن است درخواست هنوز در راه باشد. اگر مشتری پرداخت کرده، همین پرداخت را با همان شناسه دوباره بفرستید (دو بار ثبت نمی‌شود). اگر پرداخت انجام نشده، «این پرداخت انجام نشده» را بزنید.",
  retry_rejected: "ارسال دوبارهٔ همین پرداخت رد شد، ولی نسخهٔ اول هنوز قطعی نیست. وضعیت را بررسی کنید؛ اگر پرداخت انجام نشده، «این پرداخت انجام نشده» را بزنید.",
  mismatch: "پرداختی با شناسهٔ همین درخواست ثبت شده ولی روش یا مبلغش با این پرداخت نمی‌خواند. پرداخت تازه نگیرید و از سرپرست کمک بگیرید.",
};

const HINT: Record<string, string> = {
  card_reader: "پس از تأیید روی دستگاه کارت‌خوان، شمارهٔ پیگیری رسید دستگاه را وارد کنید. این صندوق به دستگاه وصل نیست.",
  snappay: "ثبت دستی پرداختی که در اسنپ‌پی تأیید شده است؛ شمارهٔ پیگیری واقعی را وارد کنید.",
  gateway: "ثبت دستی پرداختی که در درگاه تأیید شده است؛ شمارهٔ پیگیری را وارد کنید.",
  transfer: "پس از دیدن واریز، شمارهٔ پیگیری انتقال را وارد کنید.",
};

export function PaymentSelector({ layout, remaining, received, phase, disabled, onPay, onCheck, onRetry, onAbandon }: {
  layout: PaymentLayout;
  remaining: bigint;
  /** آخرین «دریافتی» سرور — با تغییرش مبلغ و پیگیری پاک می‌شوند. */
  received: bigint;
  phase: PaymentPhase;
  /** سبد خالی یا عمل دیگری در جریان. */
  disabled: boolean;
  onPay: (option: PaymentOption, amount: bigint, refNo: string) => void;
  onCheck: () => void;
  onRetry: () => void;
  onAbandon: () => void;
}) {
  const [selected, setSelected] = useState("");
  const [amount, setAmount] = useState("");
  const [refNo, setRefNo] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);
  const focusAmount = useRef(false);
  const moreId = useId();
  const locked = paymentLocked(phase);
  const options = allOptions(layout);
  const chosen = options.find((o) => o.code === selected) ?? null;

  // دریافت موفق یا تغییر سبد ← فرم تازه؛ ردِ قطعی ورودی را نگه می‌دارد تا صندوق‌دار
  // اصلاحش کند. مانده که صفر شد، روش هم برداشته می‌شود تا فرم جمع شود و نهایی‌سازی
  // بی اسکرول در دسترس باشد.
  useEffect(() => {
    setAmount(""); setRefNo(""); setAttempted(false);
    if (remaining === 0n) setSelected("");
  }, [received, remaining]);
  // روشی که دیگر فرستاده نمی‌شود (مثلاً پس از تغییر شعبه) انتخاب‌شده نمی‌ماند.
  useEffect(() => { if (selected !== "" && !chosen) setSelected(""); }, [selected, chosen]);
  useEffect(() => {
    if (focusAmount.current && chosen) { focusAmount.current = false; amountRef.current?.focus(); }
  }, [chosen]);
  // روش انتخاب‌شده از «بیشتر» آن بخش را باز نگه می‌دارد.
  useEffect(() => { if (chosen?.group === "more") setMoreOpen(true); }, [chosen]);

  const typed = amount.trim() === "" ? null : rialFromTomanInput(amount) ?? "invalid" as const;
  const check = chosen ? checkAmount(chosen, typed, remaining) : null;
  const max = chosen ? maxAmount(chosen, remaining) : null;
  const refMissing = chosen !== null && chosen.requiresRef && refNo.trim() === "";
  const amountError = !check || check.ok || (!attempted && check.reason !== "over_max") ? null
    : check.reason === "over_max" ? "مبلغ از مانده بیشتر است؛ برای این روش حداکثر همان مانده مجاز است."
      : check.reason === "nothing_due" ? "مانده‌ای نیست؛ با این روش چیزی دریافت نمی‌شود."
        : check.reason === "zero" ? "مبلغ باید بیشتر از صفر باشد." : "مبلغ را فقط با رقم بنویسید.";

  function pick(o: PaymentOption) {
    if (locked || disabled || o.unavailableReason) return;
    focusAmount.current = true;
    setSelected(o.code);
    setAttempted(false);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setAttempted(true);
    if (!chosen || locked || disabled || !check?.ok || refMissing) return;
    // شمارهٔ پیگیری فقط برای روشی که می‌خواهدش؛ کادر پنهانِ روش قبلی بخشی از بدنهٔ این قصد نیست.
    onPay(chosen, check.amount, chosen.requiresRef ? refNo.trim() : "");
  }

  function onMoreKey(e: KeyboardEvent) {
    if (e.key === "Escape" && moreOpen && chosen?.group !== "more") { e.stopPropagation(); setMoreOpen(false); }
  }

  const button = (o: PaymentOption, wide = false) => {
    const reasonId = `${moreId}-${o.code}-why`;
    return <div key={o.code} className={`pay-option-wrap${wide ? " pay-option-wrap--wide" : ""}`}>
      <button type="button" className={`pay-option${wide ? " pay-option--primary" : ""}`} aria-pressed={o.code === selected}
        disabled={disabled || locked || o.unavailableReason !== null} aria-describedby={o.unavailableReason ? reasonId : undefined}
        onClick={() => pick(o)}>
        {o.code === selected ? <span className="pay-option-check" aria-hidden="true">✓</span> : null}
        <span>{o.name}</span>
      </button>
      {o.unavailableReason ? <span id={reasonId} className="field-hint pay-option-why">{o.unavailableReason}</span> : null}
    </div>;
  };

  return <section className="pay-select" aria-label="روش پرداخت">
    <div className="pay-options">
      {layout.primary.map((o) => button(o, true))}
      {layout.secondary.length ? <div className="pay-options-row">{layout.secondary.map((o) => button(o))}</div> : null}
      {layout.more.length ? <div className="pay-more" onKeyDown={onMoreKey}>
        <button type="button" className="link pay-more-toggle" aria-expanded={moreOpen} aria-controls={moreId}
          onClick={() => setMoreOpen((v) => !v)} disabled={locked}>
          روش‌های بیشتر <span aria-hidden="true">{moreOpen ? "▴" : "▾"}</span>
        </button>
        <div id={moreId} className="pay-options-row" hidden={!moreOpen}>{layout.more.map((o) => button(o))}</div>
      </div> : null}
    </div>

    {phase.kind !== "idle" ? <div className={`pay-intent pay-intent--${phase.kind}`} role={phase.kind === "unknown" ? "alert" : undefined}>
      <p className="pay-intent-head">
        <StatusBadge state={phase.kind === "unknown" ? (phase.reason === "mismatch" ? "warning" : "unknown") : "pending"}
          label={phase.kind === "submitting" ? "در حال ثبت" : phase.kind === "checking" ? "در حال بررسی"
            : phase.reason === "mismatch" ? "نیازمند بررسی" : "نتیجه نامعلوم"} />
        <span>{phase.intent.methodName}</span> <Money rial={phase.intent.amount} />
      </p>
      {phase.kind === "unknown" ? <>
        <p>{UNRESOLVED_TEXT[phase.reason]}</p>
        <div className="row pay-intent-actions">
          <Button variant="primary" onClick={onCheck}>بررسی وضعیت</Button>
          {phase.reason === "not_found_yet" || phase.reason === "retry_rejected" ? <>
            <Button variant="secondary" onClick={onRetry}>ارسال دوبارهٔ همین پرداخت</Button>
            <Button variant="quiet" onClick={onAbandon}>این پرداخت انجام نشده</Button>
          </> : null}
        </div>
      </> : null}
    </div> : null}

    {chosen && phase.kind === "idle" ? <form className="pay-form" onSubmit={submit} noValidate>
      {HINT[chosen.code] ?? HINT[chosen.kind] ? <p className="field-hint pay-form-note">{HINT[chosen.code] ?? HINT[chosen.kind]}</p> : null}
      <Field label="مبلغ (تومان)" error={amountError}
        hint={max === null ? <>خالی یعنی همهٔ مانده؛ اضافه، باقی پول می‌شود.</> : <>خالی یعنی همهٔ مانده؛ حداکثر <Money rial={max} size="sm" /></>}>
        <input ref={amountRef} type="text" inputMode="numeric" autoComplete="off" value={amount} disabled={disabled}
          onChange={(e) => setAmount(e.target.value)} placeholder={remaining > 0n ? (remaining / 10n).toString() : ""} />
      </Field>
      {chosen.requiresRef ? <Field label="شماره پیگیری" error={attempted && refMissing ? "شمارهٔ پیگیری لازم است." : null}>
        <input type="text" autoComplete="off" value={refNo} maxLength={64} disabled={disabled} onChange={(e) => setRefNo(e.target.value)} />
      </Field> : null}
      <Button type="submit" variant="secondary" disabled={disabled || (check !== null && !check.ok && check.reason === "nothing_due")}>دریافت وجه</Button>
    </form> : null}
  </section>;
}
