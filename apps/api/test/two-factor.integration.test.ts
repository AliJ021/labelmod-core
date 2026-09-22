import { loginWithMfa } from "./helpers/login-with-mfa.ts";
/**
 * تست یکپارچه احراز هویت دومرحله‌ای — روی پستگرس واقعی.
 *
 * تست واحد `totp.test.ts` با بردارهای RFC ثابت می‌کند الگوریتم درست
 * است. این پرونده چیز دیگری می‌سنجد که فقط با راندن مسیر واقعی دیده
 * می‌شود:
 *
 * ۱. **رمز درست، بدون کد دوم، هیچ نشستی نمی‌سازد.** اگر کوکی نشست
 *    در همان پاسخ اول ست شود، کل عامل دوم یک نمایش است.
 *
 * ۲. **راز تأییدنشده کسی را قفل نمی‌کند.** کاربری که وسط ثبت‌نام رها
 *    کند باید فردا عادی وارد شود.
 *
 * ۳. **کد بازیابی یک بار.** دومین استفاده از همان کد باید رد شود.
 *
 * ۴. **راز ثبت‌نام دستگاه تا ورود کامل صادر نمی‌شود** — بند ۱
 *    SECURITY.md: «فقط پس از اولین ورود کامل».
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
import { totp } from "../src/auth/totp.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : "DATABASE_URL تنظیم نشده — تست یکپارچه رد شد";

const BRANCH = "00000000-0000-7000-8000-000000000001";

describe("احراز هویت دومرحله‌ای", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let app: FastifyInstance;

  const suffix = `f${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-دومرحله‌ای-و-به‌قدر-کافی-بلند";
  const user = `f2a_${suffix}`;
  const plain = `plain_${suffix}`;
  let userId = "";

  /**
   * هر ورود، IP خودش.
   *
   * محدودیت نرخ ورود ۵ در دقیقه **بر IP** است — یک دفاع واقعی که
   * نباید برای راحتی تست ضعیف شود. این پرونده ده‌ها بار وارد می‌شود،
   * پس یک شمارنده به هر تلاش آدرس یکتا می‌دهد. هش‌کردن نام کافی نبود:
   * برخورد داشت و تست‌های آخر ۴۲۹ می‌گرفتند.
   */
  let ipCounter = 0;
  function nextIp(): string {
    ipCounter += 1;
    return `10.7.${Math.floor(ipCounter / 250) + 1}.${(ipCounter % 250) + 2}`;
  }

  /** مرحله اول ورود — پاسخ خام، تا بشود درباره کوکی‌هایش ادعا کرد. */
  async function step1(username: string, fingerprint = `fp-${suffix}`) {
    return await app.inject({
      method: "POST",
      url: "/auth/login",
      remoteAddress: nextIp(),
      payload: { username, password: PASSWORD, deviceFingerprint: fingerprint },
    });
  }

  async function sessionOf(username: string) {
    const r = await step1(username);
    assert.equal(r.statusCode, 200, r.body);
    const csrf = r.cookies.find((c) => c.name === "labelmod_csrf")?.value ?? "";
    return {
      cookies: {
        labelmod_session: r.cookies.find((c) => c.name === "labelmod_session")?.value ?? "",
        labelmod_csrf: csrf,
      },
      headers: { "x-csrf-token": csrf },
    };
  }

  async function currentSecret(): Promise<string> {
    const r = await sql<{ s: string }>`
      SELECT totp_secret AS s FROM identity.app_user WHERE id = ${userId}::uuid
    `.execute(handle.db);
    return r.rows[0]!.s;
  }

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);

    const hash = await hashSecret(PASSWORD);
    for (const [username, name] of [
      [user, "کاربر دومرحله‌ای"],
      [plain, "کاربر ساده"],
    ] as const) {
      const u = await handle.db
        .insertInto("identity.app_user")
        .values({
          username,
          full_name: name,
          password_hash: hash,
          is_active: true,
          mobile: null,
          pin_hash: null,
          totp_secret: null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await handle.db
        .insertInto("identity.user_role")
        .values({ user_id: u.id, role_code: "admin", branch_id: BRANCH })
        .execute();
      if (username === user) userId = u.id;
    }

    app = await buildApp({
      db: handle.db,
      auth: new AuthService(handle.db),
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" }),
    });
    await app.ready();
  });

  after(async () => {
    await app?.close();
    await handle?.close();
    disposable?.drop();
  });

  test("نقش اجباری بدون ۲FA فقط نشست راه‌اندازی می‌گیرد", async () => {
    const r = await step1(plain);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(JSON.parse(r.body).needsSecondFactor, undefined);
    assert.equal(JSON.parse(r.body).enrollmentRequired, true);
    assert.ok(
      r.cookies.some((c) => c.name === "labelmod_session"),
      "کوکی نشست محدود باید ست شود",
    );

    const token = r.cookies.find((c) => c.name === "labelmod_session")!.value;
    const blocked = await app.inject({
      method: "GET",
      url: "/auth/can?operation=settings.security",
      cookies: { labelmod_session: token },
    });
    assert.equal(blocked.statusCode, 403, blocked.body);
    assert.equal(blocked.json().error.code, "second_factor_enrollment_required");

    const enrollment = await app.inject({
      method: "GET",
      url: "/auth/2fa",
      cookies: { labelmod_session: token },
    });
    assert.equal(enrollment.statusCode, 200, enrollment.body);
  });

  test("راز تأییدنشده کسی را قفل نمی‌کند", async () => {
    // **ادعای مرکزی دوم.** اگر راز در همان لحظه ساخت روی `app_user`
    // می‌نشست، کاربری که وسط ثبت‌نام رها می‌کرد فردا پشت کدی قفل
    // می‌شد که هرگز اسکن نکرده.
    const s = await sessionOf(user);
    const begin = await app.inject({
      method: "POST",
      url: "/auth/2fa/totp/begin",
      ...s,
      payload: {},
    });
    assert.equal(begin.statusCode, 200, begin.body);
    const { secret, uri } = JSON.parse(begin.body) as { secret: string; uri: string };
    assert.ok(secret.length >= 32);
    assert.match(uri, /^otpauth:\/\/totp\//);

    // و ورود بعدی هنوز عادی است.
    const again = await step1(user, `fp-${suffix}-2`);
    assert.equal(JSON.parse(again.body).needsSecondFactor, undefined, "هنوز قفل نشده");
  });

  test("کد غلط، ثبت‌نام را تأیید نمی‌کند", async () => {
    const s = await sessionOf(user);
    const r = await app.inject({
      method: "POST",
      url: "/auth/2fa/totp/confirm",
      ...s,
      payload: { code: "000000" },
    });
    // ۴۲۲ نه ۴۰۱: کاربر **وارد شده** و فقط کد را اشتباه تایپ کرده.
    // ۴۰۱ یعنی کلاینت او را از صفحه بیرون بیندازد.
    assert.equal(r.statusCode, 422, r.body);
    assert.equal(JSON.parse(r.body).error.code, "bad_totp_setup");
  });

  test("تأیید با کد درست: فعال می‌شود و ده کد بازیابی می‌دهد", async () => {
    const stolen = await sessionOf(user);
    const s = await sessionOf(user);
    const begin = await app.inject({
      method: "POST",
      url: "/auth/2fa/totp/begin",
      ...s,
      payload: {},
    });
    const { secret } = JSON.parse(begin.body) as { secret: string };

    const r = await app.inject({
      method: "POST",
      url: "/auth/2fa/totp/confirm",
      ...s,
      payload: { code: totp(secret) },
    });
    assert.equal(r.statusCode, 200, r.body);
    const out = JSON.parse(r.body) as { enabled: boolean; recoveryCodes: string[] };
    assert.equal(out.enabled, true);
    assert.equal(out.recoveryCodes.length, 10);
    assert.equal(new Set(out.recoveryCodes).size, 10, "کدها تکراری نیستند");
    const allowed = await app.inject({ method: "GET", url: "/auth/can?operation=settings.security", ...s });
    assert.equal(allowed.statusCode, 200, allowed.body);
    for (const url of ["/auth/me", "/auth/2fa", "/auth/can?operation=settings.security"]) {
      const denied = await app.inject({ method: "GET", url, ...stolen });
      assert.equal(denied.statusCode, 401, denied.body);
    }
    const hijack = await app.inject({ method: "POST", url: "/auth/2fa/totp/confirm", ...stolen, payload: { code: totp(secret) } });
    assert.equal(hijack.statusCode, 401, hijack.body);

    // متن خام هیچ‌جا ذخیره نشده — فقط هشش.
    const stored = await sql<{ n: string; raw: string }>`
      SELECT count(*)::text AS n,
             count(*) FILTER (WHERE code_hash = ANY(${out.recoveryCodes}))::text AS raw
        FROM identity.recovery_code WHERE user_id = ${userId}::uuid
    `.execute(handle.db);
    assert.equal(Number(stored.rows[0]!.n), 10);
    assert.equal(Number(stored.rows[0]!.raw), 0, "متن خام کد نباید ذخیره شده باشد");
  });

  test("از این به بعد، رمز درست هیچ نشستی نمی‌سازد", async () => {
    // **ادعای مرکزی.** اگر کوکی نشست در همان پاسخ اول ست شود، کل
    // عامل دوم یک نمایش است.
    const r = await step1(user, `fp-${suffix}-3`);
    assert.equal(r.statusCode, 200, r.body);
    const body = JSON.parse(r.body) as { needsSecondFactor: boolean; methods: string[] };
    assert.equal(body.needsSecondFactor, true);
    assert.deepEqual(body.methods.sort(), ["recovery", "totp"]);

    assert.equal(
      r.cookies.some((c) => c.name === "labelmod_session"),
      false,
      "هیچ کوکی نشستی نباید ست شود",
    );
    assert.ok(
      r.cookies.some((c) => c.name === "labelmod_pending"),
      "فقط بلیت مرحله دوم",
    );

    // و بلیت، نشست نیست: هیچ مسیری را باز نمی‌کند.
    const pending = r.cookies.find((c) => c.name === "labelmod_pending")!.value;
    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { labelmod_session: pending },
    });
    assert.equal(me.statusCode, 401, "بلیت به‌جای نشست کار نمی‌کند");
  });

  test("کد درست مرحله دوم، نشست می‌سازد", async () => {
    const first = await step1(user, `fp-${suffix}-4`);
    const pending = first.cookies.find((c) => c.name === "labelmod_pending")!.value;

    const r = await app.inject({
      method: "POST",
      url: "/auth/2fa/totp",
      remoteAddress: nextIp(),
      cookies: { labelmod_pending: pending },
      payload: { code: totp(await currentSecret()) },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.ok(
      r.cookies.some((c) => c.name === "labelmod_session"),
      "حالا نشست ساخته می‌شود",
    );

    const session = r.cookies.find((c) => c.name === "labelmod_session")!.value;
    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { labelmod_session: session },
    });
    assert.equal(me.statusCode, 200, "نشست واقعی است");

    // بلیت مصرف شد — همان بلیت دوباره کار نمی‌کند.
    const replay = await app.inject({
      method: "POST",
      url: "/auth/2fa/totp",
      remoteAddress: nextIp(),
      cookies: { labelmod_pending: pending },
      payload: { code: totp(await currentSecret()) },
    });
    assert.equal(replay.statusCode, 401, replay.body);
  });

  test("کد غلط مرحله دوم رد می‌شود، ولی بلیت را نمی‌سوزاند", async () => {
    const first = await step1(user, `fp-${suffix}-5`);
    const pending = first.cookies.find((c) => c.name === "labelmod_pending")!.value;

    const bad = await app.inject({
      method: "POST",
      url: "/auth/2fa/totp",
      remoteAddress: nextIp(),
      cookies: { labelmod_pending: pending },
      payload: { code: "000000" },
    });
    assert.equal(bad.statusCode, 401, bad.body);

    // غلط تایپی نباید کاربر را به اول مسیر بفرستد.
    const good = await app.inject({
      method: "POST",
      url: "/auth/2fa/totp",
      remoteAddress: nextIp(),
      cookies: { labelmod_pending: pending },
      payload: { code: totp(await currentSecret()) },
    });
    assert.equal(good.statusCode, 200, good.body);
  });

  test("کد بازیابی یک بار کار می‌کند — و فقط یک بار", async () => {
    const s = await sessionOf(plain);
    // فهرست تازه برای کاربر ۲FA‌دار، از نشست خودش.
    const first = await step1(user, `fp-${suffix}-6`);
    const pending = first.cookies.find((c) => c.name === "labelmod_pending")!.value;
    const login = await app.inject({
      method: "POST",
      url: "/auth/2fa/totp",
      remoteAddress: nextIp(),
      cookies: { labelmod_pending: pending },
      payload: { code: totp(await currentSecret()) },
    });
    const own = {
      cookies: {
        labelmod_session: login.cookies.find((c) => c.name === "labelmod_session")!.value,
        labelmod_csrf: login.cookies.find((c) => c.name === "labelmod_csrf")!.value,
      },
      headers: {
        "x-csrf-token": login.cookies.find((c) => c.name === "labelmod_csrf")!.value,
      },
    };
    assert.ok(s.cookies.labelmod_session, "کاربر ساده هم نشست دارد");

    const regen = await app.inject({
      method: "POST",
      url: "/auth/2fa/recovery/regenerate",
      ...own,
      payload: {},
    });
    assert.equal(regen.statusCode, 200, regen.body);
    const codes = (JSON.parse(regen.body) as { recoveryCodes: string[] }).recoveryCodes;

    const step = await step1(user, `fp-${suffix}-7`);
    const p2 = step.cookies.find((c) => c.name === "labelmod_pending")!.value;
    const used = await app.inject({
      method: "POST",
      url: "/auth/2fa/recovery",
      remoteAddress: nextIp(),
      cookies: { labelmod_pending: p2 },
      payload: { code: codes[0] },
    });
    assert.equal(used.statusCode, 200, used.body);

    // **همان کد، بار دوم.**
    const step2 = await step1(user, `fp-${suffix}-8`);
    const p3 = step2.cookies.find((c) => c.name === "labelmod_pending")!.value;
    const again = await app.inject({
      method: "POST",
      url: "/auth/2fa/recovery",
      remoteAddress: nextIp(),
      cookies: { labelmod_pending: p3 },
      payload: { code: codes[0] },
    });
    assert.equal(again.statusCode, 401, "کد مصرف‌شده دوباره کار نمی‌کند");

    // ولی کد بعدی هنوز کار می‌کند.
    const other = await app.inject({
      method: "POST",
      url: "/auth/2fa/recovery",
      remoteAddress: nextIp(),
      cookies: { labelmod_pending: p3 },
      payload: { code: codes[1] },
    });
    assert.equal(other.statusCode, 200, other.body);
  });

  test("کد مصرف‌شده از هیچ مسیری دوباره فعال نمی‌شود", async () => {
    // نگهبان دیتابیس، نه لایه API: یک `UPDATE` مستقیم هم نباید بتواند.
    await assert.rejects(
      sql`UPDATE identity.recovery_code SET used_at = NULL
           WHERE user_id = ${userId}::uuid AND used_at IS NOT NULL`.execute(handle.db),
      /مصرف‌شده/,
    );
  });

  test("نشست بازشده با PIN نمی‌تواند عامل دوم را بردارد", async () => {
    // بند ۱ SECURITY.md: «PIN هرگز عملیات حساس را مجاز نمی‌کند».
    // برداشتن عامل دوم دقیقاً یکی از آن‌هاست — کسی که PIN را دارد
    // نباید بتواند دومین لایه را خاموش کند.
    //
    // ⚠️ به‌جای ساختن کل زنجیره دستگاه و PIN، همان پرچمی که
    //    `identity.can()` می‌خواند مستقیم روی نشست ست می‌شود. این
    //    دقیقاً همان چیزی است که مسیر واقعی می‌سنجد.
    const first = await step1(user, `fp-${suffix}-pin`);
    const pending = first.cookies.find((c) => c.name === "labelmod_pending")?.value;
    assert.ok(pending, `مرحله اول بلیت نداد: ${first.body}`);
    const login = await app.inject({
      method: "POST",
      url: "/auth/2fa/totp",
      remoteAddress: nextIp(),
      cookies: { labelmod_pending: pending },
      payload: { code: totp(await currentSecret()) },
    });
    assert.equal(login.statusCode, 200, login.body);
    const cookie = login.cookies.find((c) => c.name === "labelmod_session")!.value;
    const csrf = login.cookies.find((c) => c.name === "labelmod_csrf")!.value;

    await sql`
      UPDATE identity.session SET pin_unlocked = true
       WHERE token_hash = encode(sha256(${cookie}::bytea), 'hex')
    `.execute(handle.db);

    const r = await app.inject({
      method: "DELETE",
      url: "/auth/2fa",
      cookies: { labelmod_session: cookie, labelmod_csrf: csrf },
      headers: { "x-csrf-token": csrf },
    });
    assert.equal(r.statusCode, 403, r.body);
    assert.equal(JSON.parse(r.body).error.code, "pin_not_allowed");

    // و عامل دوم هنوز سر جایش است.
    const st = await sql<{ s: string | null }>`
      SELECT totp_secret AS s FROM identity.app_user WHERE id = ${userId}::uuid
    `.execute(handle.db);
    assert.ok(st.rows[0]!.s, "راز نباید برداشته شده باشد");
  });

  test("مدیر می‌تواند عامل دوم کاربر دیگر را بردارد", async () => {
    // گوشی گم شده و کد بازیابی هم نیست. بدون این مسیر، تنها راه psql
    // روی سرور بود.
    const enrolled = await loginWithMfa(app, { method: "POST", url: "/auth/login", remoteAddress: nextIp(),
      payload: { username: plain, password: PASSWORD, deviceFingerprint: `admin-reset-${suffix}` } });
    const cookies = Object.fromEntries(enrolled.cookies.map(c => [c.name, c.value]));
    const s = { cookies, headers: { "x-csrf-token": cookies.labelmod_csrf! } };
    const r = await app.inject({
      method: "DELETE",
      url: `/users/${userId}/2fa`,
      ...s,
    });
    assert.equal(r.statusCode, 200, r.body);

    const after = await step1(user, `fp-${suffix}-10`);
    assert.equal(
      JSON.parse(after.body).needsSecondFactor,
      undefined,
      "پس از برداشتن، کاربر باید دوباره عامل دوم ثبت کند",
    );
    assert.equal(after.json().enrollmentRequired, true);
    const st = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM identity.recovery_code WHERE user_id = ${userId}::uuid
    `.execute(handle.db);
    assert.equal(Number(st.rows[0]!.n), 0, "کدهای بازیابی هم رفتند");
  });
});
