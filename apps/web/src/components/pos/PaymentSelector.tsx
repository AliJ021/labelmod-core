import { AmountInput } from "../ui/AmountInput.tsx";
import { useEffect, useId, useRef, useState, type FocusEvent, type FormEvent } from "react";
import { Money } from "../ui/Money.tsx";
import { Button, Field } from "../ui/Controls.tsx";
import { StatusBadge } from "../ui/Status.tsx";
import { Icon, type IconName } from "../Icon.tsx";
import { rialFromTomanInput } from "../../lib/money.ts";
import { allOptions, CARD_READER_NOT_CONFIGURED, checkAmount, LINK_NOT_IMPLEMENTED, maxAmount, paymentLocked, usableChannel, type PaymentLayout,
  type PaymentOption, type PaymentPhase } from "../../lib/pos-payments.ts";

/**
 * انتخاب‌گر پرداخت صندوق — بازطراحی مصوب مالک (پس از بازبینی ریشه، ۲۰۲۶/۱۰/۱۸).
 *
 *   چیدمان مصوب مالک (۲۰۲۶/۱۰/۲۳، سبک خانه‌های بزرگ پیشین):
 *   ۱. ردیف اول: **کارت‌خوان** به‌تنهایی و تمام‌عرض.
 *   ۲. ردیف دوم: **اسنپ‌پی | دیجی‌پی** کنار هم با ترتیب ثابت. این سه خانه همیشه دیده می‌شوند؛ خانهٔ
 *      بی‌پشتوانه (روش تعریف‌نشده یا ارائه‌دهندهٔ تنظیم‌نشده برای این شعبه) `aria-disabled` است، دلیل
 *      کاملش را روی خود خانه می‌گوید، و هرگز انتخاب یا فرستاده نمی‌شود.
 *   ۳. **«نمایش بیشتر»**: همهٔ روش‌های دیگر (نقدی، کارت‌به‌کارت، درگاه، امتیاز، کارت هدیه) در بخش
 *      بازشونده؛ ناموجودها همان‌جا با دلیل (و «لینک پرداخت»). روشی که از آنجا انتخاب شده، با بستن بخش
 *      گم نمی‌شود: نامش روی دکمهٔ «نمایش بیشتر» و ردیف مبلغش بیرون از بخش می‌ماند.
 *   هر روش انتخاب‌شده (`aria-pressed`) یک ردیف مبلغ کامل و دیدنی دارد. پرداخت ترکیبی یعنی چند ردیف؛
 *   هر ردیف جدا و با همان قصد پرداخت تک‌روشی (F-115-01) ثبت می‌شود — منطق مبلغ و نهایی‌سازی تغییری نکرد.
 *   ستون اسکرول تودرتو ندارد: صفحه خودش اسکرول می‌شود و فقط پایان ستون (Pos.tsx) چسبان است.
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

/** خانهٔ ثابت ردیف اصلی: روشِ قابل ثبت یا `null` با دلیل. */
type Tile = { key: "card_reader" | "snappay" | "digipay"; label: string; option: PaymentOption | null; reason: string | null };

