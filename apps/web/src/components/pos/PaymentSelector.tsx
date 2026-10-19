import { AmountInput } from "../ui/AmountInput.tsx";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Money } from "../ui/Money.tsx";
import { Button, Field } from "../ui/Controls.tsx";
import { StatusBadge } from "../ui/Status.tsx";
import { Icon, type IconName } from "../Icon.tsx";
import { rialFromTomanInput } from "../../lib/money.ts";
import { allOptions, checkAmount, LINK_NOT_IMPLEMENTED, maxAmount, paymentLocked, usableChannel, type PaymentLayout, type PaymentOption,
  type PaymentPhase } from "../../lib/pos-payments.ts";

/**
 * انتخاب‌گر پرداخت صندوق — بازطراحی مصوب مالک (پس از بازبینی ریشه، ۲۰۲۶/۱۰/۱۸).
 *
 *   ۱. روش‌های **فعال** — تراشه‌های فشردهٔ چندانتخابی (`aria-pressed`)؛ هر روش انتخاب‌شده
 *      یک ردیف مبلغ کامل و دیدنی دارد. پرداخت ترکیبی یعنی چند ردیف؛ هر ردیف جدا و با
 *      همان قصد پرداخت تک‌روشی (F-115-01) ثبت می‌شود — منطق مبلغ و نهایی‌سازی تغییری نکرد.
 *   ۲. روش‌های **ناموجود** — در بخش بازشوندهٔ ثانوی، هر کدام با دلیلش (دیجی‌پیِ
 *      تنظیم‌نشده، «لینک پرداخت»، امتیاز/کارت هدیه بی مشتری). هیچ‌کدام انتخاب‌شدنی نیست.
 *   ۳. ستون اسکرول تودرتو ندارد: صفحه خودش اسکرول می‌شود و فقط پایان ستون (Pos.tsx) چسبان است.
 * نسیه اینجا نیست (CreditCheckout).
 *
 * ⚠️ کارت‌خوان و اسنپ‌پی **ثبت دستی** پرداخت تأییدشده‌اند؛ این صفحه به هیچ
 *    دستگاه یا سرویسی وصل نیست و چیزی را «پرداخت‌شده» نشان نمی‌دهد که صندوق‌دار
 *    خودش ثبت نکرده باشد. «لینک پرداخت» مسیری به `onPay` ندارد.
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
  digipay: "ثبت دستی پرداختی که در دیجی‌پی تأیید شده است؛ شمارهٔ پیگیری واقعی را وارد کنید. این صندوق به پنل دیجی‌پی وصل نیست.",
  gateway: "ثبت دستی پرداختی که در درگاه تأیید شده است؛ شمارهٔ پیگیری را وارد کنید.",
  transfer: "پس از دیدن واریز، شمارهٔ پیگیری انتقال را وارد کنید.",
};

/** زیرنویس کوتاه هر خانه — دلیل کامل ناموجودی جدا و کامل خوانده می‌شود. */
const CAPTION: Record<string, string> = {
  card_reader: "ثبت دستی پس از تأیید روی دستگاه",
  snappay: "ثبت دستی تأییدشده",
  cash: "تنها روشی که باقی پول دارد",
  transfer: "با شمارهٔ پیگیری واریز",
  gateway: "ثبت دستی تأییدشده",
  points: "از امتیاز مشتری",
  gift_card: "با شمارهٔ کارت هدیه",
};
const ICON: Record<string, IconName> = { card_reader: "card", cash: "vault", transfer: "refresh", gateway: "external", points: "sparkle", gift_card: "tag" };

type RowInput = { amount: string; refNo: string; attempted: boolean };
const EMPTY: RowInput = { amount: "", refNo: "", attempted: false };

