/**
 * مسیرهای احراز هویت.
 *
 * هر ورودی از Zod می‌گذرد (قاعده لایه API). هیچ Endpoint‌ای بدون Schema.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthError, type AuthService } from "../auth/service.ts";
import { can, requireForSession } from "../auth/permission.ts";
import type { DeviceService } from "../auth/devices.ts";
import type { TwoFactorService } from "../auth/two-factor.ts";
import type { WebauthnService } from "../auth/webauthn.ts";
import { csrfCookieOptions, deviceCookieOptions, sessionCookieOptions } from "../auth/token.ts";
import type { Db } from "../db/client.ts";
import type { Config } from "../lib/config.ts";

/**
 * کوکی بلیت مرحله دوم.
 *
 * نامش عمداً از `COOKIE_NAME` جداست و پیکربندی‌پذیر نیست: یک چیز
 * موقت و داخلی است، نه یک تصمیم استقرار. اگر با کوکی نشست یکی بود،
 * یک بلیت نیمه‌ساخته جای یک نشست کامل می‌نشست.
 */
const PENDING_COOKIE = "labelmod_pending";

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

const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(256),
  password: z.string().min(12, "رمز تازه باید حداقل ۱۲ کاراکتر باشد").max(256),
}).strict().refine((value) => value.currentPassword !== value.password, {
  message: "رمز تازه باید با رمز فعلی متفاوت باشد",
  path: ["password"],
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
  devices: DeviceService;
  twoFactor: TwoFactorService;
  webauthn: WebauthnService;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { auth, db, config, devices, twoFactor, webauthn } = deps;

  app.post("/auth/login", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    handler: async (req, reply) => {
      const input = loginBody.parse(req.body);
      const outcome = await auth.login({
        ...input,
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });

      // ── عامل دوم: هیچ کوکی نشستی ساخته نمی‌شود ──────────────────
      //
      // بلیت مرحله دوم در کوکی **HttpOnly** می‌نشیند، نه در بدنه:
      // اسکریپت صفحه — خودی یا تزریق‌شده — نباید بتواند بخواندش.
      // عمرش کوتاه است و تنها کارش رساندن کاربر به مرحله دوم.
      if (outcome.kind === "second_factor") {
        reply.setCookie(
          PENDING_COOKIE,
          outcome.pendingToken,
          sessionCookieOptions({
            secure: config.isProduction,
            maxAgeSeconds: Math.max(
              1,
              Math.floor((outcome.expiresAt.getTime() - Date.now()) / 1000),
            ),
            domain: config.COOKIE_DOMAIN,
          }),
        );
        return reply.code(200).send({
          needsSecondFactor: true,
          fullName: outcome.fullName,
          methods: outcome.methods,
          expiresAt: outcome.expiresAt.toISOString(),
        });
      }

      const session = outcome.session;
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

  // ── مرحله دوم ورود ────────────────────────────────────────────
  //
  // بلیت از کوکی خوانده می‌شود، نه از بدنه: HttpOnly است تا اسکریپت
  // صفحه نتواند بخواندش، و همان‌طور که آمده خودکار برمی‌گردد.
  //
  // ⚠️ محدودیت نرخ اینجا **لازم است و از ورود جداست**: کد شش‌رقمی
  //    یک میلیون حالت دارد و بدون سقف، حدس‌زدنش با یک اسکریپت کار
  //    چند دقیقه است. پنجره ±۱ گام هم فضای حدس را سه برابر می‌کند.
  const secondFactorHandler = async (
    req: FastifyRequest,
    reply: FastifyReply,
    verify: (userId: string, code: string) => Promise<boolean>,
    method: "totp" | "otp" | "webauthn",
  ) => {
    const pendingToken = (req.cookies as Record<string, string | undefined>)[PENDING_COOKIE];
    if (!pendingToken) {
      throw new AuthError("pending_expired", "مهلت این ورود تمام شده. دوباره وارد شوید.");
    }
    const body = z.object({ code: z.string().trim().min(4).max(64) }).parse(req.body);

    const pending = await auth.pendingUser(pendingToken);
    if (!pending) {
      throw new AuthError("pending_expired", "مهلت این ورود تمام شده. دوباره وارد شوید.");
    }

    if (!(await verify(pending.userId, body.code))) {
      // بلیت **مصرف نمی‌شود**: کد را می‌شود اشتباه تایپ کرد و
      // فرستادن کاربر به اول مسیر برای یک غلط تایپی، فقط آزار است.
      // دفاع واقعی محدودیت نرخ همین Endpoint است.
      throw new AuthError("bad_code", "کد وارد‌شده درست نیست.");
    }

    const session = await auth.completeSecondFactor({
      pendingToken,
      method,
      deviceFingerprint: (req.body as { deviceFingerprint?: string }).deviceFingerprint,
      ip: req.ip,
      userAgent: req.headers["user-agent"] as string | undefined,
    });

    reply.clearCookie(PENDING_COOKIE, { path: "/" });
    const maxAge = Math.max(1, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000));
    reply.setCookie(
      config.COOKIE_NAME,
      session.token,
      sessionCookieOptions({
        secure: config.isProduction,
        maxAgeSeconds: maxAge,
        domain: config.COOKIE_DOMAIN,
      }),
    );
    reply.setCookie(
      config.CSRF_COOKIE_NAME,
      session.csrfToken,
      csrfCookieOptions({
        secure: config.isProduction,
        maxAgeSeconds: maxAge,
        domain: config.COOKIE_DOMAIN,
      }),
    );
    if (session.device?.issuedSecret) {
      reply.setCookie(
        config.DEVICE_COOKIE_NAME,
        session.device.issuedSecret,
        deviceCookieOptions({ secure: config.isProduction, domain: config.COOKIE_DOMAIN }),
      );
    }

    return {
      user: { id: session.userId, fullName: session.fullName, roles: session.roles },
      expiresAt: session.expiresAt.toISOString(),
      device: session.device
        ? {
            registered: true,
            approved: session.device.approved,
            enrolled: session.device.enrolled,
            pinAvailable: session.device.approved && session.device.enrolled,
          }
        : null,
    };
  };

  app.post("/auth/2fa/totp", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    handler: async (req, reply) =>
      secondFactorHandler(
        req,
        reply,
        (userId, code) => twoFactor.verifyTotpFor(userId, code),
        "totp",
      ),
  });

  /**
   * کد بازیابی — وقتی گوشی گم شده.
   *
   * سقفش از TOTP **سخت‌گیرانه‌تر** است: کد بازیابی عمر طولانی دارد و
   * برخلاف TOTP هر ۳۰ ثانیه عوض نمی‌شود.
   */
  app.post("/auth/2fa/recovery", {
    config: { rateLimit: { max: 3, timeWindow: "5 minutes" } },
    handler: async (req, reply) =>
      secondFactorHandler(
        req,
        reply,
        (userId, code) => twoFactor.consumeRecoveryCode(userId, code),
        "otp",
      ),
  });

  // ── راه‌اندازی عامل دوم — روی نشست باز ────────────────────────────
  //
  // ⚠️ همه این مسیرها روی **حساب خودِ کاربر** کار می‌کنند، نه روی
  //    کاربر دیگر. مدیر نمی‌تواند برای کسی TOTP راه بیندازد: راز باید
  //    فقط به گوشی همان آدم برسد. برداشتنش اما کار مدیر هم هست
  //    (`user.manage`) — کسی که گوشی‌اش را گم کرده باید راهی داشته
  //    باشد.

  app.get("/auth/2fa", async (req) => {
    const s = req.session;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    return await twoFactor.status(s.userId);
  });

  app.post("/auth/2fa/totp/begin", async (req) => {
    const s = req.session;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    // نشستی که با PIN باز شده نباید بتواند عامل دوم راه بیندازد.
    if (s.pinUnlocked) {
      throw new AuthError(
        "pin_not_allowed",
        "برای راه‌اندازی کد دومرحله‌ای، با رمز کامل وارد شوید.",
      );
    }
    const u = await db
      .selectFrom("identity.app_user")
      .select("username")
      .where("id", "=", s.userId)
      .executeTakeFirstOrThrow();
    return await twoFactor.beginTotp({
      userId: s.userId,
      username: u.username,
      issuer: "Label Mod",
    });
  });

  app.post("/auth/2fa/totp/confirm", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    handler: async (req) => {
      const s = req.session;
      if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
      const body = z.object({ code: z.string().trim().min(4).max(10) }).parse(req.body);
      const codes = await twoFactor.confirmTotp(s.userId, body.code);
      return {
        enabled: true,
        recoveryCodes: codes,
        note: "این کدها فقط همین یک بار نشان داده می‌شوند. جایی امن نگهشان دارید.",
      };
    },
  });

  app.post("/auth/2fa/recovery/regenerate", async (req) => {
    const s = req.session;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    if (s.pinUnlocked) {
      throw new AuthError("pin_not_allowed", "با رمز کامل وارد شوید.");
    }
    return {
      recoveryCodes: await twoFactor.regenerateRecoveryCodes(s.userId),
      note: "کدهای قبلی از همین لحظه بی‌اعتبارند.",
    };
  });

  // ── WebAuthn / Passkey ──────────────────────────────────────────
  //
  // ⚠️ **EXTERNAL VERIFICATION REQUIRED.** مراسم واقعی به یک دامنه
  //    واقعی و یک Authenticator واقعی نیاز دارد. آنچه در این مخزن
  //    سنجیده می‌شود: چرخه چالش، یک‌بارمصرف بودنش، رد شمارنده نزولی،
  //    دامنه و مجوز. خودِ مراسم باید یک بار با کلید واقعی آزموده شود.

  app.get("/auth/2fa/webauthn", async (req) => {
    const s = req.session;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    return { credentials: await webauthn.list(s.userId) };
  });

  app.post("/auth/2fa/webauthn/register/begin", async (req) => {
    const s = req.session;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    if (s.pinUnlocked) {
      throw new AuthError("pin_not_allowed", "برای ثبت کلید، با رمز کامل وارد شوید.");
    }
    const u = await db
      .selectFrom("identity.app_user")
      .select(["username", "full_name"])
      .where("id", "=", s.userId)
      .executeTakeFirstOrThrow();
    return await webauthn.beginRegistration({
      userId: s.userId,
      username: u.username,
      fullName: u.full_name,
    });
  });

  app.post("/auth/2fa/webauthn/register/finish", async (req) => {
    const s = req.session;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    if (s.pinUnlocked) {
      throw new AuthError("pin_not_allowed", "برای ثبت کلید، با رمز کامل وارد شوید.");
    }
    const body = z
      .object({
        // شکل پاسخ را کتابخانه می‌سنجد؛ Zod اینجا فقط «شیء است» را
        // تضمین می‌کند. سنجش دوباره‌اش یعنی دو تعریف از یک قاعده.
        response: z.record(z.string(), z.unknown()),
        name: z.string().trim().max(60).optional(),
      })
      .parse(req.body);
    return await webauthn.finishRegistration({
      userId: s.userId,
      response: body.response,
      ...(body.name === undefined ? {} : { name: body.name }),
    });
  });

  app.delete("/auth/2fa/webauthn/:id", async (req) => {
    const s = req.session;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    if (s.pinUnlocked) {
      throw new AuthError("pin_not_allowed", "برای حذف کلید، با رمز کامل وارد شوید.");
    }
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await webauthn.remove(s.userId, id, s.userId);
    return { ok: true };
  });

  /** مرحله دوم ورود با کلید — بلیت از کوکی، مثل TOTP. */
  app.post("/auth/2fa/webauthn/begin", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    handler: async (req) => {
      const pendingToken = (req.cookies as Record<string, string | undefined>)[
        PENDING_COOKIE
      ];
      if (!pendingToken) {
        throw new AuthError("pending_expired", "مهلت این ورود تمام شده. دوباره وارد شوید.");
      }
      const pending = await auth.pendingUser(pendingToken);
      if (!pending) {
        throw new AuthError("pending_expired", "مهلت این ورود تمام شده. دوباره وارد شوید.");
      }
      return await webauthn.beginAuthentication(pending.userId);
    },
  });

  app.post("/auth/2fa/webauthn/verify", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    handler: async (req, reply) => {
      const body = z
        .object({ response: z.record(z.string(), z.unknown()) })
        .parse(req.body);
      return secondFactorHandler(
        req,
        reply,
        (userId) => webauthn.finishAuthentication({ userId, response: body.response }),
        "webauthn",
      );
    },
  });

  /** برداشتن عامل دوم — حساب خودِ کاربر، با رمز کامل. */
  app.delete("/auth/2fa", async (req) => {
    const s = req.session;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    if (s.pinUnlocked) {
      throw new AuthError(
        "pin_not_allowed",
        "برای برداشتن کد دومرحله‌ای، با رمز کامل وارد شوید.",
      );
    }
    await twoFactor.disableTotp(s.userId, s.userId);
    return { ok: true };
  });

  /**
   * برداشتن عامل دوم **کاربر دیگر** — گوشی گم شده و کد بازیابی هم نیست.
   *
   * پشت `user.manage` است و ردّ حسابرسی‌اش کاربر عامل را می‌نویسد.
   * بدون این مسیر، تنها راه `psql` روی سرور بود.
   */
  app.delete("/users/:id/2fa", async (req) => {
    const s = req.session;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await requireForSession(db, s, "user.manage");
    await twoFactor.disableTotp(id, s.userId);
    return { ok: true };
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

  /** تغییر رمز شخصی؛ شناسهٔ کاربر فقط از نشست معتبر می‌آید. */
  app.post("/auth/change-password", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    handler: async (req, reply) => {
      const token = req.cookies[config.COOKIE_NAME];
      if (!token || !req.session) throw new AuthError("no_session", "وارد نشده‌اید");
      const input = changePasswordBody.parse(req.body);
      await auth.changePassword(token, input.currentPassword, input.password);
      const cookieScope = { path: "/", ...(config.COOKIE_DOMAIN ? { domain: config.COOKIE_DOMAIN } : {}) };
      reply.clearCookie(config.COOKIE_NAME, cookieScope);
      reply.clearCookie(config.CSRF_COOKIE_NAME, cookieScope);
      return { ok: true };
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

  // ── مدیریت دستگاه ──────────────────────────────────────────────────
  //
  // ⚠️ همه این مسیرها `device.manage` می‌خواهند، که در Seed فقط مدیر
  //    دارد و در `auth.pin_forbidden_operations` هم هست: نشستی که با
  //    PIN باز شده نمی‌تواند دستگاه تأیید کند. بدون این، کسی که PIN
  //    را دارد می‌توانست دستگاه خودش را «مورد اعتماد» کند و کل دفاع
  //    لایه‌ای ADR-005 فرو می‌ریخت.

  const uuid = z.string().uuid("شناسه نامعتبر");

  const requireSession = (req: { session: unknown }) => {
    const s = req.session as
      | { userId: string; pinUnlocked: boolean }
      | null;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    return s;
  };

  app.get("/devices", async (req) => {
    const s = requireSession(req);
    await requireForSession(db, s, "device.manage");
    const q = z
      .object({ pending: z.enum(["true", "false"]).optional() })
      .parse(req.query ?? {});
    return {
      devices: await devices.list(
        q.pending === "true" ? { pending: true } : {},
      ),
    };
  });

  /**
   * تأیید دستگاه — گام «تأیید مدیر» در زنجیره ADR-005.
   *
   * `POST` است و `Idempotency-Key` نمی‌خواهد: تأیید یک عملیات **مطلق**
   * است. دستگاهی که از قبل تأیید شده، دوباره تأیید شود همان وضعیت را
   * می‌گیرد — با یک تفاوت مهم که در `DeviceService.approve` نوشته
   * شده: ثبت‌نام قبلی پاک می‌شود و دستگاه باید یک ورود کامل تازه بکند.
   */
  app.post("/devices/:id/approve", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, async (req) => {
    const s = requireSession(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        label: z.string().trim().min(1).max(60).optional(),
        branchId: uuid.optional(),
      })
      .parse(req.body ?? {});
    await requireForSession(db, s, "device.manage");

    await devices.approve(id, s.userId, body.label, body.branchId);
    return { ok: true };
  });

  /** ابطال دستگاه — «تبلت گم شد». نشست‌های زنده‌اش هم بسته می‌شوند. */
  app.post("/devices/:id/revoke", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, async (req) => {
    const s = requireSession(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({ reason: z.string().trim().min(1).max(120).optional() })
      .parse(req.body ?? {});
    await requireForSession(db, s, "device.manage");

    const out = await devices.revoke(id, s.userId, body.reason ?? "device_revoked");
    return out;
  });

  // ── نشست‌های زنده ──────────────────────────────────────────────────

  app.get("/sessions", async (req) => {
    const s = requireSession(req);
    await requireForSession(db, s, "device.manage");
    const q = z.object({ userId: uuid.optional() }).parse(req.query ?? {});
    return { sessions: await devices.sessions(q) };
  });

  /**
   * «گوشیِ فلانی گم شد» — همه نشست‌های یک کاربرِ دیگر.
   *
   * این همان الزام بند ۱ SECURITY.md است که دلیل انتخاب توکن مات
   * به‌جای JWT بود: ابطال فوری، با یک `DELETE`. تا امروز تابعش بود و
   * مسیرش نه.
   */
  app.post("/users/:id/revoke-sessions", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, async (req) => {
    const s = requireSession(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({ reason: z.string().trim().min(1).max(120).optional() })
      .parse(req.body ?? {});
    // ابطال دسترسی یک کاربر، مدیریت کاربر است نه مدیریت دستگاه.
    await requireForSession(db, s, "user.manage");

    const revoked = await devices.revokeUserAccess(
      id,
      s.userId,
      body.reason ?? "admin_revoked",
    );
    return { revoked };
  });
}