/** یک خانهٔ ردیف اصلی — عادی، فوکوس، انتخاب، قفل موقت، ناموجود. */
function MethodTile({ tile, pressed, locked, onPick }: { tile: Tile; pressed: boolean; locked: boolean; onPick: () => void }) {
  const captionId = useId();
  const unavailable = tile.reason !== null;
  const caption = unavailable ? tile.reason! : CAPTION[tile.key] ?? CAPTION.snappay!;
  return <button type="button" className="pay-tile" data-key={tile.key} data-state={unavailable ? "unavailable" : pressed ? "selected" : "default"}
    aria-label={tile.label} aria-pressed={unavailable ? undefined : pressed} aria-disabled={unavailable ? true : undefined}
    disabled={locked && !unavailable} aria-describedby={captionId}
    onClick={() => { if (!unavailable && !locked) onPick(); }}>
    <span className="pay-tile-top" aria-hidden="true">
      <span className="pay-tile-icon"><Icon name={tile.key === "card_reader" ? "card" : "external"} size="sm" /></span>
      <span className="pay-tile-mark">{!unavailable && pressed ? <Icon name="check" size="sm" /> : null}</span>
    </span>
    <span className="pay-tile-name" aria-hidden="true">{tile.label}</span>
    <span className="pay-tile-caption" aria-hidden="true">{unavailable ? <span className="pay-tile-tag">ناموجود</span> : null}{caption}</span>
    <span id={captionId} className="sr-only">{caption}</span>
  </button>;
}

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
  // بازگشت فوکوس به ردیفی که نیمه‌اش بیرون پنجره است: Chromium آن را کامل می‌آورد ولی WebKit (Safari/iPad)
  // فیلدِ نیمه‌دیدنی را همان‌جا می‌گذارد (CI، ۷۶۸×۶۰۰). `nearest` همان scroll-margin و scroll-padding پایان چسبان را
  // رعایت می‌کند و اگر عنصر کامل دیده می‌شود، صفحه را تکان نمی‌دهد.
  function reveal(e: FocusEvent<HTMLFormElement>) {
    if (e.target instanceof HTMLElement && e.target.matches("input, button")) e.target.scrollIntoView({ block: "nearest", behavior: "instant" });
  }
  return <form className="pay-form" onSubmit={submit} onFocus={reveal} noValidate aria-label={`دریافت با ${label}`}>
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
  const headId = useId();
  const moreId = useId();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreToggle = useRef<HTMLButtonElement>(null);
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

  // ردیف ثابت: کارت‌خوان، اسنپ‌پی، دیجی‌پی — همیشه هر سه، حتی بی‌پشتوانه (درخواست مالک).
  const card = layout.primary[0] ?? null;
  const tiles: Tile[] = [
    { key: "card_reader", label: card ? labelOf(card) : "کارت‌خوان", option: card, reason: card ? card.unavailableReason : CARD_READER_NOT_CONFIGURED },
    ...layout.providers.map((p): Tile => ({ key: p.key, label: p.label, option: p.option,
      reason: p.option ? p.option.unavailableReason : p.unavailableReason })),
  ];
  const tileCodes = new Set(tiles.flatMap((t) => (t.option ? [t.option.code] : [])));
  const pressedOf = (code: string) => (activeCode !== null ? code === activeCode : selected.includes(code));
  // بقیهٔ روش‌های قابل ثبت تراشه می‌شوند؛ ناموجودها با دلیل در بخش ثانوی.
  const active = options.filter((o) => o.unavailableReason === null && !tileCodes.has(o.code));
  // ناموجودهای «نمایش بیشتر»؛ سه خانهٔ اصلی دلیل خودشان را روی خود خانه دارند.
  const unavailable: Array<{ key: string; label: string; reason: string }> = [
    ...options.filter((o) => o.unavailableReason !== null && !tileCodes.has(o.code)).map((o) => ({ key: o.code, label: labelOf(o), reason: o.unavailableReason! })),
    ...(layout.providers.length ? [{ key: "link", label: "لینک پرداخت", reason: LINK_NOT_IMPLEMENTED }] : []),
  ];
  // روش‌های «بیشتر» که انتخاب شده‌اند (یا قصد قفل‌شده مال یکی از آن‌هاست) روی دکمه هم نام برده می‌شوند.
  const moreChosen = active.filter((o) => pressedOf(o.code));
  const rows = selected.map((c) => options.find((o) => o.code === c)).filter((o): o is PaymentOption => o !== undefined);

  return <section className="pay-select" aria-label="روش پرداخت">
    <h3 className="pay-step" id={`${headId}-h`}>روش پرداخت</h3>
    <p className="pay-step-note muted small">یک یا چند روش را بزنید؛ برای پرداخت ترکیبی هر روش مبلغ خودش را دارد.</p>
    <div className="pay-tiles" role="group" aria-labelledby={`${headId}-h`}>
      {tiles.map((t) => <MethodTile key={t.key} tile={t} pressed={t.option !== null && pressedOf(t.option.code)} locked={blocked}
        onPick={() => { if (t.option) toggle(t.option); }} />)}
    </div>

    {active.length || unavailable.length ? <div className="pay-more" onKeyDown={(e) => {
      if (e.key === "Escape" && moreOpen) { e.stopPropagation(); setMoreOpen(false); moreToggle.current?.focus(); }
    }}>
      <button ref={moreToggle} type="button" className="pay-more-toggle" aria-expanded={moreOpen} aria-controls={moreId}
        onClick={() => setMoreOpen((v) => !v)}>
        <Icon name="more" size="sm" />
        <span>{moreOpen ? "نمایش کمتر" : "نمایش بیشتر"}</span>
        {moreChosen.map((o) => <span key={o.code} className="pay-more-current"><Icon name="check" size="sm" />{labelOf(o)}</span>)}
        <span className="pay-more-chevron" aria-hidden="true"><Icon name="chevron" size="sm" /></span>
      </button>
      <div id={moreId} className="pay-more-panel" hidden={!moreOpen}>
        {active.length ? <div className="pay-chips" role="group" aria-label="روش‌های دیگر">
          {active.map((o) => {
            const pressed = pressedOf(o.code);
            return <button key={o.code} type="button" className="pay-chip" aria-pressed={pressed} disabled={blocked}
              aria-label={labelOf(o)} title={CAPTION[o.kind] ?? undefined} onClick={() => toggle(o)}>
              <span className="pay-chip-icon" aria-hidden="true"><Icon name={ICON[o.kind] ?? "card"} size="sm" /></span>
              <span className="pay-chip-name">{labelOf(o)}</span>
              <span className="pay-chip-mark" aria-hidden="true">{pressed ? <Icon name="check" size="sm" /> : null}</span>
            </button>;
          })}
        </div> : null}
        {unavailable.length ? <div className="pay-unavailable">
          <p className="pay-unavailable-head">ناموجود ({unavailable.length})</p>
          <ul className="pay-unavailable-list">
            {unavailable.map((u) => <li key={u.key}><strong>{u.label}</strong><span>{u.reason}</span></li>)}
          </ul>
        </div> : null}
      </div>
    </div> : null}

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