/** یک ردیف مبلغ برای یک روش انتخاب‌شده — همان سنجش و همان بدنهٔ ارسال تک‌روشی قبلی. */
function PayRow({ option, label, viaProvider, channelBlocked, remaining, input, disabled, onInput, onPay, amountRef }: {
  option: PaymentOption; label: string; viaProvider: boolean; channelBlocked: boolean; remaining: bigint; input: RowInput; disabled: boolean;
  onInput: (next: RowInput) => void; onPay: (option: PaymentOption, amount: bigint, refNo: string) => void;
  amountRef: (el: HTMLInputElement | null) => void;
}) {
  const typed = input.amount.trim() === "" ? null : rialFromTomanInput(input.amount) ?? "invalid" as const;
  const check = checkAmount(option, typed, remaining);
  const max = maxAmount(option, remaining);
  const refMissing = option.requiresRef && input.refNo.trim() === "";
  const unavailable = option.unavailableReason;
  const amountError = check.ok || (!input.attempted && check.reason !== "over_max") ? null
    : check.reason === "over_max" ? "مبلغ از مانده بیشتر است؛ برای این روش حداکثر همان مانده مجاز است."
      : check.reason === "nothing_due" ? "مانده‌ای نیست؛ با این روش چیزی دریافت نمی‌شود."
        : check.reason === "zero" ? "مبلغ باید بیشتر از صفر باشد." : "مبلغ را فقط با رقم بنویسید.";
  function submit(e: FormEvent) {
    e.preventDefault();
    onInput({ ...input, attempted: true });
    if (disabled || unavailable || !check.ok || refMissing || channelBlocked) return;
    // شمارهٔ پیگیری فقط برای روشی که می‌خواهدش؛ بخشی از بدنهٔ قصد روش دیگر نیست.
    onPay(option, check.amount, option.requiresRef ? input.refNo.trim() : "");
  }
  return <form className="pay-form" onSubmit={submit} noValidate aria-label={`دریافت با ${label}`}>
    <p className="pay-form-head"><span className="muted">دریافت با</span> <strong>{label}</strong>
      {viaProvider ? <span className="muted"> · حضوری</span> : null}</p>
    {unavailable ? <p className="field-hint pay-form-note" role="status"><Icon name="info" size="sm" /> {unavailable}</p>
      : HINT[option.code] ?? HINT[option.kind] ? <p className="field-hint pay-form-note">{HINT[option.code] ?? HINT[option.kind]}</p> : null}
    <div className="pay-form-fields">
      <Field label="مبلغ (تومان)" error={amountError}
        hint={max === null ? <>خالی یعنی همهٔ مانده؛ اضافه، باقی پول می‌شود.</> : <>خالی یعنی همهٔ مانده؛ حداکثر <Money rial={max} size="sm" /></>}>
        <AmountInput ref={amountRef} type="text" inputMode="numeric" autoComplete="off" value={input.amount} disabled={disabled}
          onChange={(e) => onInput({ ...input, amount: e.target.value })} placeholder={remaining > 0n ? (remaining / 10n).toString() : ""} />
      </Field>
      {option.requiresRef ? <Field label="شماره پیگیری" error={input.attempted && refMissing ? "شمارهٔ پیگیری لازم است." : null}>
        <input type="text" autoComplete="off" value={input.refNo} maxLength={64} disabled={disabled} onChange={(e) => onInput({ ...input, refNo: e.target.value })} />
      </Field> : null}
    </div>
    <Button type="submit" variant="primary" disabled={disabled || unavailable !== null || channelBlocked || (!check.ok && check.reason === "nothing_due")}>دریافت وجه</Button>
  </form>;
}

