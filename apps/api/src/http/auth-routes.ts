/**
 * مسیرهای احراز هویت.
 *
 * هر ورودی از Zod می‌گذرد (قاعده لایه API). هیچ Endpoint‌ای بدون Schema.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AuthError, type AuthService } from "../auth/service.ts";
import { can } from "../auth/permission.ts";
import { sessionCookieOptions } from "../auth/token.ts";
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

      // توکن در بدنه برنمی‌گردد. کوکی HttpOnly است تا اسکریپت صفحه —
      // خودی یا تزریق‌شده — نتواند بخواندش.
      return {
        user: { id: session.userId, fullName: session.fullName, roles: session.roles },
        expiresAt: session.expiresAt.toISOString(),
        // صندوق با همین تصمیم می‌گیرد گزینه «قفل صفحه با PIN» را نشان
        // بدهد یا نه. تا مدیر دستگاه را تأیید نکرده، PIN کار نمی‌کند.
        device: session.device
          ? { registered: true, approved: session.device.approved }
          : null,
      };
    },
  });

  app.post("/auth/logout", async (req, reply) => {
    const token = req.cookies[config.COOKIE_NAME];
    if (token) await auth.logout(token);
    reply.clearCookie(config.COOKIE_NAME, { path: "/" });
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
      await auth.unlockWithPin(token, input.pin, input.deviceFingerprint);
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
      viaPin: false,
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
