/**
 * مصرف‌کننده‌های Outbox.
 *
 * ── قاعده‌ای که هر Handler اینجا رعایت می‌کند ───────────────────────
 *
 * **تحویل «حداقل یک بار» است.** Workerی که پس از ارسال پیامک و پیش از
 * `complete_outbox` بمیرد، همان پیام را دوباره برمی‌دارد. این را
 * نمی‌شود در دیتابیس حل کرد؛ پس Handler یا باید بی‌ضرر تکرارشدنی باشد،
 * یا خودش جلوی اثر دوم را بگیرد.
 *
 * پیامک بی‌ضرر تکرارشدنی است: مشتری یک پیام تکراری می‌گیرد، نه یک
 * فاکتور دوم. برای همین اینجا از قفل تازه‌ای استفاده نشده — قفلی که
 * لازم نیست، فقط یک راه گیرکردن تازه است.
 *
 * ── و قاعده دوم: خاموش‌بودن یک شکست نیست ────────────────────────────
 *
 * اگر `notify.sms_enabled` خاموش باشد یا مشتری شماره نداشته باشد،
 * پیام **موفق** بسته می‌شود، نه ناموفق. چیزی که قرار نبود برود، نرفتن
 * را به‌عنوان خطا گزارش نمی‌کند — وگرنه نامه مرده پر می‌شد از
 * پیام‌هایی که هیچ‌کس قرار نبود بگیرد، و همان‌جا خطای واقعی گم می‌شد.
 */
import { sql } from "kysely";
import type { Db } from "../db/client.ts";
import { parseMoney } from "../lib/money.ts";
import { toToman } from "../sales/invoice-page.ts";
import { SmsError, toLocalMobile, type SmsSender } from "./sms.ts";
import type { NotifySettings } from "./settings.ts";
import type { WebhookSender } from "./webhook.ts";

export interface HandlerContext {
  db: Db;
  settings: NotifySettings;
  sms: SmsSender;
  /**
   * ⚠️ تا امروز اینجا نبود و **هیچ Handlerی Webhook نمی‌فرستاد** — در
   *    حالی که `notify.webhook_enabled` در صفحهٔ تنظیمات وعدهٔ «ارسال
   *    لینک فاکتور» می‌داد و `makeWebhookSender` نوشته و تست شده بود.
   *    یک کلید تنظیم که روشن‌کردنش هیچ کاری نمی‌کند، بدتر از نبودنش است.
   */
  webhook: WebhookSender;
}

