/**
 * هیچ رازی از هیچ پاسخی بیرون نمی‌رود — روی **کل** سطح API.
 *
 * ── چرا این تست وجود دارد ──────────────────────────────────────────
 *
 * CLAUDE.md می‌گوید «راز از هیچ پاسخی بیرون نمی‌رود — و این با
 * «حذفش می‌کنیم» تضمین نمی‌شود». تا امروز آن ادعا مسیر‌به‌مسیر سنجیده
 * می‌شد: پرسنل، دستگاه‌ها، کلیدهای امنیتی، هرکدام تست خودش.
 *
 * مشکل این است که **مسیر بعدی تست ندارد**. کسی که فردا یک
 * `GET /something` تازه اضافه کند و سهواً `password_hash` را
 * `select` کند، هیچ تستی را قرمز نمی‌کند.
 *
 * پس این تست از فهرست مسیرهای **خودِ Fastify** می‌خواند، هر `GET`
 * را می‌زند، و پاسخ را دنبال کلیدهای ممنوع می‌گردد. مسیر تازه
 * خودبه‌خود پوشش می‌گیرد.
 *
 * ⚠️ ادعا روی **کلید** است، نه روی مقدار: مقدار می‌تواند تصادفاً شبیه
 *    هر چیزی باشد، ولی کلیدی به نام `passwordHash` معنایش روشن است.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";
import { AuthService } from "../src/auth/service.ts";
import { hashSecret } from "../src/auth/password.ts";
import { buildApp } from "../src/http/app.ts";
import { loadConfig } from "../src/lib/config.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : "DATABASE_URL تنظیم نشده — تست یکپارچه رد شد";

const BRANCH = "00000000-0000-7000-8000-000000000001";

/**
 * کلیدهایی که هرگز نباید در بدنه پاسخ بیایند.
 *
 * هر دو شکل `snake_case` و `camelCase` — چون لایه API گاهی نگاشت
 * می‌کند و گاهی سطر خام را می‌دهد.
 */
const FORBIDDEN = [
  "password_hash", "passwordHash",
  "pin_hash", "pinHash",
  "totp_secret", "totpSecret",
  "secret_hash", "secretHash",
  "key_hash", "keyHash",
  "token_hash", "tokenHash",
  "recovery_hash", "recoveryHash",
  "public_key", "publicKey",
  "prev_hash", "prevHash",
];

/** هر کلید در یک ساختار تودرتو. */
function keysOf(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) keysOf(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  }
  return out;
}

