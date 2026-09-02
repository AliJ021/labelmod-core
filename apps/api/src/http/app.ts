/**
 * ساخت اپلیکیشن Fastify.
 *
 * جدا از server.ts نگه داشته شده تا تست بتواند بدون باز کردن پورت،
 * همان اپلیکیشن واقعی را بالا بیاورد.
 */
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import type { AuthService } from "../auth/service.ts";
import type { Db } from "../db/client.ts";
import type { Config } from "../lib/config.ts";
import { registerErrorHandler } from "./errors.ts";
import { registerAuthRoutes } from "./auth-routes.ts";
import { registerSalesRoutes } from "./sales-routes.ts";
import { registerReturnRoutes } from "./return-routes.ts";
import { registerPostingRoutes } from "./posting-routes.ts";
import { registerCatalogRoutes } from "./catalog-routes.ts";
import { registerPurchasingRoutes } from "./purchasing-routes.ts";
import { registerSettingsRoutes } from "./settings-routes.ts";
import { registerScopeRoutes } from "./scope-routes.ts";
import { registerAdminRoutes } from "./admin-routes.ts";
import { InvoiceService } from "../sales/invoice.ts";
import { ShiftService } from "../sales/shift.ts";
import { ReturnService } from "../sales/return.ts";
import { PostingBatchService } from "../sales/posting-batch.ts";
import { VariationService } from "../catalog/variation.ts";
import { ReceiptService } from "../purchasing/receipt.ts";
import { StockCountService } from "../inventory/stock-count.ts";
import { PurchaseReturnService } from "../purchasing/return.ts";
import { SettingService } from "../platform/settings.ts";
import { safeEqual } from "../auth/password.ts";

declare module "fastify" {
  interface FastifyRequest {
    session: Awaited<ReturnType<AuthService["resolve"]>>;
  }
}

/** روش‌هایی که وضعیت را عوض نمی‌کنند و توکن CSRF نمی‌خواهند. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * مسیرهایی که از دفاع CSRF مستثنا هستند.
 *
 * فقط ورود — و دلیلش دو چیز است:
 *
 * ۱. **هیچ محافظتی اضافه نمی‌کرد.** کوکی نشست SameSite=Strict است، پس
 *    یک درخواست بین‌سایتی اصلاً کوکی نمی‌فرستد و شرط CSRF هرگز فعال
 *    نمی‌شد. یعنی این بررسی فقط روی درخواست‌های هم‌سایت اثر داشت.
 *
 * ۲. **یک تله می‌ساخت.** کاربری که کوکی نشستش مانده ولی کوکی CSRF را
 *    از دست داده — پاک‌کردن مرورگر، یا نشستی از پیش از این Deploy —
 *    دیگر هرگز نمی‌توانست وارد شود: هر تلاش ورود ۴۰۳ می‌گرفت و راه
 *    خروجی نبود جز پاک‌کردن دستی کوکی. وسط شیفت روی تبلت صندوق، این
 *    یعنی تماس با پشتیبانی.
 *
 * این در آزمایش زنده پیدا شد، نه در تست.
 */
const CSRF_EXEMPT_PATHS = new Set(["/auth/login"]);

/** مسیرهایی که پیش از ورود هم باید کار کنند. */
const PUBLIC_PATHS = new Set([
  "/health",
  "/auth/login",
  "/auth/logout",
  // نشست قفل‌شده از session_from_token چیزی نمی‌گیرد، پس این دو مسیر
  // نمی‌توانند پشت گیت نشست باشند. هر دو خودشان کوکی نشست را می‌خوانند
  // و دفاع CSRF هم رویشان اعمال می‌شود.
  "/auth/unlock",
  "/auth/reauth",
]);

