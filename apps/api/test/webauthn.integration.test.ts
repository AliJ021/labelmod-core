/**
 * WebAuthn — آنچه **بدون** Authenticator واقعی سنجیدنی است.
 *
 * ⚠️ **EXTERNAL VERIFICATION REQUIRED.** مراسم واقعی ثبت و ورود به یک
 *    دامنه واقعی و یک کلید سخت‌افزاری یا Passkey واقعی نیاز دارد و
 *    اینجا سنجیده **نمی‌شود**. پیش از بهره‌برداری باید یک بار با کلید
 *    واقعی آزموده شود — هیچ‌کدام از این ادعاها جایش را نمی‌گیرد.
 *
 * آنچه اینجا سنجیده می‌شود، همه‌شان کدِ ماست نه کتابخانه:
 *
 * ۱. **دامنه از `platform.public_url` می‌آید، نه از هدر `Host`.**
 *    هدر را کلاینت می‌فرستد و WebAuthn دقیقاً برای این وجود دارد که
 *    دامنه قابل جعل نباشد.
 *
 * ۲. **چالش یک‌بارمصرف است.** دو بار خواندن یک چالش یعنی Replay.
 *
 * ۳. **پاسخ خراب ۵۰۰ نمی‌دهد.** کتابخانه برای پاسخ ناقص `throw`
 *    می‌کند؛ بدون ترجمه، یک شکست عادی احراز هویت شبیه خرابی سرور
 *    گزارش می‌شد — و دفاعی که شبیه خرابی باشد، در عمل خاموش است.
 *
 * ۴. **یک کلید ثبت‌شده، خودش عامل دوم را الزامی می‌کند** — حتی بدون
 *    TOTP. اگر نمی‌کرد، کاربری که فقط Passkey دارد بدون عامل دوم
 *    وارد می‌شد.
 *
 * ۵. **کلید کسِ دیگر حذف نمی‌شود.** دامنه روی `user_id` سنجیده
 *    می‌شود، نه فقط روی شناسه سطر.
 *
 * ۶. **نشستِ باز‌شده با PIN کلید ثبت نمی‌کند.** بند ۱ SECURITY.md.
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
import { webauthnConfigFrom, WebauthnService } from "../src/auth/webauthn.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : "DATABASE_URL تنظیم نشده — تست یکپارچه رد شد";

const BRANCH = "00000000-0000-7000-8000-000000000001";
const SYSTEM_USER = "00000000-0000-7000-8000-0000000000ff";

describe("کلید امنیتی (WebAuthn)", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let app: FastifyInstance;
  let svc: WebauthnService;

  const suffix = `w${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-کلید-امنیتی-و-به‌قدر-کافی-بلند";
  const owner = `wa_${suffix}`;
  const other = `wb_${suffix}`;
  /**
   * کاربر سوم عمداً هست: به محض اینکه کاربری یک کلید بگیرد، ورودش
   * **درست** عامل دوم می‌خواهد و دیگر نشست نمی‌سازد. سنجش PIN به یک
   * نشست کامل نیاز دارد، پس باید روی کاربری باشد که کلید ندارد.
   */
  const pinUser = `wc_${suffix}`;
  let ownerId = "";
  let otherId = "";
  let pinUserId = "";

  /** هر ورود، IP خودش — محدودیت نرخ یک دفاع واقعی است. */
  let ipCounter = 0;
  function nextIp(): string {
    ipCounter += 1;
    return `10.9.${Math.floor(ipCounter / 250) + 1}.${(ipCounter % 250) + 2}`;
  }

  async function set(key: string, value: unknown): Promise<void> {
    await sql`
      SELECT platform.set_setting(${key}, ${JSON.stringify(value)}::jsonb,
                                  'تست', ${SYSTEM_USER}::uuid)
    `.execute(handle.db);
  }

  async function login(username: string) {
    const r = await app.inject({
      method: "POST",
      url: "/auth/login",
      remoteAddress: nextIp(),
      payload: { username, password: PASSWORD, deviceFingerprint: `fp-${suffix}` },
    });
    assert.equal(r.statusCode, 200, r.body);
    return r;
  }

  async function sessionOf(username: string) {
    const r = await login(username);
    const csrf = r.cookies.find((c) => c.name === "labelmod_csrf")?.value ?? "";
    const session = r.cookies.find((c) => c.name === "labelmod_session")?.value ?? "";
    assert.ok(session, "کوکی نشست باید ست شود");
    return {
      cookies: { labelmod_session: session, labelmod_csrf: csrf },
      headers: { "x-csrf-token": csrf },
    };
  }

  /**
   * شناسه کلید همیشه base64url است — همان شکلی که Authenticator
   * تولید می‌کند. شناسه ساختگی با حروف فارسی، کتابخانه را در
   * `generateAuthenticationOptions` می‌شکند.
   */
  function credId(label: string): string {
    return Buffer.from(`${label}-${suffix}`, "utf8").toString("base64url");
  }

  /** یک کلید ساختگی — فقط برای سنجش دامنه، فهرست و حذف. */
  async function fakeCredential(userId: string, credentialId: string, counter = 0) {
    const r = await handle.db
      .insertInto("identity.webauthn_credential")
      .values({
        user_id: userId,
        credential_id: credentialId,
        public_key: Buffer.from("کلید-ساختگی").toString("base64url"),
        counter: String(counter),
        transports: null,
        device_type: "multiDevice",
        backed_up: true,
        name: "کلید تست",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return r.id;
  }

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);

    const hash = await hashSecret(PASSWORD);
    for (const [username, name] of [
      [owner, "صاحب کلید"],
      [other, "کاربر دیگر"],
      [pinUser, "کاربر PIN"],
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
      if (username === owner) ownerId = u.id;
      else if (username === other) otherId = u.id;
      else pinUserId = u.id;
    }

    svc = new WebauthnService(handle.db);
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

  // ── ۱. دامنه ────────────────────────────────────────────────────

  test("بدون «آدرس عمومی سامانه»، مراسم اصلاً شروع نمی‌شود", async () => {
    // Seed این کلید را خالی می‌گذارد. شروع مراسم با دامنه حدسی یعنی
    // کلیدهایی که فردا با دامنه درست کار نمی‌کنند.
    await set("platform.public_url", "");
    await assert.rejects(
      () => webauthnConfigFrom(handle.db),
      /آدرس عمومی سامانه/,
      "باید با پیام فارسی و روشن رد شود",
    );
  });

  test("نشانی نامعتبر رد می‌شود، نه اینکه دامنه‌ای عجیب بسازد", async () => {
    await set("platform.public_url", "نه-یک-نشانی");
    await assert.rejects(() => webauthnConfigFrom(handle.db), /نشانی معتبر/);
  });

  test("rpId از hostname می‌آید و پورت را برنمی‌دارد", async () => {
    // `host` پورت دارد و `rpId` نباید داشته باشد — با پورت، مرورگر
    // مراسم را با «rpId نامعتبر» رد می‌کند و پیامش به هیچ‌کس نمی‌رسد.
    await set("platform.public_url", "https://pos.labelmod.example:8443/فاکتور");
    const cfg = await webauthnConfigFrom(handle.db);
    assert.equal(cfg.rpId, "pos.labelmod.example");
    assert.equal(cfg.origin, "https://pos.labelmod.example:8443");
  });

  test("دامنه از تنظیم می‌آید، نه از هدر Host درخواست", async () => {
    await set("platform.public_url", "https://pos.labelmod.example");
    const s = await sessionOf(owner);
    const r = await app.inject({
      method: "POST",
      url: "/auth/2fa/webauthn/register/begin",
      ...s,
      // هدر Host را کلاینت می‌فرستد. اگر rpId از آن ساخته می‌شد،
      // یک صفحه جعلی می‌توانست کلید را به دامنه خودش گره بزند.
      headers: { ...s.headers, host: "مهاجم.example" },
      payload: {},
    });
    assert.equal(r.statusCode, 200, r.body);
    const opts = JSON.parse(r.body) as { rp: { id: string }; challenge: string };
    assert.equal(opts.rp.id, "pos.labelmod.example", "rpId باید از تنظیم بیاید");
    assert.ok(opts.challenge.length > 0);
  });

  // ── ۲. چرخه چالش ────────────────────────────────────────────────

  test("شروع دوباره، چالش قبلی را جایگزین می‌کند — نه اینکه روی هم جمع شود", async () => {
    await svc.beginRegistration({ userId: ownerId, username: owner, fullName: "صاحب کلید" });
    await svc.beginRegistration({ userId: ownerId, username: owner, fullName: "صاحب کلید" });
    const r = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM identity.webauthn_challenge
       WHERE user_id = ${ownerId}::uuid AND kind = 'register'
    `.execute(handle.db);
    assert.equal(r.rows[0]!.n, "1", "فقط یک چالش باز، وگرنه چالش کهنه هم پذیرفته می‌شد");
  });

  test("چالش یک‌بارمصرف است: تلاش دوم «مهلت تمام شده» می‌گیرد", async () => {
    const s = await sessionOf(owner);
    await app.inject({
      method: "POST",
      url: "/auth/2fa/webauthn/register/begin",
      ...s,
      payload: {},
    });

    // پاسخ ساختگی — مراسم شکست می‌خورد، ولی **چالش باید مصرف شود**.
    const bad = { response: { id: "ساختگی", rawId: "ساختگی", type: "public-key", response: {} } };
    const first = await app.inject({
      method: "POST",
      url: "/auth/2fa/webauthn/register/finish",
      ...s,
      payload: bad,
    });
    // ۴۲۲ نه ۵۰۰ و نه ۴۰۱: کاربر **وارد شده** و فقط مراسم شکست خورده.
    // ۴۰۱ یعنی کلاینت او را از صفحه بیرون بیندازد؛ ۵۰۰ یعنی این شکست
    // شبیه خرابی سرور گزارش شود.
    assert.equal(first.statusCode, 422, first.body);
    assert.equal(JSON.parse(first.body).error.code, "bad_totp_setup");

    const second = await app.inject({
      method: "POST",
      url: "/auth/2fa/webauthn/register/finish",
      ...s,
      payload: bad,
    });
    assert.equal(JSON.parse(second.body).error.code, "pending_expired", second.body);

    const left = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM identity.webauthn_challenge
       WHERE user_id = ${ownerId}::uuid AND kind = 'register'
    `.execute(handle.db);
    assert.equal(left.rows[0]!.n, "0", "چالش باید مصرف شده باشد");
  });

  test("چالش منقضی پذیرفته نمی‌شود", async () => {
    await svc.beginRegistration({ userId: ownerId, username: owner, fullName: "صاحب کلید" });
    await sql`
      UPDATE identity.webauthn_challenge SET expires_at = now() - interval '1 second'
       WHERE user_id = ${ownerId}::uuid AND kind = 'register'
    `.execute(handle.db);
    await assert.rejects(
      () =>
        svc.finishRegistration({
          userId: ownerId,
          response: { id: "ساختگی", type: "public-key" },
        }),
      /مهلت/,
    );
  });

  // ── ۳. ورود ─────────────────────────────────────────────────────

  test("بدون کلید ثبت‌شده، مراسم ورود شروع نمی‌شود", async () => {
    await assert.rejects(() => svc.beginAuthentication(otherId), /کلیدی برای این حساب ثبت نشده/);
  });

  test("پاسخ خراب در ورود، خطای احراز است نه خرابی سرور", async () => {
    const id = credId("login");
    await fakeCredential(ownerId, id);
    await svc.beginAuthentication(ownerId);
    const ok = await svc.finishAuthentication({
      userId: ownerId,
      response: { id, rawId: id, type: "public-key", response: {} },
    });
    assert.equal(ok, false, "باید false برگردد، نه اینکه throw کند");
  });

  test("یک کلید ثبت‌شده، خودش عامل دوم را الزامی می‌کند", async () => {
    // این کاربر **هیچ TOTP ندارد**. اگر فقط TOTP الزام می‌آورد،
    // کاربری که فقط Passkey دارد بدون عامل دوم وارد می‌شد.
    const r = await login(owner);
    const out = JSON.parse(r.body) as { needsSecondFactor?: boolean; methods?: string[] };
    assert.equal(out.needsSecondFactor, true, "کلید ثبت‌شده باید عامل دوم بخواهد");
    assert.ok(out.methods?.includes("webauthn"), "روش باید webauthn باشد");
    assert.ok(
      !r.cookies.some((c) => c.name === "labelmod_session" && c.value.length > 0),
      "مرحله اول نباید نشست بسازد",
    );
  });

  test("مرحله دوم بدون بلیت، «مهلت تمام شده» می‌گیرد — نه ۵۰۰", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/auth/2fa/webauthn/begin",
      remoteAddress: nextIp(),
      payload: {},
    });
    assert.equal(r.statusCode, 401, r.body);
    assert.equal(JSON.parse(r.body).error.code, "pending_expired");
  });

  // ── ۴. فهرست، دامنه و حذف ───────────────────────────────────────

  test("فهرست کلیدها راز بیرون نمی‌دهد", async () => {
    const list = await svc.list(ownerId);
    assert.ok(list.length > 0);
    for (const c of list) {
      // مثل `identity.device_overview` که ستون راز را **ندارد**:
      // «حذفش می‌کنیم» تضمین نیست، نبودنش هست.
      assert.ok(!("publicKey" in c), "کلید عمومی در پاسخ نیست");
      assert.ok(!("public_key" in c), "کلید عمومی در پاسخ نیست");
      assert.ok(!("counter" in c), "شمارنده در پاسخ نیست");
    }
  });

  test("کلید کسِ دیگر حذف نمی‌شود", async () => {
    const victim = await fakeCredential(otherId, credId("victim"));
    await assert.rejects(
      () => svc.remove(ownerId, victim, ownerId),
      /برای شما ثبت نشده/,
      "دامنه باید روی user_id سنجیده شود، نه فقط روی شناسه سطر",
    );
    const still = await svc.list(otherId);
    assert.ok(
      still.some((c) => c.id === victim),
      "کلید قربانی باید سر جایش بماند",
    );
  });

  test("صاحب کلید، کلید خودش را حذف می‌کند", async () => {
    const mine = await fakeCredential(ownerId, credId("mine"));
    await svc.remove(ownerId, mine, ownerId);
    const list = await svc.list(ownerId);
    assert.ok(!list.some((c) => c.id === mine));
  });

  // ── ۵. مجوز و PIN ───────────────────────────────────────────────

  test("بدون نشست، هیچ‌کدام از مسیرهای مدیریت کلید باز نیستند", async () => {
    for (const [method, url] of [
      ["GET", "/auth/2fa/webauthn"],
      ["POST", "/auth/2fa/webauthn/register/begin"],
      ["POST", "/auth/2fa/webauthn/register/finish"],
    ] as const) {
      const r = await app.inject({ method, url, payload: {} });
      assert.equal(r.statusCode, 401, `${url} باید بسته باشد: ${r.body}`);
    }
  });

  test("نشستِ باز‌شده با PIN کلید ثبت نمی‌کند", async () => {
    // بند ۱ SECURITY.md: «PIN هرگز عملیات حساس را مجاز نمی‌کند».
    // ثبت یک عامل دوم تازه، حساس‌ترینشان است — کسی که تبلت باز را
    // پیدا کند نباید بتواند کلید خودش را اضافه کند.
    const s = await sessionOf(pinUser);
    await sql`
      UPDATE identity.session SET pin_unlocked = true
       WHERE user_id = ${pinUserId}::uuid AND revoked_at IS NULL
    `.execute(handle.db);

    for (const url of [
      "/auth/2fa/webauthn/register/begin",
      "/auth/2fa/webauthn/register/finish",
    ]) {
      const r = await app.inject({ method: "POST", url, ...s, payload: {} });
      assert.equal(r.statusCode, 403, `${url}: ${r.body}`);
      assert.equal(JSON.parse(r.body).error.code, "pin_not_allowed");
    }

    const del = await app.inject({
      method: "DELETE",
      url: `/auth/2fa/webauthn/${crypto.randomUUID()}`,
      ...s,
    });
    assert.equal(del.statusCode, 403, del.body);
  });
});
