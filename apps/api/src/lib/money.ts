/**
 * پول — ریال، عدد صحیح، بدون اعشار.
 *
 * سه نمایش، سه لایه، و مرز میانشان اینجاست:
 *
 *   SQL          NUMERIC(18,0)   ← platform.money
 *   TypeScript   bigint
 *   JSON         string          ← نه number
 *
 * چرا JSON رشته است: Number.MAX_SAFE_INTEGER برابر ۹٬۰۰۷٬۱۹۹٬۲۵۴٬۷۴۰٬۹۹۱
 * است. یک مبلغ ریالی نُه‌رقمی امروز مشکلی ندارد، ولی جمع فروش سالانه یا
 * یک قلم گران به مرز نزدیک می‌شود و آن‌وقت JSON.parse بی‌صدا رقم آخر را
 * عوض می‌کند. باگی که فقط روی بعضی اعداد ظاهر شود، بدترین نوع باگ مالی
 * است.
 *
 * نمایش تومان (÷۱۰) فقط در لایه UI. اینجا هیچ تقسیمی نیست.
 */

/** بیشترین مقداری که NUMERIC(18,0) جا می‌دهد. */
export const MONEY_MAX = 999_999_999_999_999_999n;
export const MONEY_MIN = -999_999_999_999_999_999n;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/**
 * رشته‌ای که از دیتابیس یا JSON آمده را به bigint تبدیل می‌کند.
 *
 * عمداً سخت‌گیر است: `number` نمی‌پذیرد، اعشار نمی‌پذیرد، و رشته خالی
 * نمی‌پذیرد. هر کدام از این‌ها یعنی جایی در مسیر، پول از نوع درست خارج
 * شده — و ساکت پذیرفتنشان همان چیزی است که رانج را می‌سازد.
 */
export function parseMoney(input: unknown): bigint {
  if (typeof input === "bigint") return assertRange(input);

  if (typeof input === "number") {
    throw new MoneyError(
      `پول به‌صورت number رسید (${input}). پول باید bigint یا رشته باشد — number دقت مبالغ ریالی را از دست می‌دهد.`,
    );
  }

  if (typeof input !== "string") {
    throw new MoneyError(`مقدار پولی نامعتبر: ${typeof input}`);
  }

  const trimmed = input.trim();
  if (trimmed === "") throw new MoneyError("مبلغ خالی است");

  // NUMERIC(18,0) از پستگرس گاهی «۱۲۳۴» و گاهی «1234.00» برمی‌گرداند
  // (مثلاً از sum() روی ستون NUMERIC). صفرهای اعشاری قابل حذف‌اند؛
  // هر اعشار غیرصفری یعنی یک محاسبه جایی گرد نشده و باید بشکند.
  const match = /^(-?\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) throw new MoneyError(`مبلغ نامعتبر: «${input}»`);

  const [, whole, fraction] = match;
  if (fraction !== undefined && /[^0]/.test(fraction)) {
    throw new MoneyError(
      `مبلغ «${input}» اعشار دارد. ریال واحد صحیح است؛ گرد کردن باید صریح و پیش از این نقطه انجام شود.`,
    );
  }

  return assertRange(BigInt(whole as string));
}

function assertRange(value: bigint): bigint {
  if (value > MONEY_MAX || value < MONEY_MIN) {
    throw new MoneyError(`مبلغ ${value} از ظرفیت NUMERIC(18,0) بیرون است`);
  }
  return value;
}

/** برای JSON و برای پارامتر کوئری — همیشه رشته. */
export function serializeMoney(value: bigint): string {
  return assertRange(value).toString();
}

/**
 * تقسیم نسبتی با ته‌مانده — بدون هیچ اعشاری.
 *
 * جایی لازم است که یک مبلغ باید میان چند سطر پخش شود (تخفیف فاکتور روی
 * اقلام، هزینه حمل روی رسید خرید). اگر هر سطر جدا گرد شود، جمع سطرها با
 * مبلغ اصلی نمی‌خواند و سند نامتوازن می‌شود. اینجا ته‌مانده به سطرهای
 * اول داده می‌شود تا جمع **دقیقاً** برابر مبلغ ورودی بماند.
 */
export function allocate(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) throw new MoneyError("تخصیص بدون سطر ممکن نیست");
  if (weights.some((w) => w < 0n)) throw new MoneyError("وزن منفی در تخصیص");

  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum === 0n) throw new MoneyError("جمع وزن‌ها صفر است");

  const shares = weights.map((w) => (total * w) / sum);
  let remainder = total - shares.reduce((a, b) => a + b, 0n);

  // ته‌مانده همیشه هم‌علامت total است، پس گام یک واحدی در همان جهت
  const step = remainder < 0n ? -1n : 1n;
  for (let i = 0; remainder !== 0n; i = (i + 1) % shares.length) {
    if (weights[i] === 0n) continue;
    shares[i] = (shares[i] as bigint) + step;
    remainder -= step;
  }
  return shares;
}

/** تومان برای نمایش. فقط در مرز خروجی UI، هرگز در محاسبه. */
export function toTomanDisplay(rial: bigint): string {
  const negative = rial < 0n;
  const abs = negative ? -rial : rial;
  const toman = abs / 10n;
  const text = toman.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "٬");
  return negative ? `−${text}` : text;
}
