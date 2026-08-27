/**
 * مسیرهای احراز هویت.
 *
 * هر ورودی از Zod می‌گذرد (قاعده لایه API). هیچ Endpoint‌ای بدون Schema.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AuthError, type AuthService } from "../auth/service.ts";
import { can } from "../auth/permission.ts";
import { csrfCookieOptions, deviceCookieOptions, sessionCookieOptions } from "../auth/token.ts";
import type { Db } from "../db/client.ts";
import type { Config } from "../lib/config.ts";

const loginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
  deviceFingerprint: z.string().min(8).max(128).optional(),
});

const pinBody = z.object({
  pin: z.string().regex(/^\d{4,8}$/, "PIN باید فقط رقم باشد"),
  deviceFingerprint: z.string().min(8).max(128),
});

const reauthBody = z.object({
  password: z.string().min(1).max(256),
});

const permissionQuery = z.object({
  operation: z.string().min(1).max(64),
  // پول در JSON رشته است، نه عدد — همان قاعده سراسری.
  amount: z.string().regex(/^-?\d+$/).optional(),
  percent: z.coerce.number().min(0).max(100).optional(),
});

export interface AuthRouteDeps {
  auth: AuthService;
  db: Db;
  config: Config;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { auth, db, config } = deps;

  app.post("/auth/login", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    handler: async (req, reply) => {
      const input = loginBody.parse(req.body);
      const session = await auth.login({
        ...input,
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });

      const maxAge = Math.max(
        1,
        Math.floor((session.expiresAt.getTime() - Date.now()) / 1000),
      );
      reply.setCookie(
        config.COOKIE_NAME,
        session.token,
        sessionCookieOptions({
          secure: config.isProduction,
          maxAgeSeconds: maxAge,
          domain: config.COOKIE_DOMAIN,
        }),
      );

      // توکن Double-Submit — خواندنی، تا کد صفحه بتواند در سرآیند
      // x-csrf-token برش گرداند.
      reply.setCookie(
        config.CSRF_COOKIE_NAME,
        session.csrfToken,
        csrfCookieOptions({
          secure: config.isProduction,
          maxAgeSeconds: maxAge,
          domain: config.COOKIE_DOMAIN,
        }),
      );

      // راز ثبت‌نام دستگاه — فقط در همان پاسخی که ثبت‌نام رخ داده.
      // HttpOnly است و در بدنه برنمی‌گردد.
      if (session.device?.issuedSecret) {
        reply.setCookie(
          config.DEVICE_COOKIE_NAME,
          session.device.issuedSecret,
          deviceCookieOptions({
            secure: config.isProduction,
            domain: config.COOKIE_DOMAIN,
          }),
        );
      }

      // توکن نشست و راز دستگاه در بدنه برنمی‌گردند. کوکی‌هایشان
      // HttpOnly است تا اسکریپت صفحه — خودی یا تزریق‌شده — نتواند
      // بخواندشان.
      return {
        user: { id: session.userId, fullName: session.fullName, roles: session.roles },
        expiresAt: session.expiresAt.toISOString(),
        // صندوق با همین تصمیم می‌گیرد گزینه «قفل صفحه با PIN» را نشان
        // بدهد یا نه. «تأییدشده» کافی نیست — تا دستگاه راز ثبت‌نام
        // نگرفته باشد، PIN کار نمی‌کند.
        device: session.device
          ? {
              registered: true,
              approved: session.device.approved,
              enrolled: session.device.enrolled,
              pinAvailable: session.device.approved && session.device.enrolled,
            }
          : null,
      };
    },
  });

  app.post("/auth/logout", async (req, reply) => {
    const token = req.cookies[config.COOKIE_NAME];
    if (token) await auth.logout(token);
    reply.clearCookie(config.COOKIE_NAME, { path: "/" });
    reply.clearCookie(config.CSRF_COOKIE_NAME, { path: "/" });
    // کوکی دستگاه عمداً پاک **نمی‌شود**: خروج کاربر یعنی پایان نشست،
    // نه پایان اعتماد به دستگاه. تبلت صندوق بین شیفت‌ها همان تبلت
    // می‌ماند. ابطال اعتماد دستگاه کار مدیر است (identity.revoke_device).
    return { ok: true };
  });

  /** قفل صفحه — نشست زنده می‌ماند، ولی تا PIN کاری نمی‌کند. */
  app.post("/auth/lock", async (req) => {
    const token = req.cookies[config.COOKIE_NAME];
    if (!token) throw new AuthError("no_session", "نشستی وجود ندارد");
    return { locked: await auth.lock(token) };
  });

  app.post("/auth/unlock", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    handler: async (req) => {
      const token = req.cookies[config.COOKIE_NAME];
      if (!token) throw new AuthError("no_session", "نشستی وجود ندارد");
      const input = pinBody.parse(req.body);
      await auth.unlockWithPin(
        token,
        input.pin,
        input.deviceFingerprint,
        req.cookies[config.DEVICE_COOKIE_NAME],
      );
      // نشست باز شد ولی **ارتقایافته نیست**: عملیات فهرست
      // auth.pin_forbidden_operations تا احراز کامل مجدد بسته می‌مانند.
      return { ok: true, elevated: false };
    },
  });

  /**
   * احراز هویت کامل مجدد — تنها راه درآوردن نشست از حالت PIN.
   *
   * بند ۱ SECURITY.md: «بازپرداخت، ابطال فاکتور، تغییر قیمت و اصلاح
   * موجودی نیازمند احراز هویت کامل مجدد است — نه PIN».
   */
  app.post("/auth/reauth", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    handler: async (req) => {
      const token = req.cookies[config.COOKIE_NAME];
      if (!token) throw new AuthError("no_session", "نشستی وجود ندارد");
      const input = reauthBody.parse(req.body);
      await auth.reauthenticate(token, input.password);
      return { ok: true, elevated: true };
    },
  });

  app.get("/auth/me", async (req) => {
    const session = req.session;
    if (!session) throw new AuthError("no_session", "وارد نشده‌اید");
    return {
      id: session.userId,
      fullName: session.fullName,
      roles: session.roles,
      expiresAt: session.expiresAt.toISOString(),
      // صندوق باید بداند نشست ارتقایافته است یا نه، تا دکمه‌ای را
      // نشان ندهد که سرور بعداً ردش می‌کند.
      elevated: !session.pinUnlocked,
      device: session.device
        ? { approved: session.device.approved, enrolled: session.device.enrolled }
        : null,
    };
  });

  /**
   * «آیا می‌توانم؟» — تا UI دکمه‌ای را نشان ندهد که سرور بعداً ردش کند.
   *
   * ⚠️ این Endpoint یک راحتی است، نه یک دروازه. هر عملیات حساس در
   *    لحظه اجرا دوباره مجوز می‌گیرد. UI که فقط به این تکیه کند، با یک
   *    درخواست مستقیم دور زده می‌شود.
   */
  app.get("/auth/can", async (req) => {
    const session = req.session;
    if (!session) throw new AuthError("no_session", "وارد نشده‌اید");
    const q = permissionQuery.parse(req.query);
    return can(db, {
      userId: session.userId,
      operation: q.operation,
      amount: q.amount === undefined ? undefined : BigInt(q.amount),
      percent: q.percent,
      // از **نشست** خوانده می‌شود، نه یک ثابت.
      //
      // نسخه اول اینجا false ثابت داشت و شرط چهارم دفاع PIN را در عمل
      // مرده می‌کرد: identity.can پارامترش را داشت، تست هم داشت، ولی
      // هیچ مسیر واقعی‌ای true نمی‌فرستاد.
      viaPin: session.pinUnlocked,
    });
  });

  /** «گوشی‌ام گم شد» — همه نشست‌های خودِ کاربر. */
  app.post("/auth/revoke-all", async (req) => {
    const session = req.session;
    if (!session) throw new AuthError("no_session", "وارد نشده‌اید");
    const count = await auth.revokeAll(session.userId, "user_requested", session.userId);
    return { revoked: count };
  });
}
