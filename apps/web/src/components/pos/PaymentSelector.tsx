import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Money } from "../ui/Money.tsx";
import { Button, Field } from "../ui/Controls.tsx";
import { useModalDialog } from "../ui/use-modal.ts";
import { StatusBadge } from "../ui/Status.tsx";
import { Icon, type IconName } from "../Icon.tsx";
import { rialFromTomanInput } from "../../lib/money.ts";
import { useMediaQuery } from "../../lib/use-media-query.ts";
import { allOptions, checkAmount, maxAmount, paymentLocked, usableChannel, type ChannelKey, type PaymentLayout, type PaymentOption,
  type PaymentPhase, type ProviderSlot } from "../../lib/pos-payments.ts";

/**
 * انتخاب‌گر پرداخت صندوق — چیدمان از `paymentLayout()` و به همین ترتیب دیداری
 * (نیاز مالک محصول، POS-05 تا POS-08):
 *
 *   ۱. کارت‌خوان — تمام‌عرض، روش اصلی.
 *   ۲. اسنپ‌پی | دیجی‌پی — هم‌ردیف و هم‌وزن، **همیشه**؛ خانهٔ بی‌پشتوانه ناموجود است
 *      و دلیلش را می‌گوید. انتخاب اسنپ‌پی کانال «حضوری / لینک پرداخت» را باز می‌کند.
 *   ۳. روش‌های بیشتر — بسته؛ روی دسکتاپ بخشِ بازشونده، روی موبایل برگهٔ پایینی.
 * نسیه اینجا نیست (CreditCheckout).
 *
 * ⚠️ کارت‌خوان و اسنپ‌پی **ثبت دستی** پرداخت تأییدشده‌اند؛ این صفحه به هیچ
 *    دستگاه یا سرویسی وصل نیست و چیزی را «پرداخت‌شده» نشان نمی‌دهد که صندوق‌دار
 *    خودش ثبت نکرده باشد. «لینک پرداخت» مسیری به `onPay` ندارد؛ هر دو ارائه‌دهنده فقط ثبت دستی دارند.
 *
 * ⚠️ «ناموجود» با `aria-disabled` است (فوکوس‌پذیر، دلیلش خوانده می‌شود) و «موقتاً
 *    قفل» (سبد خالی، عمل در جریان، قصد نامعلوم) با `disabled` بومی — دو حالت جدا.
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
const SHORT_UNAVAILABLE: Record<ProviderSlot["key"], string> = {
  snappay: "برای این شعبه تنظیم نشده",
  digipay: "برای این شعبه تنظیم نشده",
};
const ICON: Record<string, IconName> = { card_reader: "card", cash: "vault", transfer: "refresh", gateway: "external", points: "sparkle", gift_card: "tag" };

/** یک خانهٔ پرداخت — همهٔ حالت‌ها: عادی، hover، فوکوس، انتخاب، قفل، ناموجود، خطا. */
function PayOption({ label, caption, reason, icon, tier, pressed, locked, error, onPick }: {
  label: string; caption: string; reason: string | null; icon?: IconName | undefined; tier: "primary" | "provider" | "more";
  pressed: boolean; locked: boolean; error: boolean; onPick: () => void;
}) {
  const captionId = useId();
  const reasonId = useId();
  const state = reason ? "unavailable" : error && pressed ? "error" : pressed ? "selected" : "default";
  return <button type="button" className={`pay-option pay-option--${tier}`} data-state={state} aria-label={label}
    aria-pressed={reason ? undefined : pressed} disabled={locked && !reason} aria-disabled={reason ? true : undefined}
    aria-describedby={reason && tier !== "more" ? `${captionId} ${reasonId}` : captionId} onClick={() => { if (!reason && !locked) onPick(); }}>
    {icon ? <span className="pay-option-icon" aria-hidden="true"><Icon name={icon} /></span> : null}
    <span className="pay-option-text">
      <span className="pay-option-name">{label}{reason ? <span className="pay-option-tag" aria-hidden="true">ناموجود</span> : null}</span>
      <span id={captionId} className="pay-option-caption">{reason && tier === "more" ? reason : caption}</span>
      {reason && tier !== "more" ? <span id={reasonId} className="sr-only">{reason}</span> : null}
    </span>
    <span className="pay-option-mark" aria-hidden="true">
      {!reason && pressed ? <Icon name="check" size="sm" /> : null}
    </span>
  </button>;
}

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
  const [channel, setChannel] = useState<ChannelKey>("in_person");
  const [amount, setAmount] = useState("");
  const [refNo, setRefNo] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);
  const moreToggle = useRef<HTMLButtonElement>(null);
  const focusAmount = useRef(false);
  const moreId = useId();
  const channelReasonId = useId();
  // زیر ۶۰۰ پیکسل «روش‌های بیشتر» برگهٔ پایینی است؛ بالاتر، بخش بازشوندهٔ درجا.
  const sheet = useMediaQuery("(max-width: 599px)");
  // برگهٔ پایینی روی همان زیرساخت مودال Dialog (`use-modal.ts`)؛ فوکوس پس از انتخاب
  // به کادر مبلغ می‌رود، نه به دکمهٔ «بیشتر» — همان رفتار دسکتاپ.
  const pickedFromSheet = useRef(false);
  const sheetModal = useModalDialog(sheet && moreOpen, {
    onDismiss: () => setMoreOpen(false),
    returnFocus: () => (pickedFromSheet.current ? amountRef.current : moreToggle.current),
  });
  const sheetTitleId = useId();
  const locked = paymentLocked(phase);
  const options = allOptions(layout);
  // قصد قفل‌شده روش خودش را نشان می‌دهد، حتی پس از Reload که انتخاب صفحه از دست رفته.
  const activeCode = phase.kind === "idle" ? selected : phase.intent.methodCode;
  const chosen = options.find((o) => o.code === selected) ?? null;
  const active = options.find((o) => o.code === activeCode) ?? null;
  const provider = chosen ? layout.providers.find((p) => p.option?.code === chosen.code) ?? null : null;
  const blocked = disabled || locked;

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
  // بخش بازشده در ستون قابل‌اسکرول پرداخت دیده شود، نه زیر پایان چسبان ستون.
  const morePanel = useRef<HTMLDivElement>(null);
  useEffect(() => { if (moreOpen && !sheet) morePanel.current?.scrollIntoView({ block: "nearest", behavior: "instant" }); }, [moreOpen, sheet]);
  // قصد قفل‌شده «بیشتر» را می‌بندد: تا روشن‌شدن نتیجه هیچ انتخابی از آنجا ممکن نیست.
  // (درخواست‌های کوتاه دیگر — `disabled` — آن را نمی‌بندند تا با هر پاسخ سرور چشمک نزند.)
  useEffect(() => { if (locked) setMoreOpen(false); }, [locked]);

  const typed = amount.trim() === "" ? null : rialFromTomanInput(amount) ?? "invalid" as const;
  const check = chosen ? checkAmount(chosen, typed, remaining) : null;
  const max = chosen ? maxAmount(chosen, remaining) : null;
  const refMissing = chosen !== null && chosen.requiresRef && refNo.trim() === "";
  const channelBlocked = provider !== null && !usableChannel(provider, channel);
  const amountError = !check || check.ok || (!attempted && check.reason !== "over_max") ? null
    : check.reason === "over_max" ? "مبلغ از مانده بیشتر است؛ برای این روش حداکثر همان مانده مجاز است."
      : check.reason === "nothing_due" ? "مانده‌ای نیست؛ با این روش چیزی دریافت نمی‌شود."
        : check.reason === "zero" ? "مبلغ باید بیشتر از صفر باشد." : "مبلغ را فقط با رقم بنویسید.";
  const hasError = amountError !== null || (attempted && refMissing);

  function pick(o: PaymentOption) {
    if (blocked || o.unavailableReason) return;
    focusAmount.current = true;
    setSelected(o.code);
    setChannel("in_person");
    setAttempted(false);
    if (o.group === "more") { pickedFromSheet.current = sheet; setMoreOpen(false); }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setAttempted(true);
    if (!chosen || blocked || !check?.ok || refMissing || channelBlocked) return;
    // شمارهٔ پیگیری فقط برای روشی که می‌خواهدش؛ کادر پنهانِ روش قبلی بخشی از بدنهٔ این قصد نیست.
    onPay(chosen, check.amount, chosen.requiresRef ? refNo.trim() : "");
  }

  function closeMore() { pickedFromSheet.current = false; setMoreOpen(false); if (!sheet) requestAnimationFrame(() => moreToggle.current?.focus()); }
  function onMoreKey(e: KeyboardEvent) {
    if (e.key === "Escape" && moreOpen) { e.stopPropagation(); closeMore(); }
  }

  const moreList: ReactNode = <ul className="pay-more-list" role="list">
    {layout.more.map((o) => <li key={o.code}>
      <PayOption label={o.name} caption={CAPTION[o.kind] ?? ""} reason={o.unavailableReason} icon={ICON[o.kind]} tier="more"
        pressed={o.code === activeCode} locked={blocked} error={hasError} onPick={() => pick(o)} />
    </li>)}
  </ul>;
  const moreActive = active?.group === "more" ? active : null;

  return <section className="pay-select" aria-label="روش پرداخت">
    <h3 className="pay-step" aria-hidden="true">روش پرداخت</h3>
    <div className="pay-options">
      {layout.primary.map((o) => <PayOption key={o.code} label={o.name} caption={CAPTION[o.kind] ?? ""} reason={o.unavailableReason}
        icon="card" tier="primary" pressed={o.code === activeCode} locked={blocked} error={hasError} onPick={() => pick(o)} />)}

      <div className="pay-providers">
        {layout.providers.map((p) => <PayOption key={p.key} label={p.label} caption={p.option ? CAPTION.snappay ?? "" : SHORT_UNAVAILABLE[p.key]}
          reason={p.option ? p.option.unavailableReason : p.unavailableReason} tier="provider"
          pressed={p.option !== null && p.option.code === activeCode} locked={blocked} error={hasError}
          onPick={() => { if (p.option) pick(p.option); }} />)}
      </div>

      {provider && phase.kind === "idle" ? <fieldset className="pay-channel">
        <legend>کانال پرداخت {provider.label}</legend>
        <div className="pay-channel-options">
          {provider.channels.map((c) => <label key={c.key} className="pay-channel-option" data-state={c.unavailableReason ? "unavailable" : channel === c.key ? "selected" : "default"}>
            <input type="radio" name={`${moreId}-channel`} value={c.key} checked={channel === c.key} disabled={c.unavailableReason !== null || blocked}
              aria-describedby={c.unavailableReason ? channelReasonId : undefined} onChange={() => setChannel(c.key)} />
            <span>{c.label}</span>
          </label>)}
        </div>
        {provider.channels.filter((c) => c.unavailableReason).map((c) => <p key={c.key} id={channelReasonId} className="pay-channel-why">
          <Icon name="info" size="sm" /> {c.label}: {c.unavailableReason}
        </p>)}
      </fieldset> : null}

      {layout.more.length ? <div className="pay-more" onKeyDown={onMoreKey}>
        <button ref={moreToggle} type="button" className="pay-more-toggle" aria-expanded={moreOpen} aria-controls={sheet ? undefined : moreId}
          aria-haspopup={sheet ? "dialog" : undefined} onClick={() => { pickedFromSheet.current = false; setMoreOpen((v) => !v); }} disabled={blocked}>
          <Icon name="more" size="sm" />
          <span>روش‌های بیشتر</span>
          {moreActive ? <span className="pay-more-current"><Icon name="check" size="sm" />{moreActive.name}</span> : null}
          <span className="pay-more-chevron" aria-hidden="true"><Icon name="chevron" size="sm" /></span>
        </button>
        {sheet
          ? <dialog ref={sheetModal.ref} className="ui-dialog ui-dialog--sheet ui-dialog--sm" aria-labelledby={sheetTitleId} {...sheetModal.props}>
              <div className="ui-dialog-body">
                <div className="ui-dialog-head">
                  <h2 id={sheetTitleId} className="ui-dialog-title">روش‌های بیشتر</h2>
                  <button type="button" className="icon-button" aria-label="بستن" onClick={closeMore}><Icon name="close" /></button>
                </div>
                <p className="ui-dialog-description">نقدی، کارت‌به‌کارت، درگاه دستی، امتیاز و کارت هدیه.</p>
                {moreList}
              </div>
            </dialog>
          : <div ref={morePanel} id={moreId} className="pay-more-panel" hidden={!moreOpen}>{moreList}</div>}
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

    {chosen && phase.kind === "idle" ? <form className="pay-form" onSubmit={submit} noValidate aria-label={`دریافت با ${chosen.name}`}>
      <p className="pay-form-head"><span className="muted">دریافت با</span> <strong>{provider ? provider.label : chosen.name}</strong>
        {provider ? <span className="muted"> · حضوری</span> : null}</p>
      {HINT[chosen.code] ?? HINT[chosen.kind] ? <p className="field-hint pay-form-note">{HINT[chosen.code] ?? HINT[chosen.kind]}</p> : null}
      <div className="pay-form-fields">
        <Field label="مبلغ (تومان)" error={amountError}
          hint={max === null ? <>خالی یعنی همهٔ مانده؛ اضافه، باقی پول می‌شود.</> : <>خالی یعنی همهٔ مانده؛ حداکثر <Money rial={max} size="sm" /></>}>
          <input ref={amountRef} type="text" inputMode="numeric" autoComplete="off" value={amount} disabled={disabled}
            onChange={(e) => setAmount(e.target.value)} placeholder={remaining > 0n ? (remaining / 10n).toString() : ""} />
        </Field>
        {chosen.requiresRef ? <Field label="شماره پیگیری" error={attempted && refMissing ? "شمارهٔ پیگیری لازم است." : null}>
          <input type="text" autoComplete="off" value={refNo} maxLength={64} disabled={disabled} onChange={(e) => setRefNo(e.target.value)} />
        </Field> : null}
      </div>
      <Button type="submit" variant="primary" disabled={disabled || channelBlocked || (check !== null && !check.ok && check.reason === "nothing_due")}>دریافت وجه</Button>
    </form> : null}
  </section>;
}
