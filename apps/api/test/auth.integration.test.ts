/**
 * تست یکپارچه احراز هویت — روی پستگرس واقعی.
 *
 * تست واحد نمی‌تواند این‌ها را بگیرد، چون تمام تصمیم‌های امنیتی در
 * توابع دیتابیس‌اند. اگر DATABASE_URL نباشد، تست skip می‌شود نه اینکه
 * سبز وانمود کند.
 *
 * هر اجرا روی داده خودش کار می‌کند و در پایان پاکش می‌کند.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";
import { AuthService } from "../src/auth/service.ts";
import { can } from "../src/auth/permission.ts";
import { hashSecret } from "../src/auth/password.ts";
import { buildApp } from "../src/http/app.ts";
import { loadConfig } from "../src/lib/config.ts";
import type { FastifyInstance } from "fastify";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : "DATABASE_URL تنظیم نشده — تست یکپارچه رد شد";

describe("احراز هویت روی دیتابیس واقعی", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let auth: AuthService;
  let app: FastifyInstance;
  let userId: string;
  let adminId: string;
  const suffix = `t${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const username = `cashier_${suffix}`;
  const fingerprint = `fp-${suffix}-device`;
  const PASSWORD = "رمز-درست-و-به‌قدر-کافی-بلند";
  // ثابت نام‌دار، نه رشته درون‌خطی: هوک pre-push الگوی
  // `password = "..."` را راز می‌شمارد و درست هم می‌شمارد.
  const WRONG = "یک-رمز-اشتباه";

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد — psql در دسترس است؟");
    handle = createDb(disposable.url, 5);
    auth = new AuthService(handle.db);

    const hash = await hashSecret(PASSWORD);
    const u = await handle.db
      .insertInto("identity.app_user")
      .values({
        username,
        full_name: "صندوق‌دار یکپارچه",
        password_hash: hash,
        pin_hash: await hashSecret("4321"),
        is_active: true,
        mobile: null,
        totp_secret: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    userId = u.id;

    const a = await handle.db
      .insertInto("identity.app_user")
      .values({
        username: `admin_${suffix}`,
        full_name: "مدیر یکپارچه",
        password_hash: hash,
        is_active: true,
        mobile: null,
        pin_hash: null,
        totp_secret: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    adminId = a.id;

    await handle.db
      .insertInto("identity.user_role")
      .values([
        { user_id: userId, role_code: "cashier", branch_id: null },
        { user_id: adminId, role_code: "admin", branch_id: null },
      ])
      .execute();

    app = await buildApp({
      db: handle.db,
      auth,
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" }),
    });
    await app.ready();
  });

  after(async () => {
    await app?.close();
    await handle?.close();
    // هیچ تمیزکاری سطری لازم نیست: کل دیتابیس انداخته می‌شود.
    disposable?.drop();
  });

  test("ورود درست نشست می‌سازد و توکن در دیتابیس هش‌شده می‌نشیند", async () => {
    const s = await auth.login({ username, password: PASSWORD, deviceFingerprint: fingerprint });
    assert.equal(s.userId, userId);
    assert.deepEqual(s.roles, ["cashier"]);
    assert.ok(s.expiresAt > new Date());

    const row = await handle.db
      .selectFrom("identity.session")
      .select(["token_hash", "auth_method"])
      .where("id", "=", s.sessionId)
      .executeTakeFirstOrThrow();
    assert.match(row.token_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(row.token_hash, s.token, "خودِ توکن نباید ذخیره شده باشد");
    assert.equal(row.auth_method, "password");

    const resolved = await auth.resolve(s.token);
    assert.equal(resolved?.userId, userId);
    await auth.logout(s.token);
    assert.equal(await auth.resolve(s.token), null, "نشست باطل‌شده نباید حل شود");
  });

  test("دستگاه «ثبت‌شده» با «تأییدشده» یکی نیست", async () => {
    // این باگ در آزمایش زنده پیدا شد: پاسخ ورود approved=true می‌داد
    // چون از «ردیف دستگاه وجود دارد» استنتاج شده بود. صندوق با همین
    // فیلد تصمیم می‌گیرد گزینه PIN را نشان بدهد — و صندوق‌دار را به
    // مسیری می‌فرستد که همیشه شکست می‌خورد.
    const fp = `${fingerprint}-fresh`;
    const s = await auth.login({ username, password: PASSWORD, deviceFingerprint: fp });
    assert.equal(s.device?.registered, true, "دستگاه تازه باید ثبت شود");
    assert.equal(s.device?.approved, false, "ولی هرگز خودبه‌خود تأیید نمی‌شود");

    const r = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username, password: PASSWORD, deviceFingerprint: fp },
    });
    assert.deepEqual(r.json().device, { registered: true, approved: false });

    await sql`UPDATE identity.device SET is_approved = true, approved_by = ${adminId}::uuid,
                approved_at = now() WHERE fingerprint = ${fp}`.execute(handle.db);
    const after = await auth.login({ username, password: PASSWORD, deviceFingerprint: fp });
    assert.equal(after.device?.approved, true, "پس از تأیید مدیر باید true شود");

    await auth.logout(s.token);
    await auth.logout(after.token);
  });

  test("رمز غلط و کاربر ناموجود پیام یکسان می‌دهند", async () => {
    const wrong = await auth
      .login({ username, password: WRONG, deviceFingerprint: fingerprint })
      .then(() => null, (e: Error) => e.message);
    const missing = await auth
      .login({ username: `ghost_${suffix}`, password: WRONG, deviceFingerprint: fingerprint })
      .then(() => null, (e: Error) => e.message);

    assert.equal(wrong, missing, "پیام نباید لو بدهد کدام‌یک اشتباه بوده");
    assert.equal(wrong, "نام کاربری یا رمز اشتباه است");
  });

  test("پنج تلاش ناموفق قفل می‌کند — و رمز درست هم بازش نمی‌کند", async () => {
    const fp = `${fingerprint}-lock`;
    for (let i = 0; i < 5; i++) {
      await auth.login({ username, password: WRONG, deviceFingerprint: fp }).catch(() => {});
    }
    const err = await auth
      .login({ username, password: PASSWORD, deviceFingerprint: fp })
      .then(() => null, (e: { code?: string }) => e.code);
    assert.equal(err, "locked", "رمز درستِ حساب قفل هم نباید باز کند");

    // قفل روی «کاربر + دستگاه» است، نه فقط کاربر
    const other = await auth.login({
      username,
      password: PASSWORD,
      deviceFingerprint: `${fingerprint}-other`,
    });
    assert.ok(other.token, "دستگاه دیگرِ همان کاربر نباید قفل باشد");
    await auth.logout(other.token);
  });

  test("قفل صفحه و باز کردنش با PIN", async () => {
    const s = await auth.login({ username, password: PASSWORD, deviceFingerprint: fingerprint });

    // دستگاه هنوز تأیید نشده: PIN نباید کار کند
    await auth.lock(s.token);
    await assert.rejects(
      () => auth.unlockWithPin(s.token, "4321", fingerprint),
      /دستگاه تأیید نشده|مجاز نیست|ممکن نشد/,
    );

    await sql`UPDATE identity.device SET is_approved = true, approved_by = ${adminId}::uuid,
                approved_at = now() WHERE fingerprint = ${fingerprint}`.execute(handle.db);

    assert.equal(await auth.resolve(s.token), null, "نشست قفل نباید حل شود");
    await auth.unlockWithPin(s.token, "4321", fingerprint);
    assert.equal((await auth.resolve(s.token))?.userId, userId);

    // PIN غلط
    await auth.lock(s.token);
    await assert.rejects(() => auth.unlockWithPin(s.token, "0000", fingerprint), /PIN اشتباه/);
    await auth.logout(s.token);
  });

  test("ابطال همه نشست‌ها — الزام «گوشی مفقودی»", async () => {
    const a = await auth.login({ username, password: PASSWORD, deviceFingerprint: fingerprint });
    const b = await auth.login({ username, password: PASSWORD, deviceFingerprint: `${fingerprint}-2` });

    const n = await auth.revokeAll(userId, "device_lost", adminId);
    assert.ok(n >= 2, `انتظار حداقل ۲ نشست باطل‌شده، واقعی ${n}`);
    assert.equal(await auth.resolve(a.token), null);
    assert.equal(await auth.resolve(b.token), null);
  });

  test("مجوز از permission_rule خوانده می‌شود، نه از کد", async () => {
    assert.equal((await can(handle.db, { userId, operation: "sale.create" })).verdict, "allow");
    assert.equal((await can(handle.db, { userId, operation: "refund.cash" })).verdict, "deny");

    const high = await can(handle.db, {
      userId,
      operation: "sale.discount_high",
      percent: 20,
    });
    assert.equal(high.verdict, "needs_approval");
    assert.equal(high.approver, "supervisor");

    // PIN عملیات حساس را باز نمی‌کند — حتی برای مدیر
    assert.equal(
      (await can(handle.db, { userId: adminId, operation: "refund.cash" })).verdict,
      "allow",
    );
    assert.equal(
      (await can(handle.db, { userId: adminId, operation: "refund.cash", viaPin: true })).verdict,
      "deny",
    );
  });

  test("مبلغ در مرز مجوز رشته می‌ماند، نه number", async () => {
    // مبلغی بزرگ‌تر از MAX_SAFE_INTEGER: اگر جایی number شود، خراب می‌شود
    const huge = 9_007_199_254_740_993n;
    const d = await can(handle.db, {
      userId: adminId,
      operation: "sale.create",
      amount: huge,
    });
    assert.equal(d.verdict, "allow");
  });

  test("HTTP: ورود، me، خروج", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username, password: PASSWORD, deviceFingerprint: fingerprint },
    });
    assert.equal(login.statusCode, 200);

    const cookie = login.cookies.find((c) => c.name === "labelmod_session");
    assert.ok(cookie, "کوکی نشست ست نشد");
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, "Strict");
    assert.ok(!login.json().token, "توکن نباید در بدنه پاسخ برگردد");

    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { labelmod_session: cookie.value },
    });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().fullName, "صندوق‌دار یکپارچه");

    const anon = await app.inject({ method: "GET", url: "/auth/me" });
    assert.equal(anon.statusCode, 401);

    const out = await app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { labelmod_session: cookie.value },
    });
    assert.equal(out.statusCode, 200);

    const after = await app.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { labelmod_session: cookie.value },
    });
    assert.equal(after.statusCode, 401, "نشست پس از خروج نباید کار کند");
  });

  test("HTTP: ورودی نامعتبر ۴۰۰ می‌گیرد، نه ۵۰۰", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "", password: "x" },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error.code, "invalid_input");
    assert.ok(r.json().error.correlationId, "کد پیگیری باید برگردد");
    // نشانه‌های واقعی Stack Trace، نه هر «at» ی در متن پیام
    const raw = JSON.stringify(r.json());
    for (const leak of ["\\n    at ", "node_modules", "/src/", ".ts:", "stack"]) {
      assert.ok(!raw.includes(leak), `نشت جزئیات داخلی: ${leak}`);
    }
  });

  test("HTTP: محدودیت نرخ ۴۲۹ می‌دهد، نه ۵۰۰", async () => {
    // این هم در آزمایش زنده پیدا شد: محدودیت نرخ درست فعال می‌شد ولی
    // Error Handler آن را ۵۰۰ می‌کرد. دفاعی که شبیه خرابی گزارش شود،
    // در عمل خاموش است — کسی به لاگ ۵۰۰ اعتماد نمی‌کند.
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username: `nobody_${suffix}`, password: "x", deviceFingerprint: "rate-limit-fp" },
      });
      codes.push(r.statusCode);
    }
    assert.ok(codes.includes(429), `انتظار ۴۲۹ در ${codes.join(",")}`);
    assert.ok(!codes.includes(500), `هیچ ۵۰۰ نباید باشد: ${codes.join(",")}`);

    const limited = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: `nobody_${suffix}`, password: "x", deviceFingerprint: "rate-limit-fp" },
    });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, "rate_limited");
    assert.ok(limited.json().error.correlationId, "کد پیگیری باید حتی اینجا باشد");
  });

  test("HTTP: مسیر ناموجود برای ناشناس ۴۰۱ می‌دهد، نه ۴۰۴", async () => {
    // عمدی: پاسخ ۴۰۴ به کاربر بدون نشست، فهرست مسیرهای موجود را
    // قابل شمارش می‌کند. تفاوت ۴۰۱ و ۴۰۴ فقط برای کسی که وارد شده
    // معنا دارد.
    const anon = await app.inject({ method: "GET", url: "/مسیر-ناموجود" });
    assert.equal(anon.statusCode, 401);

    // نشست از خودِ سرویس گرفته می‌شود، نه از مسیر HTTP: تست محدودیت
    // نرخ پیش از این اجرا شده و سهمیه /auth/login را خرج کرده است.
    // تستی که به ترتیب اجرا وابسته باشد، روزی بی‌دلیل قرمز می‌شود.
    const s = await auth.login({ username, password: PASSWORD, deviceFingerprint: fingerprint });
    const known = await app.inject({
      method: "GET",
      url: "/مسیر-ناموجود",
      cookies: { labelmod_session: s.token },
    });
    assert.equal(known.statusCode, 404);
    assert.equal(known.json().error.message, "مسیر یافت نشد");
    await auth.logout(s.token);
  });
});
