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
import { registerProductRoutes } from "./product-routes.ts";
import { registerTreasuryRoutes } from "./treasury-routes.ts";
import { registerReportRoutes } from "./report-routes.ts";
import { registerTransferRoutes } from "./transfer-routes.ts";
import { registerPeopleRoutes } from "./people-routes.ts";
import { TwoFactorService } from "../auth/two-factor.ts";
import { WebauthnService } from "../auth/webauthn.ts";
import { UserService } from "../people/user.ts";
import { CustomerService } from "../people/customer.ts";
import { TransferService } from "../inventory/transfer.ts";
import { ReportService } from "../reports/service.ts";
import { DeviceService } from "../auth/devices.ts";
import { registerPurchasingRoutes } from "./purchasing-routes.ts";
import { registerSettingsRoutes } from "./settings-routes.ts";
import { registerScopeRoutes } from "./scope-routes.ts";
import { registerAdminRoutes } from "./admin-routes.ts";
import { registerHealthRoutes } from "./health-routes.ts";
import { registerWebRoutes } from "./web-routes.ts";
import { registerPublicRoutes, PUBLIC_ROUTE_PATHS } from "./public-routes.ts";
import { InvoiceService } from "../sales/invoice.ts";
import { ShiftService } from "../sales/shift.ts";
import { ReturnService } from "../sales/return.ts";
import { PostingBatchService } from "../sales/posting-batch.ts";
import { VariationService } from "../catalog/variation.ts";
import { ProductService } from "../catalog/product.ts";
import { TreasuryService } from "../treasury/transaction.ts";
import { ChequeService } from "../treasury/cheque.ts";
import { ReceiptService } from "../purchasing/receipt.ts";
import { StockCountService } from "../inventory/stock-count.ts";
import { PurchaseReturnService } from "../purchasing/return.ts";
import { PurchaseOrderService } from "../purchasing/order.ts";
import { SettingService } from "../platform/settings.ts";
import { WebOrderService } from "../sales/web-order.ts";
import { safeEqual } from "../auth/password.ts";
import { apiKeyFrom, resolveApiKey } from "../auth/api-key.ts";
import {
  currentRequestContext,
  runInRequestContext,
} from "../lib/request-context.ts";

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
const CSRF_EXEMPT_PATHS = new Set([
  "/auth/login",
  // مرحله دوم ورود: هنوز نشستی نیست، پس توکن Double-Submit هم نیست.
  // دفاع اینجا خودِ بلیت است — کوکی HttpOnly و یک‌بارمصرف که فقط
  // پاسخ مرحله اول ست می‌کند و مهاجم از سایت دیگر نمی‌تواند بخواندش.
  "/auth/2fa/totp",
  "/auth/2fa/recovery",
  "/auth/2fa/webauthn/begin",
  "/auth/2fa/webauthn/verify",
]);

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
  // مرحله دوم ورود. رمز درست بوده ولی هنوز نشستی نیست — این مسیرها
  // بلیت `labelmod_pending` را می‌خوانند، نه کوکی نشست را.
  "/auth/2fa/totp",
  "/auth/2fa/recovery",
  // ⚠️ مسیر **ورود** با کلید عمداً نامش `/verify` است، نه همان
  //    `/auth/2fa/webauthn`. آن یکی فهرست کلیدهای کاربر را می‌دهد و
  //    باید پشت نشست بماند؛ اگر هر دو یک مسیر بودند، عمومی‌کردن
  //    ورود، فهرست را هم از گیت بیرون می‌برد.
  "/auth/2fa/webauthn/begin",
  "/auth/2fa/webauthn/verify",
  // صفحه فاکتور مشتری. مشتری حساب کاربری ندارد و نباید داشته باشد؛
  // جای احراز هویت را توکن ۲۴ بایتی روی خودِ فاکتور می‌گیرد.
  ...PUBLIC_ROUTE_PATHS,
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
      // Log route templates, never bearer capabilities or private query values.
      // Unmatched paths are arbitrary input and have no safe route template.
      serializers: {
        req(request) {
          const remotePort = request.socket?.remotePort;
          return {
            method: request.method,
            url: request.routeOptions?.url ?? "[unmatched]",
            remoteAddress: request.ip,
            ...(remotePort === undefined ? {} : { remotePort }),
          };
        },
        // ── خطا: پیام و رد تشخیصی بماند، **مقدارِ ستون** نه ─────────
        //
        // ⚠️ اینجا جایی است که نشت واقعی رخ می‌دهد، نه در لاگ موفق.
        // `errors.ts` دقیقاً **دو** قید یکتا را به‌اسم می‌شناسد
        // (`payment_client_event_unique` و `one_open_shift_per_user`)؛
        // ۴۱ قید یکتای دیگر اسکیما به `log.error({ err })` می‌افتند.
        //
        // و خطای `pg` یک شیء با خصیصه‌های شمردنی است که Pino همه‌شان را
        // Serialize می‌کند — از جمله `detail`، که **مقدار ستون متعارض را
        // در خودش دارد**:
        //
        //     detail = 'Key (mobile_normalized)=(09121119999) already exists.'
        //
        // یازده قید یکتا روی ستون‌های راز یا PII نشسته‌اند، از جمله
        // `invoice_public_token_key` — همان توکنی که سریالایزر `req`
        // بالا برای بیرون نگه‌داشتنش نوشته شد. حذفش از خط درخواست و
        // جا گذاشتنش در خط خطا، نیم‌دفاع است.
        //
        // ⚠️ Redaction نباید ردیابی را بکشد: `message`، `code`،
        // `constraint`، `table`، `schema`، `routine` و `stack` می‌مانند —
        // برای رسیدگی به یک تراکنش کافی‌اند. فقط میدان‌های
        // **مقدار‌حمل‌کن** می‌روند.
        err(error) {
          const e = error as unknown as Record<string, unknown>;
          const out: { type: string; message: string; stack: string; [k: string]: unknown } = {
            type: typeof e["name"] === "string" ? (e["name"] as string) : "Error",
            message: typeof e["message"] === "string" ? (e["message"] as string) : String(error),
            stack: typeof e["stack"] === "string" ? (e["stack"] as string) : "",
          };
          // فهرست **مجاز**، نه فهرست ممنوع: خصیصه تازه‌ای که فردا یک
          // درایور اضافه کند، خودبه‌خود بیرون می‌ماند نه داخل.
          for (const k of ["code", "constraint", "table", "schema", "routine",
                           "severity", "statusCode", "operation", "rule"]) {
            if (e[k] !== undefined) out[k] = e[k];
          }
          return out;
        },
      },
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

  // ── زمینهٔ درخواست ────────────────────────────────────────────────
  //
  // تا `ip` و `device` به لاگ حسابرسی برسند. ستون‌ها از قبل بودند و
  // `platform.set_actor` هر دو را می‌گرفت، ولی ~۷۰ فراخوان
  // `setActor(trx, actorId)` در ماژول‌های مالی فقط دو آرگومان اول را
  // می‌دادند. اندازه‌گیری: `session.open` هر دو را داشت، `shift.open`
  // هیچ‌کدام. پس معیار پذیرش ۱۳ سند برقرار نبود.
  //
  // ⚠️ Hook به‌شکل **Callback** است نه `async`: `done` داخل
  //    `AsyncLocalStorage.run` صدا زده می‌شود، پس بقیهٔ چرخهٔ عمر
  //    درخواست داخل همان زمینه می‌ماند و **با پایانش تمام می‌شود**.
  //    نسخهٔ اول `enterWith` می‌زد و زمینه بیرون از درخواست نشت می‌کرد.
  //
  // و `correlationId` — همان `req.id` که تا مهاجرت ۰۵۶ فقط در لاگ و
  // پاسخ خطا بود و هیچ میدان مشترکی با `audit_log` نداشت (FND-018).
  app.addHook("onRequest", (req, _reply, done) => {
    runInRequestContext({ ip: req.ip, correlationId: req.id }, done);
  });

  // نشست را برای همه مسیرها حل می‌کند، ولی فقط برای مسیرهای غیرعمومی
  // اجباری‌اش می‌کند. اینجا تنها جایی است که کوکی خوانده می‌شود.
  app.addHook("onRequest", async (req, reply) => {
    req.session = null;

    // ── زمینهٔ درخواست: تا `ip` و `device` به لاگ حسابرسی برسند ───────
    //
    // `audit_log.ip` و `.device` از قبل ستون داشتند و
    // `platform.set_actor` هر دو را می‌گرفت، ولی **تقریباً هیچ عملیات
    // مالی‌ای پرشان نمی‌کرد**: ~۷۰ فراخوان `setActor(trx, actorId)` فقط
    // دو آرگومان اول را می‌دادند. اندازه‌گیری شد:
    //
    //     session.open  ۲۱ سطر → ip و device هر دو پر
    //     shift.open     ۱ سطر → هر دو NULL
    //
    // ⚠️ `ip` و `device` خصوصیتِ **درخواست**اند نه پارامتر منطق
    //    کسب‌وکار، پس جایشان همین‌جاست نه در امضای ۷۰ متد سرویس —
    //    وگرنه هر متد تازه‌ای هم می‌توانست فراموششان کند.
    //

    // ── کلید API: راه ورود ماشین ────────────────────────────────────
    //
    // افزونه ووکامرس نه کوکی دارد نه صفحه ورود. کلید یک نشست ساختگی
    // می‌سازد که از دید بقیه کد یک نشست کامل است — مجوزش از همان
    // `permission_rule` می‌آید و لاگ حسابرسی همان کاربر پشتی را
    // می‌نویسد.
    //
    // ⚠️ **دفاع CSRF روی این مسیر لازم نیست و مضر است.** CSRF یک حمله
    //    مبتنی بر کوکی است: مرورگر قربانی کوکی را خودکار می‌فرستد.
    //    هدر `Authorization` را هیچ مرورگری خودکار نمی‌فرستد، پس
    //    توکن Double-Submit اینجا فقط سایت را از کار می‌انداخت.
    const apiKey = apiKeyFrom(req.headers.authorization);
    if (apiKey) {
      const client = await resolveApiKey(deps.db, apiKey);
      if (!client) {
        return reply.code(401).send({
          error: {
            code: "bad_api_key",
            message: "کلید API نامعتبر یا باطل است",
            correlationId: req.id,
          },
        });
      }
      req.session = client;
      return;
    }

    const token = req.cookies[config.COOKIE_NAME];
    if (token) req.session = await auth.resolve(token);

    // حالا که نشست حل شده، شناسهٔ دستگاه روی **همان** شیء زمینه نوشته
    // می‌شود. `device` پیش از این لحظه معلوم نیست.
    // ⚠️ شناسهٔ **دستگاه** است، نه Fingerprint خام: Fingerprint یک ادعای
    //    کلاینت است و `identity.device.id` یک رکورد تأییدشدنی.
    if (req.session?.device?.id) currentRequestContext().device = req.session.device.id;

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
        req.log.warn({ correlationId: req.id, path: req.routeOptions.url ?? "[unmatched]" }, "توکن CSRF نامعتبر");
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
  const invoices = new InvoiceService(deps.db);

  registerAuthRoutes(app, {
    ...deps,
    devices: new DeviceService(deps.db),
    twoFactor: new TwoFactorService(deps.db),
    webauthn: new WebauthnService(deps.db),
  });
  registerSalesRoutes(app, { db: deps.db, invoices, shifts });
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
  registerProductRoutes(app, {
    db: deps.db,
    products: new ProductService(deps.db),
  });
  registerTreasuryRoutes(app, {
    db: deps.db,
    treasury: new TreasuryService(deps.db),
    cheques: new ChequeService(deps.db),
    shifts,
  });
  registerReportRoutes(app, {
    db: deps.db,
    reports: new ReportService(deps.db),
  });
  registerHealthRoutes(app, { db: deps.db });
  registerTransferRoutes(app, {
    db: deps.db,
    transfers: new TransferService(deps.db),
  });
  registerPeopleRoutes(app, {
    db: deps.db,
    users: new UserService(deps.db),
    customers: new CustomerService(deps.db),
  });
  registerPurchasingRoutes(app, {
    db: deps.db,
    receipts: new ReceiptService(deps.db),
    counts: new StockCountService(deps.db),
    returns: new PurchaseReturnService(deps.db),
    orders: new PurchaseOrderService(deps.db),
  });
  registerSettingsRoutes(app, {
    db: deps.db,
    settings: new SettingService(deps.db),
  });
  registerWebRoutes(app, {
    db: deps.db,
    webOrders: new WebOrderService(invoices),
    invoices,
  });
  registerPublicRoutes(app, { db: deps.db });
  registerScopeRoutes(app, { db: deps.db });
  registerAdminRoutes(app, { db: deps.db });
  return app;
}