export interface OutboxMessage {
  id: string;
  topic: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/** نتیجه یک Handler. `skipped` یعنی «کاری نبود»، نه «نشد». */
export interface HandlerResult {
  done: true;
  note: string;
}

/**
 * فاکتور نهایی شد → پیامک به مشتری، با لینک فاکتور.
 *
 * ⚠️ لینک از `platform.public_url` ساخته می‌شود، نه از هدر درخواست:
 *    Worker درخواستی ندارد که هدری داشته باشد، و هدر `Host` را کلاینت
 *    می‌فرستد — لینکی که از آن ساخته شود، به دامنه‌ای می‌رفت که مهاجم
 *    انتخاب کرده.
 */
export async function handleInvoiceFinalized(
  ctx: HandlerContext,
  msg: OutboxMessage,
): Promise<HandlerResult> {
  const invoiceId = String(msg.payload["invoice_id"] ?? "");
  if (!invoiceId) throw new SmsError("پیام بدون شناسه فاکتور", true);

  if (!ctx.settings.invoiceSms) {
    return { done: true, note: "پیامک فاکتور خاموش است" };
  }
  if (!ctx.settings.publicUrl) {
    // بدون نشانی عمومی، لینکی نیست و پیامکِ بی‌لینک بی‌فایده است.
    // ⚠️ این خطا **دائمی نیست**: مالک می‌تواند تنظیم را پر کند و
    //    پیام‌های در صف بعداً برود. دائمی‌کردنش یعنی فاکتورهای امروز
    //    برای همیشه بی‌پیامک بمانند.
    throw new SmsError("نشانی عمومی (platform.public_url) تنظیم نشده است");
  }

  const r = await sql<{
    number: string | null;
    payable_amount: string;
    mobile: string | null;
    consent: boolean | null;
    shop_name: string | null;
  }>`
    SELECT i.number, i.payable_amount::text,
           c.mobile_normalized AS mobile,
           c.consent_sms       AS consent,
           (SELECT b.name FROM platform.branch b WHERE b.id = i.branch_id) AS shop_name
      FROM sales.invoice i
      LEFT JOIN sales.customer c ON c.id = i.customer_id
     WHERE i.id = ${invoiceId}::uuid
  `.execute(ctx.db);

  const row = r.rows[0];
  if (!row) {
    // فاکتور رفته ولی پیامش مانده. تلاش دوباره چیزی را برنمی‌گرداند.
    throw new SmsError("فاکتور یافت نشد", true);
  }
  if (!row.number) return { done: true, note: "فاکتور شماره ندارد" };

  // فروش ناشناس عادی است — بیشتر فروش صندوق همین است.
  if (!row.mobile) return { done: true, note: "فاکتور بی‌مشتری" };

  // ── رضایت پیامک: یک تصمیم حقوقی، پس یک تنظیم ────────────────────
  //
  // `sales.customer.consent_sms` پیش‌فرض **false** است — یعنی
  // «رضایت گرفته‌نشده»، نه «رد کرده». دو خوانش از آن ممکن است و هر
  // دو مدافع دارند:
  //
  //   • پیامک فاکتور **تراکنشی** است: مشتری شماره‌اش را برای همین
  //     خرید داده و رسید خودش را می‌گیرد، نه تبلیغ.
  //   • یا: هیچ پیامکی بدون رضایت صریح نمی‌رود.
  //
  // انتخاب میان این دو کار ما نیست. پیش‌فرض `true` است — سخت‌گیرانه‌تر
  // — و مالک می‌تواند در تنظیمات عوضش کند. بند ۳ SECURITY.md رضایت
  // بازاریابی را صریح و قابل بازپس‌گیری می‌خواهد؛ آن `consent_marketing`
  // است و این سیستم هنوز اصلاً کمپین نمی‌فرستد.
  if (ctx.settings.invoiceSmsRequiresConsent && row.consent !== true) {
    return { done: true, note: "مشتری رضایت پیامک نداده" };
  }

  const to = toLocalMobile(row.mobile);
  if (!to) throw new SmsError(`شماره «${row.mobile}» موبایل معتبر نیست`, true);

  // توکن لینک Idempotent است: ارسال دوباره همان لینک را می‌فرستد، نه
  // یک لینک تازه — پس مشتری با هر دو پیامک به یک صفحه می‌رسد.
  const t = await sql<{ token: string }>`
    SELECT sales.ensure_public_token(${invoiceId}::uuid) AS token
  `.execute(ctx.db);
  const token = t.rows[0]?.token;
  if (!token) throw new SmsError("ساخت نشانی فاکتور ناموفق بود");

  const shop = row.shop_name ?? "فروشگاه";
  const amount = toToman(parseMoney(row.payable_amount));
  const link = `${ctx.settings.publicUrl}/i/${token}`;

  await ctx.sms.send(
    to,
    `${shop}\nفاکتور ${row.number} ثبت شد.\nمبلغ: ${amount} تومان\n${link}`,
  );

  /*
   * و همان لینک به پیام‌رسان.
   *
   * ⚠️ **ترتیب عمدی است: پیامک اول، Webhook بعد.** پیامک راهِ تضمینیِ
   *    رسیدن به مشتری است و Webhook یک پل اختیاری به سرویس مالک. اگر
   *    Webhook اول بود و ۵xx می‌داد، کل پیام Backoff می‌گرفت و پیامکِ
   *    مشتری هم تا تلاش بعدی معلق می‌ماند.
   *
   * ⚠️ و اگر Webhook شکست بخورد، پیام **دوباره** برداشته می‌شود و
   *    پیامک هم دوباره می‌رود — تحویل «حداقل یک بار» است. پیامک تکراری
   *    آزاردهنده است ولی بی‌ضرر؛ راه‌حل واقعی‌اش یک ستون «چه چیزی رفت»
   *    روی صف است که امروز لازم نیست و پیچیدگی‌اش را نمی‌ارزد.
   */
  await ctx.webhook.send({
    kind: "invoice",
    invoiceNumber: row.number,
    customerName: null,
    mobile: to,
    amountRial: row.payable_amount,
    link,
  });

  return { done: true, note: `فاکتور ${row.number} → ${to}` };
}

/**
 * چک نزدیک سررسید یا گذشته → پیامک به مدیر.
 *
 * ⚠️ متن پیام از **payload** ساخته می‌شود، نه از خواندن دوباره چک.
 *    payload عکسِ لحظه‌ای است که هشدار ساخته شد؛ اگر چک بین ساخت و
 *    ارسال وصول شده باشد، پیامِ «وصول شد» درست‌تر نیست — پیامی است که
 *    دیگر لازم نیست. پس وضعیت جاری هم سنجیده می‌شود و پیامِ بی‌موضوع
 *    بی‌سروصدا بسته می‌شود.
 */
export async function handleChequeDue(
  ctx: HandlerContext,
  msg: OutboxMessage,
): Promise<HandlerResult> {
  if (!ctx.settings.chequeDueSms) {
    return { done: true, note: "پیامک هشدار چک خاموش است" };
  }
  const to = toLocalMobile(ctx.settings.managerMobile);
  if (!to) {
    // مثل نشانی عمومی: قابل جبران با یک تغییر تنظیم، پس دائمی نیست.
    throw new SmsError("موبایل مدیر (notify.manager_mobile) تنظیم نشده است");
  }

  const chequeId = String(msg.payload["cheque_id"] ?? "");
  const still = await sql<{ status: string }>`
    SELECT status FROM treasury.cheque WHERE id = ${chequeId}::uuid
  `.execute(ctx.db);
  const status = still.rows[0]?.status;
  if (!status) throw new SmsError("چک یافت نشد", true);

  // وصول‌شده، برگشتی و باطل دیگر هشدار لازم ندارند.
  if (!["in_hand", "deposited", "issued", "endorsed"].includes(status)) {
    return { done: true, note: `چک دیگر باز نیست (${status})` };
  }

  const daysLeft = Number(msg.payload["days_left"] ?? 0);
  const amount = toToman(parseMoney(String(msg.payload["amount"] ?? "0")));
  // ⚠️ مقدارها `received` و `issued`‌اند (قید `treasury.cheque`)، نه
  //    چیزی که از حافظه حدس زده شود. «دریافتی» یعنی چک مشتری دست
  //    ماست و «پرداختی» یعنی چک ما دست تأمین‌کننده — دو کار کاملاً
  //    متفاوت برای مدیری که پیام را می‌خواند.
  const dir = msg.payload["direction"] === "received" ? "دریافتی" : "پرداختی";
  const party = String(msg.payload["party_name"] ?? "").trim();
  const no = String(msg.payload["cheque_no"] ?? "");

  const when =
    daysLeft < 0
      ? `${Math.abs(daysLeft)} روز از سررسیدش گذشته`
      : daysLeft === 0
        ? "امروز سررسید است"
        : `${daysLeft} روز تا سررسید`;

  await ctx.sms.send(
    to,
    `چک ${dir} ${no}${party ? ` — ${party}` : ""}\n` +
      `مبلغ: ${amount} تومان\n${when}.`,
  );

  return { done: true, note: `چک ${no} → ${to}` };
}

/**
 * زنگ خطر سیستم → مدیر.
 *
 * ── چرا متن از payload ساخته می‌شود و زنگ دوباره خوانده نمی‌شود ──────
 *
 * همان دلیل هشدار چک: payload عکسِ لحظه‌ای است که زنگ به صدا درآمد.
 * ولی برخلاف چک، اینجا **دوباره سنجیده نمی‌شود** که زنگ هنوز فعال است
 * یا نه — و این عمدی است: «درآمد ثبت‌نشدهٔ دیروز حالا ثبت شده» یعنی
 * کسی دستی حلش کرده، و مالک باید بداند که چنین چیزی پیش آمده بود.
 * هشداری که پس از رفع مشکل بی‌صدا حذف شود، تاریخِ حادثه را پاک می‌کند.
 *
 * ⚠️ **خاموش‌بودن یک شکست نیست.** کلید خاموش، مقصد تنظیم‌نشده — هر دو
 *    با `complete` بسته می‌شوند نه `fail`. وگرنه `outbox_dead` پر
 *    می‌شد از هشدارهایی که قرار نبود بروند و خطای واقعی همان‌جا گم
 *    می‌شد.
 */
export async function handleHealthAlert(
  ctx: HandlerContext,
  msg: OutboxMessage,
): Promise<HandlerResult> {
  if (!ctx.settings.healthAlerts) {
    return { done: true, note: "هشدار سلامت خاموش است" };
  }

  const code = String(msg.payload["code"] ?? "");
  const title = String(msg.payload["title"] ?? "");
  if (code === "" || title === "") {
    // پیام بی‌کد با تلاش دوباره کد پیدا نمی‌کند.
    throw new SmsError("پیام هشدار بدون کد یا عنوان", true);
  }

  const severity = String(msg.payload["severity"] ?? "warn");
  const count = Number(msg.payload["count"] ?? 0);
  const detail = String(msg.payload["detail"] ?? "");
  const businessDate = String(msg.payload["business_date"] ?? "");
  const mark = severity === "critical" ? "⛔" : "⚠️";

  const to = toLocalMobile(ctx.settings.managerMobile);
  const canWebhook = ctx.settings.webhookEnabled && ctx.settings.webhookUrl !== "";

  // هیچ مقصدی تنظیم نشده: پیام بسته می‌شود با یادداشتی که در لاگ
  // دیده می‌شود. ناموفق‌کردنش یعنی نامهٔ مرده پر شود از هشدارهایی که
  // مقصد نداشتند — و همان‌جا یک خطای واقعی گم شود.
  if (!to && !canWebhook) {
    return { done: true, note: `هشدار ${code}: مقصدی تنظیم نشده` };
  }

  if (to) {
    await ctx.sms.send(
      to,
      `${mark} ${title}\nتعداد: ${count.toLocaleString("fa-IR")}` +
        (detail === "" || detail === "—" ? "" : `\n${detail}`),
    );
  }

  await ctx.webhook.send({
    kind: "health",
    code,
    severity,
    title,
    count,
    detail,
    businessDate,
  });

  return { done: true, note: `هشدار ${code} → ${to || "Webhook"}` };
}

/** موضوع → Handler. موضوع ناشناخته یک خطای دائمی است، نه یک حلقه. */
export const HANDLERS: Record<
  string,
  (ctx: HandlerContext, msg: OutboxMessage) => Promise<HandlerResult>
> = {
  "invoice.finalized": handleInvoiceFinalized,
  "cheque.due": handleChequeDue,
  "health.alert": handleHealthAlert,
};