export function PaymentSelector({ layout, remaining, received, phase, disabled, onPay, onCheck, onRetry, onAbandon }: {
  layout: PaymentLayout;
  remaining: bigint;
  /** آخرین «دریافتی» سرور — با تغییرش ردیف پرداخت‌شده برداشته می‌شود. */
  received: bigint;
  phase: PaymentPhase;
  /** سبد خالی یا عمل دیگری در جریان. */
  disabled: boolean;
  onPay: (option: PaymentOption, amount: bigint, refNo: string) => void;
  onCheck: () => void;
  onRetry: () => void;
  onAbandon: () => void;
}) {
  /** روش‌های انتخاب‌شده به ترتیب انتخاب — هر کدام یک ردیف مبلغ. */
  const [selected, setSelected] = useState<string[]>([]);
  const [inputs, setInputs] = useState<Record<string, RowInput>>({});
  const amountRefs = useRef(new Map<string, HTMLInputElement>());
  const focusCode = useRef<string | null>(null);
  /** روشی که آخرین بار از این صفحه فرستاده شد؛ با تغییر «دریافتی» ردیفش برداشته می‌شود. */
  const submitted = useRef<string | null>(null);
  const prev = useRef({ received, remaining });
  const unavailableId = useId();
  const locked = paymentLocked(phase);
  const options = allOptions(layout);
  // قصد قفل‌شده روش خودش را نشان می‌دهد، حتی پس از Reload که انتخاب صفحه از دست رفته.
  const activeCode = phase.kind === "idle" ? null : phase.intent.methodCode;
  const blocked = disabled || locked;
  const providerOf = (code: string) => layout.providers.find((p) => p.option?.code === code) ?? null;
  const labelOf = (o: PaymentOption) => providerOf(o.code)?.label ?? o.name;

  // دریافت موفق ← ردیف همان روش برداشته می‌شود و بقیهٔ ردیف‌های پرداخت ترکیبی می‌مانند.
  // تغییر سبد بی دریافت ← مبلغ‌های تایپ‌شده کهنه‌اند و پاک می‌شوند (انتخاب می‌ماند).
  // مانده صفر ← همه چیز جمع می‌شود تا نهایی‌سازی بی اسکرول در دسترس باشد.
  // ردِ قطعی «دریافتی» را عوض نمی‌کند، پس ورودی برای اصلاح می‌ماند.
  useEffect(() => {
    const before = prev.current;
    prev.current = { received, remaining };
    if (remaining === 0n) { setSelected([]); setInputs({}); submitted.current = null; return; }
    if (received !== before.received) {
      const paid = submitted.current;
      submitted.current = null;
      if (paid) {
        setSelected((s) => s.filter((c) => c !== paid));
        setInputs((i) => { const { [paid]: _gone, ...rest } = i; return rest; });
      }
    } else if (remaining !== before.remaining) {
      setInputs((i) => Object.fromEntries(Object.entries(i).map(([c, v]) => [c, { ...v, amount: "", attempted: false }])));
    }
  }, [received, remaining]);
  // روشی که دیگر فرستاده نمی‌شود (مثلاً پس از تغییر شعبه) انتخاب‌شده نمی‌ماند.
  useEffect(() => {
    const known = new Set(options.map((o) => o.code));
    if (selected.some((c) => !known.has(c))) setSelected((s) => s.filter((c) => known.has(c)));
  }, [selected, options]);
  useEffect(() => {
    const code = focusCode.current;
    if (!code) return;
    const input = amountRefs.current.get(code);
    if (!input) return;
    focusCode.current = null;
    input.focus({ preventScroll: true });
    // فرم کامل دیده شود، نه فقط کادر: پایان چسبان ستون (Pos.tsx) با scroll-padding جا باز کرده است.
    input.closest<HTMLElement>(".pay-form")?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }, [selected]);

  function toggle(o: PaymentOption) {
    if (blocked || o.unavailableReason) return;
    if (selected.includes(o.code)) {
      setSelected((s) => s.filter((c) => c !== o.code));
      setInputs((i) => { const { [o.code]: _gone, ...rest } = i; return rest; });
      return;
    }
    focusCode.current = o.code;
    setSelected((s) => [...s, o.code]);
  }

  // فقط روش‌های قابل ثبت تراشه می‌شوند؛ ناموجودها با دلیل در بخش ثانوی.
  const active = options.filter((o) => o.unavailableReason === null);
  const unavailable: Array<{ key: string; label: string; reason: string }> = [
    ...options.filter((o) => o.unavailableReason !== null).map((o) => ({ key: o.code, label: labelOf(o), reason: o.unavailableReason! })),
    ...layout.providers.filter((p) => p.option === null && p.unavailableReason).map((p) => ({ key: p.key, label: p.label, reason: p.unavailableReason! })),
    ...(layout.providers.length ? [{ key: "link", label: "لینک پرداخت", reason: LINK_NOT_IMPLEMENTED }] : []),
  ];
  const rows = selected.map((c) => options.find((o) => o.code === c)).filter((o): o is PaymentOption => o !== undefined);

  return <section className="pay-select" aria-label="روش پرداخت">
    <h3 className="pay-step" id={`${unavailableId}-h`}>روش پرداخت</h3>
    <p className="pay-step-note muted small">یک یا چند روش را بزنید؛ برای پرداخت ترکیبی هر روش مبلغ خودش را دارد.</p>
    <div className="pay-chips" role="group" aria-labelledby={`${unavailableId}-h`}>
      {active.map((o) => {
        const pressed = activeCode !== null ? o.code === activeCode : selected.includes(o.code);
        return <button key={o.code} type="button" className="pay-chip" aria-pressed={pressed} disabled={blocked}
          aria-label={labelOf(o)} title={CAPTION[o.kind] ?? undefined} onClick={() => toggle(o)}>
          <span className="pay-chip-icon" aria-hidden="true"><Icon name={ICON[o.kind] ?? "card"} size="sm" /></span>
          <span className="pay-chip-name">{labelOf(o)}</span>
          <span className="pay-chip-mark" aria-hidden="true">{pressed ? <Icon name="check" size="sm" /> : null}</span>
        </button>;
      })}
    </div>

    {unavailable.length ? <details className="pay-unavailable">
      <summary>روش‌های ناموجود ({unavailable.length}) — چرا؟</summary>
      <ul className="pay-unavailable-list">
        {unavailable.map((u) => <li key={u.key}><strong>{u.label}</strong><span>{u.reason}</span></li>)}
      </ul>
    </details> : null}

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

    {phase.kind === "idle" && rows.length ? <div className="pay-rows">
      {rows.map((o) => {
        const provider = providerOf(o.code);
        return <PayRow key={o.code} option={o} label={labelOf(o)} viaProvider={provider !== null}
          channelBlocked={provider !== null && !usableChannel(provider, "in_person")} remaining={remaining}
          input={inputs[o.code] ?? EMPTY} disabled={disabled}
          onInput={(next) => setInputs((i) => ({ ...i, [o.code]: next }))}
          onPay={(option, amount, refNo) => { submitted.current = option.code; onPay(option, amount, refNo); }}
          amountRef={(el) => { if (el) amountRefs.current.set(o.code, el); else amountRefs.current.delete(o.code); }} />;
      })}
    </div> : null}
  </section>;
}
