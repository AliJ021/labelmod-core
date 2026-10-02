import { formatPercent, formatQty, moneyParts } from "../../lib/format.ts";

/**
 * مبلغ — تنها راه نمایش پول در رابط (docs/DESIGN_SYSTEM.md، «عدد مالی»).
 *
 * رقم‌ها در برگ جداشدهٔ LTR با قلم مونو و `tabular-nums`؛ واحد «تومان»
 * بیرون از آن و در جهت متن. علامت منفی همیشه دیده می‌شود («−» یا
 * پرانتز حسابداری) و رنگ فقط تقویت است. `side` برچسب متنی
 * بدهکار/بستانکار می‌گذارد، چون این دو «خوب» و «بد» نیستند.
 */
export function Money({ rial, compact = false, exact = false, negative = "minus", side, unit = true, size = "md", muted = false, unknownLabel = "نامعلوم یا بدون دسترسی" }: {
  /**
   * `null` یعنی «نمی‌دانیم یا اجازهٔ دیدنش نیست» (مثلاً بها بدون `cost.view`) و
   * «—» می‌شود — هرگز صفر. صفر یک ادعای مالی است.
   */
  rial: bigint | string | null;
  compact?: boolean;
  /** ریال باقی‌مانده را به‌صورت اعشار تومان نگه می‌دارد؛ بر compact مقدم است. */
  exact?: boolean;
  negative?: "minus" | "parens";
  side?: "debit" | "credit";
  unit?: boolean;
  size?: "sm" | "md" | "lg" | "xl";
  muted?: boolean;
  /** متن صفحه‌خوان و title برای «—». */
  unknownLabel?: string;
}) {
  if (rial === null) {
    return <span className={`money money--unknown money--${size}`} title={unknownLabel}>
      <span aria-hidden="true" className="money-digits">—</span><span className="sr-only">{unknownLabel}</span>
    </span>;
  }
  const p = moneyParts(rial, compact, exact);
  const digits = p.sign === "negative" ? (negative === "parens" ? `(${p.digits})` : `−${p.digits}`) : p.digits;
  return <span className={`money money--${p.sign} money--${size}${muted ? " money--muted" : ""}`} title={compact ? p.spoken : undefined}>
    <bdi className="num money-digits">{digits}</bdi>
    {p.scale || unit ? <span className="money-unit">{[p.scale, unit ? "تومان" : ""].filter(Boolean).join(" ")}</span> : null}
    {side ? <span className="money-side">{side === "debit" ? "بدهکار" : "بستانکار"}</span> : null}
  </span>;
}

/** تعداد اعشاری API در برگ LTR. */
export function Qty({ value, unit }: { value: string; unit?: string }) {
  return <span className="money money--md"><bdi className="num money-digits">{formatQty(value)}</bdi>{unit ? <span className="money-unit">{unit}</span> : null}</span>;
}

/**
 * درصد با علامت و ممیز فارسی. `trend` فقط شکل و متن را عوض می‌کند، نه معنا را.
 * `null` یعنی درصد بی‌معناست (مبنا صفر) و «—» می‌شود، نه «۰٪».
 */
export function Percent({ value, trend, digits = 1 }: { value: number | null; trend?: "up" | "down" | "flat"; digits?: number }) {
  if (value === null) return <span className="percent percent--unknown" title="درصد تعریف‌نشده"><span aria-hidden="true">—</span><span className="sr-only">درصد تعریف‌نشده</span></span>;
  const glyph = trend === "up" ? "▲" : trend === "down" ? "▼" : trend === "flat" ? "■" : null;
  const word = trend === "up" ? "افزایش" : trend === "down" ? "کاهش" : trend === "flat" ? "بدون تغییر" : null;
  return <span className={`percent${trend ? ` percent--${trend}` : ""}`}>
    {glyph ? <span aria-hidden="true" className="percent-glyph">{glyph}</span> : null}
    {word ? <span className="sr-only">{word} </span> : null}
    <bdi className="num">{formatPercent(value, digits)}</bdi>
  </span>;
}
