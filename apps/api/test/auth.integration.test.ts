import { loginWithMfa } from "./helpers/login-with-mfa.ts";
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
import { AuthService, type LoginOutcome, type Session } from "../src/auth/service.ts";
import { can } from "../src/auth/permission.ts";
import { hashSecret } from "../src/auth/password.ts";
import { buildApp } from "../src/http/app.ts";
import { loadConfig } from "../src/lib/config.ts";
import type { FastifyInstance } from "fastify";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : "DATABASE_URL تنظیم نشده — تست یکپارچه رد شد";

/**
 * نشست از خروجی ورود — و ادعای اینکه عامل دوم خواسته **نشده**.
 *
 * `login()` عمداً یک اتحاد تفکیک‌شده برمی‌گرداند تا هیچ مسیری نتواند
 * عامل دوم را بی‌صدا نادیده بگیرد. اینجا هم همان را می‌سنجیم: این
 * کاربرها ۲FA ندارند، پس هر پاسخ دیگری یک تغییر رفتار است.
 */
function expectSession(outcome: LoginOutcome): Session {
  assert.equal(outcome.kind, "session", "این کاربر نباید عامل دوم بخواهد");
  return (outcome as { kind: "session"; session: Session }).session;
}

describe("احراز هویت روی دیتابیس واقعی", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let auth: AuthService;
  let app: FastifyInstance;
  let userId: string;
  let adminId: string;
  const suffix = `t${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const username = `cashier_${suffix}`;
  const adminName = `admin_${suffix}`;
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
        username: adminName,
        full_name: "مدیر یکپارچه",
        password_hash: hash,
        is_active: true,
        mobile: null,
        pin_hash: await hashSecret("1379"),
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
    const s = expectSession(await auth.login({ username, password: PASSWORD, deviceFingerprint: fingerprint }));
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
    const s = expectSession(await auth.login({ username, password: PASSWORD, deviceFingerprint: fp }));
    assert.equal(s.device?.registered, true, "دستگاه تازه باید ثبت شود");
    assert.equal(s.device?.approved, false, "ولی هرگز خودبه‌خود تأیید نمی‌شود");

    const r = await loginWithMfa(app, {
      method: "POST",
      url: "/auth/login",
      payload: { username, password: PASSWORD, deviceFingerprint: fp },
    });
    assert.deepEqual(r.json().device, {
      registered: true,
      approved: false,
      enrolled: false,
      pinAvailable: false,
    });

    await sql`SELECT identity.approve_device(
                (SELECT id FROM identity.device WHERE fingerprint = ${fp}),
                ${adminId}::uuid)`.execute(handle.db);
    const after = expectSession(await auth.login({ username, password: PASSWORD, deviceFingerprint: fp }));
    assert.equal(after.device?.approved, true, "پس از تأیید مدیر باید true شود");
    assert.ok(after.device?.issuedSecret, "و همان ورود باید راز ثبت‌نام بدهد");

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

  test("قفل، وجود نام کاربری را لو نمی‌دهد", async () => {
    // اوراکل شمارش نام کاربری: نسخه اول قفل را *پیش از* تطبیق رمز
    // می‌سنجید، پس تلاش ششم برای کاربر موجود «locked» می‌گرفت و برای
    // نام ناموجود «bad_credentials» — با ۱۰ برابر اختلاف زمان، چون
    // مسیر قفل اصلاً Argon2id را اجرا نمی‌کرد.
    //
    // و چون قفل روی «کاربر + دستگاه» است و fingerprint را خود مهاجم
    // می‌فرستد، شمارش کاملاً بی‌صدا بود: کاربر واقعی هیچ اختلالی
    // نمی‌دید.
    const probe = async (name: string) => {
      const fp = `enum-${name}-${Date.now()}`;
      for (let i = 0; i < 5; i++) {
        await auth.login({ username: name, password: WRONG, deviceFingerprint: fp }).catch(() => {});
      }
      return auth
        .login({ username: name, password: WRONG, deviceFingerprint: fp })
        .then(() => "ok", (e: { code?: string; message?: string }) => `${e.code}|${e.message}`);
    };

    const existing = await probe(username);
    const missing = await probe(`ghost_${suffix}`);
    assert.equal(existing, missing, "پاسخ کاربر موجود و ناموجود باید یکسان باشد");
    assert.match(existing, /^bad_credentials\|/);
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
    const other = expectSession(
      await auth.login({
        username,
        password: PASSWORD,
        deviceFingerprint: `${fingerprint}-other`,
      }),
    );
    assert.ok(other.token, "دستگاه دیگرِ همان کاربر نباید قفل باشد");
    await auth.logout(other.token);
  });

  test("PIN بدون راز ثبت‌نام دستگاه کار نمی‌کند", async () => {
    // یافته بازبینی امنیتی، مورد ۳: هویت دستگاه فقط یک رشته بود که
    // کلاینت می‌فرستاد. هر کسی که fingerprint یک تبلت تأییدشده را
    // می‌دانست، می‌توانست نشستش را روی «دستگاه مورد اعتماد» بنشاند
    // بدون اینکه فیزیکی به آن دسترسی داشته باشد.
    const fp = `${fingerprint}-enroll`;
    const s1 = expectSession(await auth.login({ username, password: PASSWORD, deviceFingerprint: fp }));
    assert.equal(s1.device?.approved, false);
    assert.equal(s1.device?.enrolled, false);
    assert.equal(s1.device?.issuedSecret, undefined, "دستگاه تأییدنشده راز نمی‌گیرد");

    // تأیید مدیر — ولی هنوز ثبت‌نام نشده
    await sql`SELECT identity.approve_device(
                (SELECT id FROM identity.device WHERE fingerprint = ${fp}),
                ${adminId}::uuid)`.execute(handle.db);

    await auth.lock(s1.token);
    await assert.rejects(
      () => auth.unlockWithPin(s1.token, "4321", fp, undefined),
      /ثبت‌نام نشده/,
      "تأیید به‌تنهایی نباید PIN را باز کند",
    );

    // ورود کامل بعدی راز را صادر می‌کند — و فقط همان یک بار
    const s2 = expectSession(await auth.login({ username, password: PASSWORD, deviceFingerprint: fp }));
    const secret = s2.device?.issuedSecret;
    assert.ok(secret, "اولین ورود کامل پس از تأیید باید راز صادر کند");
    assert.equal(s2.device?.enrolled, true);

    const s3 = expectSession(await auth.login({ username, password: PASSWORD, deviceFingerprint: fp }));
    assert.equal(s3.device?.issuedSecret, undefined, "راز فقط یک بار صادر می‌شود");
    assert.equal(s3.device?.enrolled, true);

    // راز غلط قبول نمی‌شود
    await auth.lock(s3.token);
    await assert.rejects(
      () => auth.unlockWithPin(s3.token, "4321", fp, "راز-جعلی-و-به‌قدر-کافی-بلند"),
      /مجاز نیست/,
      "راز نادرست نباید قفل را باز کند",
    );

    // راز درست کار می‌کند
    await auth.unlockWithPin(s3.token, "4321", fp, secret);
    assert.equal((await auth.resolve(s3.token))?.userId, userId);

    await auth.logout(s1.token);
    await auth.logout(s2.token);
    await auth.logout(s3.token);
  });

  test("نشستِ باز‌شده با PIN، عملیات حساس را باز نمی‌کند", async () => {
    // یافته بازبینی امنیتی، مورد ۱: identity.can پارامتر p_via_pin
    // داشت و تست هم داشت، ولی هیچ مسیر واقعی‌ای true نمی‌فرستاد —
    // یعنی شرط چهارم دفاع PIN در سیستم در حال اجرا مرده بود.
    const fp = `${fingerprint}-elev`;
    expectSession(await auth.login({ username: adminName, password: PASSWORD, deviceFingerprint: fp }));
    await sql`SELECT identity.approve_device(
                (SELECT id FROM identity.device WHERE fingerprint = ${fp}),
                ${adminId}::uuid)`.execute(handle.db);
    const s = expectSession(await auth.login({ username: adminName, password: PASSWORD, deviceFingerprint: fp }));
    const secret = s.device?.issuedSecret;
    assert.ok(secret);

    // نشست تازه با رمز: ارتقایافته
    let live = await auth.resolve(s.token);
    assert.equal(live?.pinUnlocked, false);
    assert.equal(
      (await can(handle.db, { userId: adminId, operation: "refund.cash", viaPin: live!.pinUnlocked }))
        .verdict,
      "allow",
      "مدیر با احراز کامل باید بتواند",
    );

    // پس از باز شدن با PIN: همان مدیر، همان عملیات، ممنوع
    await auth.lock(s.token);
    await auth.unlockWithPin(s.token, "1379", fp, secret);
    live = await auth.resolve(s.token);
    assert.equal(live?.pinUnlocked, true, "نشست باید بداند با PIN باز شده");
    assert.equal(
      (await can(handle.db, { userId: adminId, operation: "refund.cash", viaPin: live!.pinUnlocked }))
        .verdict,
      "deny",
      "همان مدیر از مسیر PIN نباید بتواند",
    );
    // ولی فروش عادی باز است
    assert.equal(
      (await can(handle.db, { userId: adminId, operation: "sale.create", viaPin: live!.pinUnlocked }))
        .verdict,
      "allow",
    );

    // احراز کامل مجدد نشست را ارتقا می‌دهد
    await assert.rejects(() => auth.reauthenticate(s.token, WRONG), /نام کاربری یا رمز/);
    live = await auth.resolve(s.token);
    assert.equal(live?.pinUnlocked, true, "رمز غلط نباید ارتقا بدهد");

    await auth.reauthenticate(s.token, PASSWORD);
    live = await auth.resolve(s.token);
    assert.equal(live?.pinUnlocked, false, "احراز کامل مجدد باید ارتقا بدهد");
    assert.equal(
      (await can(handle.db, { userId: adminId, operation: "refund.cash", viaPin: live!.pinUnlocked }))
        .verdict,
      "allow",
    );
    await auth.logout(s.token);
  });

  test("ابطال همه نشست‌ها — الزام «گوشی مفقودی»", async () => {
    const a = expectSession(await auth.login({ username, password: PASSWORD, deviceFingerprint: fingerprint }));
    const b = expectSession(
      await auth.login({ username, password: PASSWORD, deviceFingerprint: `${fingerprint}-2` }),
    );

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
    const login = await loginWithMfa(app, {
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

    // خروج یک عملیات تغییردهنده وضعیت است، پس توکن CSRF می‌خواهد
    const csrf = login.cookies.find((c) => c.name === "labelmod_csrf");
    assert.ok(csrf, "کوکی CSRF ست نشد");
    // صفت HttpOnly اصلاً ست نمی‌شود (نه اینکه false باشد) — الگوی
    // Double-Submit به کدِ صفحه نیاز دارد که مقدار را بخواند و در
    // سرآیند برگرداند.
    assert.ok(!csrf.httpOnly, "توکن CSRF باید برای کد صفحه خواندنی باشد");
    assert.equal(cookie.httpOnly, true, "ولی توکن نشست هرگز خواندنی نیست");

    const out = await app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { labelmod_session: cookie.value, labelmod_csrf: csrf.value },
      headers: { "x-csrf-token": csrf.value },
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
    const r = await loginWithMfa(app, {
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

  test("HTTP: درخواست تغییردهنده بدون توکن CSRF رد می‌شود", async () => {
    // یافته بازبینی امنیتی، مورد ۴: بند ۶ SECURITY.md دو لایه خواسته —
    // SameSite=Strict **به‌علاوه** توکن Double-Submit. لایه دوم فقط در
    // یک کامنت ادعا شده بود.
    const s = expectSession(await auth.login({ username, password: PASSWORD, deviceFingerprint: fingerprint }));
    const csrfValue = "توکن-csrf-ساختگی-برای-تست";

    const noHeader = await app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { labelmod_session: s.token, labelmod_csrf: csrfValue },
    });
    assert.equal(noHeader.statusCode, 403, "بدون سرآیند باید رد شود");
    assert.equal(noHeader.json().error.code, "csrf_failed");

    const wrongHeader = await app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { labelmod_session: s.token, labelmod_csrf: csrfValue },
      headers: { "x-csrf-token": "چیز-دیگری" },
    });
    assert.equal(wrongHeader.statusCode, 403, "سرآیند ناهماهنگ باید رد شود");

    // GET نیازی ندارد — وضعیت را عوض نمی‌کند
    const read = await app.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { labelmod_session: s.token },
    });
    assert.equal(read.statusCode, 200, "GET نباید توکن CSRF بخواهد");

    const ok = await app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { labelmod_session: s.token, labelmod_csrf: csrfValue },
      headers: { "x-csrf-token": csrfValue },
    });
    assert.equal(ok.statusCode, 200);
  });

  test("ورود هرگز پشت دفاع CSRF گیر نمی‌کند", async () => {
    // تله‌ای که در آزمایش زنده پیدا شد: نسخه اول، ورود را هم پشت CSRF
    // می‌گذاشت. کاربری که کوکی نشستش مانده ولی کوکی CSRF را از دست
    // داده بود، دیگر هرگز نمی‌توانست وارد شود — و راه خروجی جز
    // پاک‌کردن دستی کوکی نداشت.
    //
    // آن بررسی هیچ محافظتی هم اضافه نمی‌کرد: با SameSite=Strict،
    // درخواست بین‌سایتی اصلاً کوکی نمی‌فرستد.
    const stale = expectSession(await auth.login({ username, password: PASSWORD, deviceFingerprint: fingerprint }));

    const relogin = await loginWithMfa(app, {
      method: "POST",
      url: "/auth/login",
      // کوکی نشست هست، کوکی و سرآیند CSRF نیست
      cookies: { labelmod_session: stale.token },
      payload: { username, password: PASSWORD, deviceFingerprint: fingerprint },
    });
    assert.equal(relogin.statusCode, 200, "ورود دوباره نباید ۴۰۳ بگیرد");
    assert.ok(relogin.cookies.find((c) => c.name === "labelmod_csrf"), "و باید کوکی تازه بدهد");
    await auth.logout(stale.token);
  });

  test("HTTP: نگهبان دیتابیس ۴۰۹ می‌دهد، نه ۵۰۰", async () => {
    // در آزمایش زنده پیدا شد: راز جعلی دستگاه، unlock_session را با
    // RAISE EXCEPTION رد می‌کرد (SQLSTATE P0001) و Error Handler آن را
    // «خطای ناشناخته» می‌دید → ۵۰۰.
    //
    // همان الگوی محدودیت نرخ: دفاعی که شبیه خرابی سرور گزارش شود، در
    // عمل خاموش است. و این برای هر تابع مالی آینده هم صدق می‌کند —
    // apply_movement، post_entry، post_cheque_event همه P0001 می‌زنند.
    const fp = `${fingerprint}-p0001`;
    expectSession(await auth.login({ username, password: PASSWORD, deviceFingerprint: fp }));
    await sql`SELECT identity.approve_device(
                (SELECT id FROM identity.device WHERE fingerprint = ${fp}),
                ${adminId}::uuid)`.execute(handle.db);
    const s = expectSession(await auth.login({ username, password: PASSWORD, deviceFingerprint: fp }));
    assert.ok(s.device?.issuedSecret);

    await auth.lock(s.token);
    const forged = await app.inject({
      method: "POST",
      url: "/auth/unlock",
      cookies: {
        labelmod_session: s.token,
        labelmod_csrf: "csrf-value",
        labelmod_device: "راز-جعلی-و-به‌قدر-کافی-بلند",
      },
      headers: { "x-csrf-token": "csrf-value" },
      payload: { pin: "4321", deviceFingerprint: fp },
    });
    assert.notEqual(forged.statusCode, 500, "نباید ۵۰۰ بدهد");
    assert.equal(forged.statusCode, 403, "راز جعلی باید ۴۰۳ روشن بگیرد");
    assert.equal(forged.json().error.code, "pin_not_allowed");
    assert.match(forged.json().error.message, /مجاز نیست/);

    // و راز درست همچنان کار می‌کند
    const ok = await app.inject({
      method: "POST",
      url: "/auth/unlock",
      cookies: {
        labelmod_session: s.token,
        labelmod_csrf: "csrf-value",
        labelmod_device: s.device.issuedSecret as string,
      },
      headers: { "x-csrf-token": "csrf-value" },
      payload: { pin: "4321", deviceFingerprint: fp },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().elevated, false, "PIN نشست را ارتقا نمی‌دهد");
    await auth.logout(s.token);
  });

  test("HTTP: محدودیت نرخ ۴۲۹ می‌دهد، نه ۵۰۰", async () => {
    // این هم در آزمایش زنده پیدا شد: محدودیت نرخ درست فعال می‌شد ولی
    // Error Handler آن را ۵۰۰ می‌کرد. دفاعی که شبیه خرابی گزارش شود،
    // در عمل خاموش است — کسی به لاگ ۵۰۰ اعتماد نمی‌کند.
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await loginWithMfa(app, {
        method: "POST",
        url: "/auth/login",
        payload: { username: `nobody_${suffix}`, password: "x", deviceFingerprint: "rate-limit-fp" },
      });
      codes.push(r.statusCode);
    }
    assert.ok(codes.includes(429), `انتظار ۴۲۹ در ${codes.join(",")}`);
    assert.ok(!codes.includes(500), `هیچ ۵۰۰ نباید باشد: ${codes.join(",")}`);

    const limited = await loginWithMfa(app, {
      method: "POST",
      url: "/auth/login",
      payload: { username: `nobody_${suffix}`, password: "x", deviceFingerprint: "rate-limit-fp" },
    });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, "rate_limited");
    assert.ok(limited.json().error.correlationId, "کد پیگیری باید حتی اینجا باشد");
  });

  test("HTTP: POST بدون بدنه با Content-Type: application/json کار می‌کند", async () => {
    // در آزمایش زنده پیدا شد: کلاینت‌های رایج (axios و مانندش) روی هر
    // POST سرآیند application/json می‌گذارند حتی بی‌بدنه. بدون پارسر
    // سفارشی، نهایی‌سازی فاکتور و قفل صفحه ۴۰۰ می‌گرفتند با پیامی
    // انگلیسی. تست‌ها `payload: {}` می‌فرستادند و هرگز به حالت واقعی
    // نمی‌رسیدند.
    const s = expectSession(await auth.login({ username, password: PASSWORD, deviceFingerprint: fingerprint }));
    const csrf = "csrf-empty-body";
    const r = await app.inject({
      method: "POST",
      url: "/auth/lock",
      cookies: { labelmod_session: s.token, labelmod_csrf: csrf },
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      body: "",
    });
    assert.equal(r.statusCode, 200, `بدنه خالی نباید رد شود: ${r.body}`);

    // نشست تازه: درخواست بالا نشست قبلی را **قفل** کرد، پس با همان
    // نمی‌شود ادامه داد — و ۴۰۱ گرفتن اینجا رفتار درست است.
    const s2 = expectSession(await auth.login({ username, password: PASSWORD, deviceFingerprint: fingerprint }));

    // ولی JSON خراب همچنان رد می‌شود — با پیام فارسی
    const bad = await app.inject({
      method: "POST",
      url: "/auth/lock",
      cookies: { labelmod_session: s2.token, labelmod_csrf: csrf },
      headers: { "x-csrf-token": csrf, "content-type": "application/json" },
      body: "{ناقص",
    });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.json().error.message, /معتبر نیست/);
    await auth.logout(s.token);
    await auth.logout(s2.token);
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
    const s = expectSession(await auth.login({ username, password: PASSWORD, deviceFingerprint: fingerprint }));
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
