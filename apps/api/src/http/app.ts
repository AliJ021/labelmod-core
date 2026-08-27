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

declare module "fastify" {
  interface FastifyRequest {
    session: Awaited<ReturnType<AuthService["resolve"]>>;
  }
}

/** مسیرهایی که پیش از ورود هم باید کار کنند. */
const PUBLIC_PATHS = new Set(["/health", "/auth/login", "/auth/logout", "/auth/unlock"]);

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

    const path = req.routeOptions.url ?? req.url.split("?")[0] ?? "";
    if (PUBLIC_PATHS.has(path)) return;
    if (!req.session) {
      return reply.code(401).send({
        error: { code: "no_session", message: "وارد نشده‌اید", correlationId: req.id },
      });
    }
  });

  app.get("/health", async () => ({ ok: true }));

  registerAuthRoutes(app, deps);
  return app;
}
