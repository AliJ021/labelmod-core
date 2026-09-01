/**
 * خطا به کاربر بدون Stack Trace؛ جزئیات فقط در لاگ با Correlation ID.
 *
 * بند ۶ SECURITY.md. اینجا تنها جایی است که خطا به بدنه پاسخ تبدیل
 * می‌شود، تا هیچ مسیری سهواً جزئیات داخلی را بیرون ندهد.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AuthError } from "../auth/service.ts";
import { ForbiddenError } from "../auth/permission.ts";
import { MoneyError } from "../lib/money.ts";
import { InvoiceError } from "../sales/invoice.ts";
import { ShiftError } from "../sales/shift.ts";
import { ScopeError } from "../sales/scope.ts";
import { ReturnError } from "../sales/return.ts";
import { BatchError } from "../sales/posting-batch.ts";
import { CatalogError } from "../catalog/variation.ts";
import { SettingError } from "../platform/settings.ts";
import { IdempotencyConflictError, IdempotencyInFlightError } from "../lib/idempotency.ts";
import { ZodError } from "zod";

export interface ErrorBody {
  error: { code: string; message: string; correlationId: string };
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req: FastifyRequest, reply: FastifyReply) => {
    const correlationId = req.id;

    if (err instanceof ZodError) {
      const first = err.issues[0];
      const where = first?.path.join(".") ?? "ورودی";
      req.log.info({ err, correlationId }, "ورودی نامعتبر");
      return reply.code(400).send(body("invalid_input", `${where}: ${first?.message ?? "نامعتبر"}`, correlationId));
    }

    if (err instanceof MoneyError) {
      req.log.warn({ err, correlationId }, "خطای مبلغ");
      return reply.code(400).send(body("invalid_amount", err.message, correlationId));
    }

    if (err instanceof AuthError) {
      // ۴۲۹ برای قفل: کاربر باید بداند مشکل نرخ است نه اعتبارنامه،
      // بدون اینکه بفهمد کدام نام کاربری وجود دارد.
      // ۴۰۳ برای PIN: اعتبارنامه درست بود، ولی این مسیر مجاز نیست.
      const status =
        err.code === "locked" ? 429 : err.code === "pin_not_allowed" ? 403 : 401;
      req.log.info({ code: err.code, correlationId }, "شکست احراز هویت");
      return reply.code(status).send(body(err.code, err.message, correlationId));
    }

    if (err instanceof ForbiddenError) {
      const status = err.decision.verdict === "needs_approval" ? 428 : 403;
      req.log.info({ operation: err.operation, correlationId }, "مجوز رد شد");
      return reply.code(status).send(body(err.decision.verdict, err.message, correlationId));
    }

    // خطاهای دامنه فروش و صندوق. هر کدام کد و وضعیت خودش را حمل
    // می‌کند، پس اینجا فقط ترجمه می‌شوند نه دسته‌بندی دوباره.
    if (
      err instanceof InvoiceError ||
      err instanceof ShiftError ||
      err instanceof ScopeError ||
      err instanceof ReturnError ||
      err instanceof BatchError ||
      err instanceof CatalogError ||
      err instanceof SettingError ||
      err instanceof IdempotencyInFlightError ||
      err instanceof IdempotencyConflictError
    ) {
      req.log.info({ code: err.code, correlationId }, "درخواست فروش رد شد");
      return reply.code(err.statusCode).send(body(err.code, err.message, correlationId));
    }

    // نگهبان‌های دیتابیس.
    //
    // هر RAISE EXCEPTION در توابع ما SQLSTATE پیش‌فرض P0001 می‌گیرد و
    // پیامش **عمداً فارسی و برای کاربر نوشته شده** — «موجودی کافی
    // نیست»، «سند نامتوازن است»، «PIN روی این دستگاه مجاز نیست».
    //
    // پیش از این همه‌شان ۵۰۰ می‌شدند: یعنی قاعده‌ای که درست کار کرده
    // بود، شبیه خرابی سرور گزارش می‌شد. همان الگویی که یک بار برای
    // محدودیت نرخ گرفتیم — و دفاعی که شبیه خرابی باشد، در عمل خاموش
    // است چون کسی به لاگ ۵۰۰ اعتماد نمی‌کند.
    //
    // ۴۰۹ است نه ۴۰۰: ورودی معتبر بود، ولی با وضعیت فعلی سیستم
    // نمی‌خواند.
    const dbError = err as { code?: string; message?: string; constraint?: string };

    // نقض یکتایی — **فقط** همان قید مشخصی که معنایش را می‌دانیم.
    //
    // نگاشت کورِ هر ۲۳۵۰۵ به «پرداخت تکراری» بدتر از نگاشت‌نکردنش
    // بود: یک تصادف روی SKU یا بارکد هم همان پیام را می‌گرفت و کسی
    // دنبال علت واقعی نمی‌گشت. تصمیم از روی نام قید گرفته می‌شود.
    //
    // قید یکتایی `platform.inbox_message` اینجا نمی‌رسد: `runOnce`
    // خودش می‌گیردش و یا Replay می‌کند یا `idempotency_in_flight`.
    if (dbError.code === "23505" && dbError.constraint === "payment_client_event_unique") {
      req.log.info({ correlationId }, "پرداخت تکراری با همان کلید رویداد");
      return reply
        .code(409)
        .send(
          body(
            "duplicate_client_event",
            "این پرداخت پیش‌تر با همین کلید ثبت شده است.",
            correlationId,
          ),
        );
    }

    if (dbError.code === "P0001") {
      const rule = dbError.message ?? "قاعده سیستم این عملیات را رد کرد";
      req.log.info({ correlationId, rule }, "قاعده دیتابیس درخواست را رد کرد");
      return reply.code(409).send(body("rule_violation", rule, correlationId));
    }

    // خطاهایی که خودِ Fastify یا افزونه‌هایش وضعیت داده‌اند — محدودیت
    // نرخ (۴۲۹)، بدنه بزرگ (۴۱۳)، JSON خراب (۴۰۰) — باید همان وضعیت را
    // نگه دارند.
    //
    // این را در آزمایش زنده فهمیدیم: پیش از این، محدودیت نرخ درست فعال
    // می‌شد ولی اینجا ۵۰۰ می‌گرفت. یعنی دفاعی که داشت کار می‌کرد، شبیه
    // خرابی سرور گزارش می‌شد و لاگ خطا را هم پر می‌کرد.
    const tagged = err as { statusCode?: number; code?: string; message?: string };
    const status = tagged.statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      const code = tagged.code ?? "request_rejected";
      req.log.info({ code, status, correlationId }, "درخواست رد شد");
      return reply
        .code(status)
        .send(body(code, tagged.message ?? "درخواست پذیرفته نشد", correlationId));
    }

    // هر چیز دیگری: پیام عمومی. جزئیات فقط در لاگ.
    req.log.error({ err, correlationId }, "خطای پیش‌بینی‌نشده");
    return reply
      .code(500)
      .send(body("internal", "خطای داخلی. کد پیگیری را به پشتیبانی بدهید.", correlationId));
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send(body("not_found", "مسیر یافت نشد", req.id)),
  );
}

function body(code: string, message: string, correlationId: string): ErrorBody {
  return { error: { code, message, correlationId } };
}
