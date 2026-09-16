import { loginWithMfa } from "./helpers/login-with-mfa.ts";
/**
 * تست یکپارچه مدیریت دستگاه و چرخه PIN — روی پستگرس واقعی.
 *
 * ادعای مرکزی: **چرخه قفل و بازشدن با PIN، از ابتدا تا انتها، بدون
 * یک خط psql کار می‌کند.**
 *
 * تا پیش از این، `identity.approve_device()` هیچ مسیر تولیدی نداشت.
 * تست‌های موجود آن را مستقیم با SQL صدا می‌زدند و سبز می‌شدند — که
 * دقیقاً همان چیزی است که «عبور تست واحد ≠ چرخه کامل» را نشان می‌دهد:
 * ادعا درست بود، محصول شکسته.
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

interface DeviceOut {
  id: string;
  fingerprint: string;
  label: string;
  isApproved: boolean;
  enrolled: boolean;
  activeSessions: number;
  approvedByName: string | null;
}

type Jar = { cookies: Record<string, string>; headers: Record<string, string> };

describe("مدیریت دستگاه و چرخه PIN", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let app: FastifyInstance;
  let auth: AuthService;

  const suffix = `dv${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-دستگاه-و-به‌قدر-کافی-بلند";
  const PIN = "8317";
  const admin = `dadmin_${suffix}`;
  const cashier = `dcash_${suffix}`;
  const ids: Record<string, string> = {};

  /**
   * IP ساختگی، یکی به‌ازای هر Fingerprint.
   *
   * ⚠️ بدون این، سقف نرخ ورود (۵ در دقیقه **بر IP**) کل تست را
   *    می‌شکست — و شکستنش درست بود: `app.inject` همه درخواست‌ها را از
   *    یک IP می‌فرستد، در حالی که در واقعیت هر تبلت IP خودش را دارد.
   *    پس به‌جای شل‌کردن دفاع، تست را واقعی‌تر می‌کنیم.
   */
  function ipFor(fingerprint: string): string {
    let h = 0;
    for (const ch of fingerprint) h = (h * 31 + ch.codePointAt(0)!) % 16_777_216;
    return `10.${(h >> 16) & 255}.${(h >> 8) & 255}.${(h & 255) || 1}`;
  }

  /** ورود کامل — کوکی نشست، CSRF و (اگر صادر شد) کوکی دستگاه. */
  async function login(username: string, fingerprint: string): Promise<Jar> {
    const r = await loginWithMfa(app, {
      method: "POST",
      url: "/auth/login",
      remoteAddress: ipFor(fingerprint),
      payload: { username, password: PASSWORD, deviceFingerprint: fingerprint },
    });
    assert.equal(r.statusCode, 200, `ورود ${username} ناموفق: ${r.body}`);
    return jarOf(r.cookies);
  }

  function jarOf(
    cookies: Array<{ name: string; value: string }>,
    previous?: Jar,
  ): Jar {
    const csrf =
      cookies.find((c) => c.name === "labelmod_csrf")?.value ??
      previous?.cookies["labelmod_csrf"] ??
      "";
    const device =
      cookies.find((c) => c.name === "labelmod_device")?.value ??
      previous?.cookies["labelmod_device"];
    return {
      cookies: {
        labelmod_session:
          cookies.find((c) => c.name === "labelmod_session")?.value ??
          previous?.cookies["labelmod_session"] ??
          "",
        labelmod_csrf: csrf,
        ...(device === undefined ? {} : { labelmod_device: device }),
      },
      headers: { "x-csrf-token": csrf },
    };
  }

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);
    auth = new AuthService(handle.db);

    const hash = await hashSecret(PASSWORD);
    const pinHash = await hashSecret(PIN);
    for (const [username, name, role] of [
      [admin, "مدیر دستگاه", "admin"],
      [cashier, "صندوق‌دار دستگاه", "cashier"],
    ] as const) {
      const u = await handle.db
        .insertInto("identity.app_user")
        .values({
          username,
          full_name: name,
          password_hash: hash,
          is_active: true,
          mobile: null,
          pin_hash: username === cashier ? pinHash : null,
          totp_secret: null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await handle.db
        .insertInto("identity.user_role")
        .values({ user_id: u.id, role_code: role, branch_id: BRANCH })
        .execute();
      ids[role] = u.id;
    }

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
    disposable?.drop();
  });

  // ── چرخه کامل ────────────────────────────────────────────────────────

  test("قفل و بازشدن با PIN — کل چرخه، بدون یک خط psql", async () => {
    const fp = `fp-${suffix}-full`;
    const a = await login(admin, `fp-${suffix}-admin`);

    // ۱. صندوق‌دار وارد می‌شود. دستگاه هنوز تأیید نشده.
    const c1 = await login(cashier, fp);

    const pending = await app.inject({
      method: "GET",
      url: "/devices?pending=true",
      ...a,
    });
    assert.equal(pending.statusCode, 200, pending.body);
    const found = (pending.json().devices as DeviceOut[]).find(
      (d) => d.fingerprint === fp,
    );
    assert.ok(found, "دستگاه ناشناس باید در فهرست انتظار دیده شود");
    assert.equal(found.isApproved, false);
    assert.equal(found.enrolled, false);

    // ۲. بدون تأیید، PIN باز نمی‌کند — همان چیزی که تا امروز همیشه بود
    await app.inject({ method: "POST", url: "/auth/lock", ...c1, payload: {} });
    const early = await app.inject({
      method: "POST",
      url: "/auth/unlock",
      ...c1,
      payload: { pin: PIN, deviceFingerprint: fp },
    });
    assert.notEqual(early.statusCode, 200, "PIN روی دستگاه تأییدنشده نباید باز کند");

    // ۳. مدیر تأیید می‌کند — گامی که تا امروز مسیر نداشت
    const approve = await app.inject({
      method: "POST",
      url: `/devices/${found.id}/approve`,
      ...a,
      payload: { label: "تبلت صندوق ۱" },
    });
    assert.equal(approve.statusCode, 200, approve.body);

    // ۴. ورود کامل تازه → راز ثبت‌نام صادر می‌شود (کوکی HttpOnly)
    const c2 = await login(cashier, fp);
    assert.ok(
      c2.cookies["labelmod_device"] !== undefined,
      "پس از تأیید، اولین ورود کامل باید راز دستگاه صادر کند",
    );

    // ۵. حالا قفل و بازکردن با PIN کار می‌کند
    const lock = await app.inject({
      method: "POST",
      url: "/auth/lock",
      ...c2,
      payload: {},
    });
    assert.equal(lock.statusCode, 200, lock.body);

    const unlock = await app.inject({
      method: "POST",
      url: "/auth/unlock",
      ...c2,
      payload: { pin: PIN, deviceFingerprint: fp },
    });
    assert.equal(unlock.statusCode, 200, `بازگشایی با PIN ناموفق: ${unlock.body}`);

    // ۶. و نشست بازشده با PIN، ارتقایافته نیست
    const jar = jarOf(unlock.cookies, c2);
    const me = await app.inject({ method: "GET", url: "/auth/me", ...jar });
    assert.equal(me.statusCode, 200, me.body);
    assert.equal(me.json().elevated, false, "نشست PIN ارتقایافته نیست");
  });

  // ── مجوز ─────────────────────────────────────────────────────────────

  test("صندوق‌دار نه دستگاه می‌بیند نه تأیید می‌کند", async () => {
    const c = await login(cashier, `fp-${suffix}-perm`);
    const a = await login(admin, `fp-${suffix}-admin2`);

    const list = await app.inject({ method: "GET", url: "/devices", ...c });
    assert.equal(list.statusCode, 403, `انتظار ۴۰۳ بود: ${list.body}`);

    const devices = (
      await app.inject({ method: "GET", url: "/devices", ...a })
    ).json().devices as DeviceOut[];
    const target = devices[0]!;

    const approve = await app.inject({
      method: "POST",
      url: `/devices/${target.id}/approve`,
      ...c,
      payload: {},
    });
    assert.equal(approve.statusCode, 403, `انتظار ۴۰۳ بود: ${approve.body}`);

    const sessions = await app.inject({ method: "GET", url: "/sessions", ...c });
    assert.equal(sessions.statusCode, 403);
  });

  test("نشست بازشده با PIN نمی‌تواند دستگاه تأیید کند — حتی برای مدیر", async () => {
    const fp = `fp-${suffix}-adminpin`;
    // مدیر هم PIN می‌گیرد تا این مسیر آزمودنی شود
    await handle.db
      .updateTable("identity.app_user")
      .set({ pin_hash: await hashSecret(PIN) })
      .where("id", "=", ids["admin"] as string)
      .execute();

    const a0 = await login(admin, `fp-${suffix}-admin3`);
    const first = await login(admin, fp);
    const devices = (
      await app.inject({ method: "GET", url: "/devices", ...a0 })
    ).json().devices as DeviceOut[];
    const own = devices.find((d) => d.fingerprint === fp);
    assert.ok(own);

    await app.inject({
      method: "POST",
      url: `/devices/${own.id}/approve`,
      ...a0,
      payload: {},
    });
    const enrolled = await login(admin, fp);

    await app.inject({ method: "POST", url: "/auth/lock", ...enrolled, payload: {} });
    const unlock = await app.inject({
      method: "POST",
      url: "/auth/unlock",
      ...enrolled,
      payload: { pin: PIN, deviceFingerprint: fp },
    });
    assert.equal(unlock.statusCode, 200, `بازگشایی ناموفق: ${unlock.body}`);
    const jar = jarOf(unlock.cookies, enrolled);

    // این ادعای امنیتی مرکزی است: کسی که فقط PIN را دارد نباید بتواند
    // دستگاه تازه‌ای را «مورد اعتماد» کند.
    const other = devices.find((d) => d.fingerprint !== fp);
    assert.ok(other);
    const attempt = await app.inject({
      method: "POST",
      url: `/devices/${other.id}/approve`,
      ...jar,
      payload: {},
    });
    assert.equal(
      attempt.statusCode,
      403,
      `نشست PIN نباید دستگاه تأیید کند: ${attempt.body}`,
    );

    // و پس از احراز کامل مجدد، می‌تواند
    const reauth = await app.inject({
      method: "POST",
      url: "/auth/reauth",
      ...jar,
      payload: { password: PASSWORD },
    });
    assert.equal(reauth.statusCode, 200, reauth.body);
    const after2 = await app.inject({
      method: "POST",
      url: `/devices/${other.id}/approve`,
      ...jar,
      payload: {},
    });
    assert.equal(after2.statusCode, 200, `پس از احراز مجدد باید بشود: ${after2.body}`);
    void first;
  });

  // ── ابطال ────────────────────────────────────────────────────────────

  test("ابطال دستگاه، نشست زنده‌اش را همان لحظه می‌بندد", async () => {
    const fp = `fp-${suffix}-revoke`;
    const a = await login(admin, `fp-${suffix}-admin4`);
    const c = await login(cashier, fp);

    // نشست زنده است
    const before1 = await app.inject({ method: "GET", url: "/auth/me", ...c });
    assert.equal(before1.statusCode, 200);

    const devices = (
      await app.inject({ method: "GET", url: "/devices", ...a })
    ).json().devices as DeviceOut[];
    const target = devices.find((d) => d.fingerprint === fp);
    assert.ok(target);
    assert.equal(target.activeSessions >= 1, true, "نشست زنده باید شمرده شود");

    const revoke = await app.inject({
      method: "POST",
      url: `/devices/${target.id}/revoke`,
      ...a,
      payload: { reason: "تبلت گم شد" },
    });
    assert.equal(revoke.statusCode, 200, revoke.body);
    assert.equal(revoke.json().sessionsRevoked >= 1, true);

    // همان توکن دیگر کار نمی‌کند
    const after2 = await app.inject({ method: "GET", url: "/auth/me", ...c });
    assert.notEqual(after2.statusCode, 200, "نشست دستگاه باطل‌شده باید بسته باشد");
  });

  test("«گوشیِ فلانی گم شد» — مدیر همه نشست‌های کاربر دیگر را می‌بندد", async () => {
    const a = await login(admin, `fp-${suffix}-admin5`);
    const c1 = await login(cashier, `fp-${suffix}-p1`);
    const c2 = await login(cashier, `fp-${suffix}-p2`);

    assert.equal(
      (await app.inject({ method: "GET", url: "/auth/me", ...c1 })).statusCode,
      200,
    );

    const out = await app.inject({
      method: "POST",
      url: `/users/${ids["cashier"]}/revoke-sessions`,
      ...a,
      payload: { reason: "گوشی گم شد" },
    });
    assert.equal(out.statusCode, 200, out.body);
    assert.equal(out.json().revoked >= 2, true, `انتظار ≥۲: ${out.body}`);

    for (const jar of [c1, c2]) {
      const r = await app.inject({ method: "GET", url: "/auth/me", ...jar });
      assert.notEqual(r.statusCode, 200, "هر دو نشست باید بسته باشند");
    }

    // و نشست خودِ مدیر دست‌نخورده مانده
    assert.equal(
      (await app.inject({ method: "GET", url: "/auth/me", ...a })).statusCode,
      200,
      "ابطال دسترسی یک کاربر نباید نشست مدیر را ببندد",
    );
  });

  test("صندوق‌دار نمی‌تواند دسترسی کسی را باطل کند", async () => {
    const c = await login(cashier, `fp-${suffix}-noperm`);
    const r = await app.inject({
      method: "POST",
      url: `/users/${ids["admin"]}/revoke-sessions`,
      ...c,
      payload: {},
    });
    assert.equal(r.statusCode, 403, `انتظار ۴۰۳ بود: ${r.body}`);
  });

  // ── راز دستگاه ───────────────────────────────────────────────────────

  test("راز دستگاه از هیچ پاسخی بیرون نمی‌رود", async () => {
    const a = await login(admin, `fp-${suffix}-leak`);

    const devices = await app.inject({ method: "GET", url: "/devices", ...a });
    assert.equal(devices.statusCode, 200);
    // ⚠️ ادعا روی **کلیدهای** پاسخ است، نه متن خام: یک Fingerprint که
    //    اتفاقاً کلمه secret داشته باشد، ادعای متنی را الکی قرمز می‌کند
    //    (و اولین نسخه همین کار را کرد).
    const keys = new Set<string>();
    for (const row of devices.json().devices as Array<Record<string, unknown>>) {
      for (const k of Object.keys(row)) keys.add(k);
    }
    for (const k of keys) {
      assert.doesNotMatch(
        k,
        /secret|hash|token/i,
        `کلید «${k}» نباید در پاسخ فهرست دستگاه باشد`,
      );
    }
    assert.ok(keys.has("enrolled"), "به‌جای راز، فقط «ثبت‌نام شده یا نه» می‌آید");

    const sessions = await app.inject({ method: "GET", url: "/sessions", ...a });
    assert.equal(sessions.statusCode, 200);
    const skeys = new Set<string>();
    for (const row of sessions.json().sessions as Array<Record<string, unknown>>) {
      for (const k of Object.keys(row)) skeys.add(k);
    }
    for (const k of skeys) {
      assert.doesNotMatch(k, /token|secret|hash/i, `کلید «${k}» نباید در پاسخ نشست باشد`);
    }

    // و نما اصلاً ستونش را ندارد
    const cols = await sql<{ n: string }>`
      SELECT count(*) AS n FROM information_schema.columns
       WHERE table_schema = 'identity' AND table_name = 'device_overview'
         AND column_name = 'secret_hash'`.execute(handle.db);
    assert.equal(cols.rows[0]!.n, "0");
  });

  test("فهرست نشست‌ها، نشست بازشده با PIN را علامت می‌زند", async () => {
    const a = await login(admin, `fp-${suffix}-list`);
    const r = await app.inject({ method: "GET", url: "/sessions", ...a });
    assert.equal(r.statusCode, 200, r.body);
    const rows = r.json().sessions as Array<{
      pinUnlocked: boolean;
      username: string;
      authMethod: string;
    }>;
    assert.ok(rows.length > 0);
    for (const s of rows) {
      assert.equal(typeof s.pinUnlocked, "boolean");
      assert.ok(typeof s.username === "string" && s.username.length > 0);
    }
  });

  // ── اعتبارسنجی ───────────────────────────────────────────────────────

  test("شناسه نامعتبر و دستگاه ناموجود، پیام درست می‌دهند", async () => {
    const a = await login(admin, `fp-${suffix}-valid`);

    const bad = await app.inject({
      method: "POST",
      url: "/devices/not-a-uuid/approve",
      ...a,
      payload: {},
    });
    assert.equal(bad.statusCode, 400, bad.body);

    const missing = await app.inject({
      method: "POST",
      url: "/devices/00000000-0000-7000-8000-0000000000ff/approve",
      ...a,
      payload: {},
    });
    assert.equal(missing.statusCode, 404, missing.body);
    assert.match(missing.json().error.message, /یافت نشد/);
  });

  test("برچسب دستگاه هنگام تأیید ثبت می‌شود", async () => {
    const fp = `fp-${suffix}-label`;
    const a = await login(admin, `fp-${suffix}-admin6`);
    await login(cashier, fp);

    const devices = (
      await app.inject({ method: "GET", url: "/devices", ...a })
    ).json().devices as DeviceOut[];
    const target = devices.find((d) => d.fingerprint === fp);
    assert.ok(target);

    await app.inject({
      method: "POST",
      url: `/devices/${target.id}/approve`,
      ...a,
      payload: { label: "تبلت انبار" },
    });

    const after2 = (
      await app.inject({ method: "GET", url: "/devices", ...a })
    ).json().devices as DeviceOut[];
    const updated = after2.find((d) => d.id === target.id);
    assert.equal(updated?.label, "تبلت انبار");
    assert.equal(updated?.isApproved, true);
    assert.ok(
      updated?.approvedByName !== null,
      "نام تأییدکننده باید در فهرست دیده شود",
    );
  });
});