export interface AppDeps {
  db: Db;
  auth: AuthService;
  config: Config;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, auth } = deps;

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // رمز، توکن، PIN و کوکی هرگز نباید در لاگ بنشینند.
      redact: {
        paths: [
          "req.headers.cookie",
          "req.headers.authorization",
          "req.body.password",
          "req.body.pin",
          "res.headers['set-cookie']",
        ],
        censor: "[حذف‌شده]",
      },
    },
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  // بدنه خالی با Content-Type: application/json را «شیء تهی» بگیر.
  //
  // چند مسیر بدنه نمی‌خواهند — نهایی‌سازی فاکتور، قفل صفحه، ابطال
  // سبد. ولی کلاینت‌های رایج (از جمله axios) روی هر POST سرآیند
  // application/json می‌گذارند، حتی بی‌بدنه. بدون این، همه‌شان
  // ۴۰۰ می‌گیرند با پیامی انگلیسی که کاربر نمی‌فهمد.
  //
  // این در آزمایش زنده پیدا شد؛ تست‌ها `payload: {}` می‌فرستادند و
  // هرگز به حالت واقعی نمی‌رسیدند.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body: string, done) => {
      if (body === "" || body === undefined) return done(null, {});
      try {
        done(null, JSON.parse(body) as unknown);
      } catch {
        const err = new Error("بدنه درخواست JSON معتبر نیست") as Error & {
          statusCode: number;
          code: string;
        };
        err.statusCode = 400;
        err.code = "invalid_json";
        done(err, undefined);
      }
    },
  );

  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    // خروجی این تابع به Error Handler می‌رسد، نه مستقیم به پاسخ. پس
    // باید یک Error با statusCode باشد تا ۴۲۹ سر جایش بماند — وگرنه
    // Handler آن را «خطای ناشناخته» می‌بیند و ۵۰۰ می‌دهد.
    errorResponseBuilder: () => {
      const err = new Error("درخواست‌های بیش از حد. کمی صبر کنید.") as Error & {
        statusCode: number;
        code: string;
      };
      err.statusCode = 429;
      err.code = "rate_limited";
      return err;
    },
  });

  registerErrorHandler(app);

  // نشست را برای همه مسیرها حل می‌کند، ولی فقط برای مسیرهای غیرعمومی
  // اجباری‌اش می‌کند. اینجا تنها جایی است که کوکی خوانده می‌شود.
  app.addHook("onRequest", async (req, reply) => {
    req.session = null;
    const token = req.cookies[config.COOKIE_NAME];
    if (token) req.session = await auth.resolve(token);

    // ── دفاع CSRF: Double-Submit ─────────────────────────────────────
    // بند ۶ SECURITY.md دو لایه خواسته: SameSite=Strict **به‌علاوه**
    // توکن Double-Submit. لایه اول از روز اول بود؛ این لایه دوم است.
    //
    // شرط بر «کوکی نشست همراه درخواست هست» گذاشته شده، نه بر «نشست حل
    // شد» — چون نشست قفل‌شده حل نمی‌شود ولی /auth/unlock همچنان یک
    // عملیات تغییردهنده وضعیت است و باید محافظت شود.
    const path = req.routeOptions.url ?? req.url.split("?")[0] ?? "";

    if (token && !SAFE_METHODS.has(req.method) && !CSRF_EXEMPT_PATHS.has(path)) {
      const cookieToken = req.cookies[config.CSRF_COOKIE_NAME];
      const headerToken = req.headers["x-csrf-token"];
      const ok =
        typeof cookieToken === "string" &&
        typeof headerToken === "string" &&
        cookieToken.length > 0 &&
        safeEqual(cookieToken, headerToken);

      if (!ok) {
        req.log.warn({ correlationId: req.id, path: req.url }, "توکن CSRF نامعتبر");
        return reply.code(403).send({
          error: {
            code: "csrf_failed",
            message: "توکن امنیتی درخواست نامعتبر است. صفحه را دوباره بارگذاری کنید.",
            correlationId: req.id,
          },
        });
      }
    }

    if (PUBLIC_PATHS.has(path)) return;
    if (!req.session) {
      return reply.code(401).send({
        error: { code: "no_session", message: "وارد نشده‌اید", correlationId: req.id },
      });
    }
  });

  app.get("/health", async () => ({ ok: true }));

  const shifts = new ShiftService(deps.db);

  registerAuthRoutes(app, deps);
  registerSalesRoutes(app, {
    db: deps.db,
    invoices: new InvoiceService(deps.db),
    shifts,
  });
  registerReturnRoutes(app, {
    db: deps.db,
    returns: new ReturnService(deps.db),
    shifts,
  });
  registerPostingRoutes(app, {
    db: deps.db,
    batches: new PostingBatchService(deps.db),
  });
  registerCatalogRoutes(app, {
    db: deps.db,
    variations: new VariationService(deps.db),
  });
  registerPurchasingRoutes(app, {
    db: deps.db,
    receipts: new ReceiptService(deps.db),
    counts: new StockCountService(deps.db),
    returns: new PurchaseReturnService(deps.db),
  });
  registerSettingsRoutes(app, {
    db: deps.db,
    settings: new SettingService(deps.db),
  });
  registerScopeRoutes(app, { db: deps.db });
  registerAdminRoutes(app, { db: deps.db });
  return app;
}
