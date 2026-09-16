/**
 * دروازه «کاهش قیمت» — یک تعریف، برای هر مسیری که قیمت را پایین می‌آورد.
 *
 * تا امروز این منطق داخل `http/sales-routes.ts` بود و تنها مشتری‌اش
 * صندوق بود. حالا سفارش سایت هم قیمت می‌فرستد؛ کپی‌کردنش یعنی دو
 * تعریف از یک قاعده مالی — و آنکه عقب می‌ماند همان است که دور زده
 * می‌شود. پس به اینجا منتقل شد، بدون تغییر رفتار.
 *
 * سه دروازه، به همین ترتیب:
 *
 * ۱. **ورودی بی‌معنا پیش از مجوز.** بدون این، قیمت صفر یک کاهش ۱۰۰٪
 *    بود و به‌جای «قیمت نامعتبر»، «نیازمند تأیید سرپرست» می‌گرفت —
 *    یعنی سیستم پیشنهاد می‌کرد کسی آن را تأیید کند.
 *
 * ۲. **اجازه تایپ‌کردن قیمت** (`sale.price_override`) — جدا از سقف
 *    تخفیف، چون دو چیز متفاوت‌اند: «آیا این نقش اصلاً حق دارد قیمت
 *    بنویسد» و «چقدر پایین‌تر از فهرست».
 *
 * ۳. **سقف کاهش کل** — تخفیف به‌علاوه تفاوت قیمت دستی، در یک عدد.
 *    کل امنیت این مسیر همین است: اگر فقط تخفیف سنجیده می‌شد،
 *    صندوق‌داری با سقف ۱۰٪ کافی بود قیمت را نصف بنویسد و همان کار را
 *    بی‌مجوز بکند.
 *
 *    دو عملیات، نه یکی: `sale.discount` سقف عادی نقش است و
 *    `sale.discount_high` پله بالاتر که تأیید می‌خواهد. اگر فقط اولی
 *    سنجیده می‌شد، تخفیف بالای سقف «ممنوع» می‌شد نه «نیازمند تأیید» —
 *    و سرپرست هیچ‌وقت پرسیده نمی‌شد.
 *
 * خودِ آستانه‌ها اینجا نیستند: هر دو از `permission_rule` می‌آیند. این
 * کد فقط می‌داند «یک پله بالاتر هم هست»، نه اینکه پله کجاست.
 */
import { can, requireForSession } from "../auth/permission.ts";
import { InvoiceError, type Executor, type InvoiceService } from "./invoice.ts";

export interface MarkdownActor {
  userId: string;
  pinUnlocked: boolean;
}

export interface MarkdownInput {
  variationId: string;
  qty: string;
  discount: bigint;
  /**
   * قیمتی که **همین حالا** دستی نوشته می‌شود. فقط این دروازه
   * `sale.price_override` را باز می‌کند.
   */
  settingPrice?: bigint | undefined;
  /**
   * قیمتی که سطر واقعاً به آن فروخته می‌شود — برای ریاضیِ سقف.
   *
   * روی سطری که **قبلاً** قیمت دستی خورده، تفاوت قیمت باید در «کاهش
   * کل» بیاید وگرنه سقف دور زده می‌شود؛ ولی مجوز نوشتن قیمت نباید
   * دوباره خواسته شود، چون کسی الان قیمتی نمی‌نویسد. یکی‌کردن این دو
   * یعنی یا سقف سوراخ می‌شود یا تخفیف مشروع رد.
   */
  effectivePrice?: bigint | undefined;
  /**
   * لحظه‌ای که «قیمت فهرست» باید در آن خوانده شود — `occurred_at`
   * فاکتور، نه زمان درخواست.
   *
   * Snapshot سطر از همان لحظه ساخته می‌شود؛ اگر دروازه از «حالا»
   * بخواند، حراجِ وسطِ یک پیش‌نویس باز، سقف را با عددی می‌سنجد که
   * روی فاکتور ننشسته. مسیری که هنوز فاکتور ندارد (سفارش سایت) این
   * را نمی‌فرستد و پیش‌فرض «حالا» درست است.
   */
  at?: Date | undefined;
  /** قیمت فهرستِ Snapshot شده زیر قفل سطر موجود. */
  listPrice?: bigint | undefined;
}

export async function assertMarkdownAllowed(
  db: Executor,
  invoices: InvoiceService,
  s: MarkdownActor,
  input: MarkdownInput,
): Promise<void> {
  if (input.settingPrice !== undefined && input.settingPrice <= 0n) {
    throw new InvoiceError("bad_price", "قیمت باید بزرگ‌تر از صفر باشد", 422);
  }
  if (input.settingPrice !== undefined) {
    await requireForSession(db, s, "sale.price_override");
  }

  const priceForMath = input.settingPrice ?? input.effectivePrice;
  if (input.discount <= 0n && priceForMath === undefined) return;

  const check = await invoices.markdownCheck(
    input.variationId,
    input.qty,
    input.discount,
    priceForMath,
    input.at,
    db,
    input.listPrice,
  );
  if (check.grossAmount <= 0n) return;

  const normal = await can(db, {
    userId: s.userId,
    operation: "sale.discount",
    percent: check.percent,
    amount: check.grossAmount,
    viaPin: s.pinUnlocked,
  });
  if (normal.verdict !== "allow") {
    await requireForSession(db, s, "sale.discount_high", {
      percent: check.percent,
      amount: check.grossAmount,
    });
  }
}