describe("هیچ رازی بیرون نمی‌رود", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let app: FastifyInstance;

  const suffix = `k${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-ممیزی-راز-و-به‌قدر-کافی-بلند";
  const admin = `leak_admin_${suffix}`;
  let cookies: Record<string, string> = {};
  let headers: Record<string, string> = {};

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);

    const u = await handle.db
      .insertInto("identity.app_user")
      .values({
        username: admin,
        full_name: "مدیر ممیزی",
        password_hash: await hashSecret(PASSWORD),
        pin_hash: null,
        mobile: null,
        totp_secret: null,
        is_active: true,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await handle.db
      .insertInto("identity.user_role")
      .values({ user_id: u.id, role_code: "admin", branch_id: BRANCH })
      .execute();

    app = await buildApp({
      db: handle.db,
      auth: new AuthService(handle.db),
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" }),
    });
    await app.ready();

    const r = await app.inject({
      method: "POST",
      url: "/auth/login",
      remoteAddress: "10.13.0.9",
      payload: { username: admin, password: PASSWORD, deviceFingerprint: `fp-${suffix}` },
    });
    assert.equal(r.statusCode, 200, r.body);
    const csrf = r.cookies.find((c) => c.name === "labelmod_csrf")?.value ?? "";
    cookies = {
      labelmod_session: r.cookies.find((c) => c.name === "labelmod_session")?.value ?? "",
      labelmod_csrf: csrf,
    };
    headers = { "x-csrf-token": csrf };

    // یک راز واقعی در دیتابیس بنشانیم — تا اگر مسیری آن را بدهد،
    // ادعا واقعاً چیزی برای گرفتن داشته باشد.
    await sql`
      UPDATE identity.app_user
         SET pin_hash = 'HASH-PIN-NABAYAD-BIRUN-BERAVAD',
             totp_secret = 'SECRET-NABAYAD-BIRUN-BERAVAD'
       WHERE id = ${u.id}::uuid
    `.execute(handle.db);
  });

  after(async () => {
    await app?.close();
    await handle?.close();
    disposable?.drop();
  });

  test("هیچ مسیر GET کلید راز برنمی‌گرداند", async () => {
    // فهرست از **خودِ Fastify** می‌آید، نه از یک آرایه دستی — پس
    // مسیر تازه‌ای که فردا اضافه شود خودبه‌خود پوشش می‌گیرد.
    //
    // ⚠️ خروجی `printRoutes` یک **درخت** است، نه فهرست: هر سطر فقط
    //    قطعه خودش را دارد و مسیر کامل از به‌هم‌چسباندن نیاکانش
    //    ساخته می‌شود. خواندن سطر‌به‌سطر، `/begin` می‌داد نه
    //    `/auth/2fa/totp/begin`.
    const paths = new Set<string>();
    const stack: string[] = [];

    for (const raw of app.printRoutes({ commonPrefix: false }).split("\n")) {
      const marker = raw.indexOf("── ");
      if (marker < 0) continue;
      const depth = Math.floor(marker / 4);
      const rest = raw.slice(marker + 3);

      const m = /^(?<seg>\S*)\s*\((?<verbs>[^)]*)\)/.exec(rest);
      const seg = m?.groups?.["seg"] ?? rest.trim();
      stack[depth] = seg;
      stack.length = depth + 1;

      const verbs = m?.groups?.["verbs"];
      if (verbs === undefined || !verbs.includes("GET")) continue;

      const full = stack.join("");
      // مسیرهای پارامتری را نمی‌شود بی‌شناسه صدا زد؛ آن‌ها تست خودشان
      // را دارند. اینجا مسیرهای بی‌پارامتر سنجیده می‌شوند.
      if (full.includes(":") || full.includes("*")) continue;
      paths.add(full.startsWith("/") ? full : `/${full}`);
    }

    assert.ok(paths.size >= 10, `مسیر GET پیدا نشد (${paths.size})`);

    const leaks: string[] = [];
    let checked = 0;
    for (const url of paths) {
      const r = await app.inject({ method: "GET", url, cookies, headers });
      // ۴۰۰/۴۲۲ یعنی پارامتر لازم دارد — بدنه‌اش هم سنجیده می‌شود،
      // چون پیام خطا هم یک پاسخ است.
      let body: unknown;
      try {
        body = JSON.parse(r.body);
      } catch {
        continue; // پاسخ غیر-JSON (مثلاً CSV یا HTML)
      }
      checked += 1;
      const keys = keysOf(body);
      for (const bad of FORBIDDEN) {
        if (keys.has(bad)) leaks.push(`${url} → ${bad}`);
      }
      // و مقدارِ رازی که کاشتیم، هرگز نباید در متن پاسخ باشد.
      if (r.body.includes("NABAYAD-BIRUN-BERAVAD")) {
        leaks.push(`${url} → مقدار راز در بدنه`);
      }
    }

    // عدد در پیام می‌آید تا اگر روزی سطح API کوچک شد، دیده شود.
    assert.ok(checked >= 10, `فقط ${checked} مسیر سنجیده شد`);
    console.log(`      (${paths.size} مسیر GET بی‌پارامتر، ${checked} پاسخ JSON سنجیده شد)`);
    assert.deepEqual(leaks, [], `نشت راز:\n  ${leaks.join("\n  ")}`);
  });

  test("ادعا واقعاً چیزی می‌گیرد — با یک نشت ساختگی", async () => {
    // ⚠️ ادعایی که هرگز قرمز نشود، چیزی را اثبات نمی‌کند. اینجا یک
    //    مسیر عمداً نشتی ساخته می‌شود تا معلوم شود آشکارساز کار
    //    می‌کند — همان الگویی که برای هر باگ این مخزن به کار رفت.
    const leaky = { user: { id: "x", passwordHash: "abc" } };
    const keys = keysOf(leaky);
    assert.ok(keys.has("passwordHash"), "آشکارساز باید کلید تودرتو را ببیند");

    const deep = { rows: [{ a: [{ b: { totp_secret: "s" } }] }] };
    assert.ok(keysOf(deep).has("totp_secret"), "آشکارساز باید در آرایه هم ببیند");
  });
});
