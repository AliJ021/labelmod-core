/**
 * تست یکپارچه مدیریت پرسنل و مشتری — روی پستگرس واقعی.
 *
 * سه ادعا که هر سه، شکستشان بی‌صداست:
 *
 * ۱. **راز از هیچ پاسخی بیرون نمی‌رود.** نه هش رمز، نه هش PIN، نه
 *    راز TOTP. اگر روزی یکی از این‌ها به `select` اضافه شود، هیچ
 *    خطایی نمی‌دهد — فقط در JSON می‌نشیند.
 *
 * ۲. **غیرفعال‌کردن همان لحظه اثر می‌کند.** بدون بستن نشست‌ها، کسی که
 *    اخراج شده تا ۱۲ ساعت دیگر داخل سیستم است.
 *
 * ۳. **کسی نمی‌تواند خودش را بیرون بیندازد.** مدیری که حساب خودش را
 *    غیرفعال کند، دیگر نمی‌تواند برش گرداند و تنها راه، SSH به سرور
 *    است.
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

interface UserJson {
  id: string;
  username: string;
  fullName: string;
  isActive: boolean;
  hasPin: boolean;
  hasTotp: boolean;
  roles: Array<{ roleCode: string; branchId: string | null }>;
  activeSessions: number;
}

describe("پرسنل و مشتری", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let app: FastifyInstance;

  const suffix = `u${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-مدیریت-کاربر-و-به‌قدر-کافی-بلند";
  const admin = `uadm_${suffix}`;
  const cashier = `ucash_${suffix}`;
  const supervisor = `usup_${suffix}`;
  let adminId = "";

  const sessions = new Map<
    string,
    { cookies: Record<string, string>; headers: Record<string, string> }
  >();

  /**
   * هر کاربر IP خودش را می‌گیرد.
   *
   * محدودیت نرخ ورود ۵ در دقیقه **بر IP** است. بدون این، تست‌هایی که
   * چند کاربر می‌سازند و وارد می‌شوند، به سقف می‌خوردند — و آن یک
   * دفاع واقعی است که نباید برای راحتی تست ضعیف شود.
   */
  function ipFor(name: string): string {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 250;
    return `10.9.${Math.floor(h / 250) + 1}.${(h % 250) + 2}`;
  }

  async function loginAs(username: string, password = PASSWORD) {
    const cached = sessions.get(username);
    if (cached) return cached;
    const r = await app.inject({
      method: "POST",
      url: "/auth/login",
      remoteAddress: ipFor(username),
      payload: { username, password, deviceFingerprint: `fp-${suffix}-${username}` },
    });
    assert.equal(r.statusCode, 200, `ورود ${username} ناموفق: ${r.body}`);
    const csrf = r.cookies.find((c) => c.name === "labelmod_csrf")?.value ?? "";
    const out = {
      cookies: {
        labelmod_session: r.cookies.find((c) => c.name === "labelmod_session")?.value ?? "",
        labelmod_csrf: csrf,
      },
      headers: { "x-csrf-token": csrf },
    };
    sessions.set(username, out);
    return out;
  }

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);

    const hash = await hashSecret(PASSWORD);
    for (const [username, name, role] of [
      [admin, "مدیر پرسنل", "admin"],
      [cashier, "صندوق‌دار پرسنل", "cashier"],
      [supervisor, "سرپرست پرسنل", "supervisor"],
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
        .values({ user_id: u.id, role_code: role, branch_id: BRANCH })
        .execute();
      if (role === "admin") adminId = u.id;
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

  // ── پرسنل ──────────────────────────────────────────────────────

  test("صندوق‌دار فهرست پرسنل را نمی‌بیند", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/users",
      ...(await loginAs(cashier)),
    });
    assert.equal(r.statusCode, 403, r.body);
  });

  test("فهرست پرسنل هیچ رازی برنمی‌گرداند", async () => {
    // **ادعای مرکزی.** اگر روزی `password_hash` به select اضافه شود،
    // هیچ خطایی نمی‌دهد — فقط در JSON می‌نشیند.
    const r = await app.inject({
      method: "GET",
      url: "/users",
      ...(await loginAs(admin)),
    });
    assert.equal(r.statusCode, 200, r.body);
    const raw = r.body;
    for (const secret of ["password_hash", "passwordHash", "pin_hash", "pinHash", "totp"]) {
      assert.equal(raw.includes(secret), false, `«${secret}» نباید در پاسخ باشد`);
    }
    const list = (JSON.parse(raw) as { users: UserJson[] }).users;
    assert.ok(list.length >= 3);
    // ولی «دارد یا ندارد» برمی‌گردد — که یک واقعیت است، نه یک راز.
    assert.equal(typeof list[0]?.hasPin, "boolean");
  });

  test("ساخت کاربر: رمز یک بار برمی‌گردد و با همان می‌شود وارد شد", async () => {
    const s = await loginAs(admin);
    const username = `new_${suffix}`;
    const r = await app.inject({
      method: "POST",
      url: "/users",
      ...s,
      payload: {
        username,
        fullName: "کاربر تازه",
        roles: [{ roleCode: "cashier", branchId: BRANCH }],
      },
    });
    assert.equal(r.statusCode, 201, r.body);
    const out = JSON.parse(r.body) as { id: string; password: string };
    assert.ok(out.password.length >= 16, "رمز باید بلند باشد");

    // رمز واقعاً کار می‌کند — یعنی هش درست نوشته شده.
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      remoteAddress: ipFor(username),
      payload: { username, password: out.password, deviceFingerprint: `fp-${username}` },
    });
    assert.equal(login.statusCode, 200, login.body);

    // و از هیچ مسیری دوباره خواندنی نیست.
    const again = await app.inject({ method: "GET", url: `/users/${out.id}`, ...s });
    assert.equal(again.statusCode, 200);
    assert.equal(again.body.includes(out.password), false, "رمز نباید دوباره برگردد");
  });

  test("نام کاربری تکراری و نام کاربری فارسی رد می‌شوند", async () => {
    const s = await loginAs(admin);
    const dup = await app.inject({
      method: "POST",
      url: "/users",
      ...s,
      payload: {
        username: admin,
        fullName: "تکراری",
        roles: [{ roleCode: "cashier", branchId: BRANCH }],
      },
    });
    assert.equal(dup.statusCode, 409, dup.body);

    const fa = await app.inject({
      method: "POST",
      url: "/users",
      ...s,
      payload: {
        username: "علی",
        fullName: "نام فارسی",
        roles: [{ roleCode: "cashier", branchId: BRANCH }],
      },
    });
    // نام کاربری فارسی یعنی کاربری که نمی‌داند دقیقاً چه تایپ کند.
    assert.equal(fa.statusCode, 400, fa.body);
  });

  test("نقش ناموجود، ۴۲۲ فارسی می‌گیرد نه خطای کلید خارجی", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/users",
      ...(await loginAs(admin)),
      payload: {
        username: `bad_${suffix}`,
        fullName: "نقش غلط",
        roles: [{ roleCode: "wizard", branchId: BRANCH }],
      },
    });
    assert.equal(r.statusCode, 422, r.body);
    assert.match(JSON.parse(r.body).error.message as string, /نقش/);
  });

  test("غیرفعال‌کردن، نشست‌های کاربر را همان لحظه می‌بندد", async () => {
    const s = await loginAs(admin);
    const username = `fired_${suffix}`;
    const created = await app.inject({
      method: "POST",
      url: "/users",
      ...s,
      payload: {
        username,
        fullName: "کاربر اخراجی",
        roles: [{ roleCode: "cashier", branchId: BRANCH }],
      },
    });
    const { id, password } = JSON.parse(created.body) as { id: string; password: string };

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      remoteAddress: ipFor(username),
      payload: { username, password, deviceFingerprint: `fp-${username}` },
    });
    assert.equal(login.statusCode, 200);
    const cookie = login.cookies.find((c) => c.name === "labelmod_session")?.value ?? "";

    const before = await app.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { labelmod_session: cookie },
    });
    assert.equal(before.statusCode, 200, "پیش از غیرفعال‌سازی، نشست کار می‌کند");

    const off = await app.inject({
      method: "PATCH",
      url: `/users/${id}`,
      ...s,
      payload: { isActive: false },
    });
    assert.equal(off.statusCode, 200, off.body);

    // **بدون این، کسی که اخراج شده تا ۱۲ ساعت دیگر داخل سیستم است.**
    const after2 = await app.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { labelmod_session: cookie },
    });
    assert.equal(after2.statusCode, 401, "نشست باید همان لحظه بسته شود");
  });

  test("مدیر نمی‌تواند حساب خودش را غیرفعال کند", async () => {
    const r = await app.inject({
      method: "PATCH",
      url: `/users/${adminId}`,
      ...(await loginAs(admin)),
      payload: { isActive: false },
    });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(JSON.parse(r.body).error.code, "self_deactivate");
  });

  test("تغییر رمز، نشست‌های قبلی را می‌بندد", async () => {
    const s = await loginAs(admin);
    const username = `reset_${suffix}`;
    const created = await app.inject({
      method: "POST",
      url: "/users",
      ...s,
      payload: {
        username,
        fullName: "کاربر رمز",
        roles: [{ roleCode: "cashier", branchId: BRANCH }],
      },
    });
    const { id, password } = JSON.parse(created.body) as { id: string; password: string };
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      remoteAddress: ipFor(username),
      payload: { username, password, deviceFingerprint: `fp-${username}` },
    });
    const cookie = login.cookies.find((c) => c.name === "labelmod_session")?.value ?? "";

    const reset = await app.inject({
      method: "POST",
      url: `/users/${id}/reset-password`,
      ...s,
      payload: {},
    });
    assert.equal(reset.statusCode, 200, reset.body);
    const fresh = (JSON.parse(reset.body) as { password: string }).password;
    assert.notEqual(fresh, password);

    // اگر دلیل تغییر رمز نشت بوده، نگه‌داشتن نشست‌ها یعنی اصلاح بی‌اثر.
    const old = await app.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { labelmod_session: cookie },
    });
    assert.equal(old.statusCode, 401, "نشست قبلی باید بسته شده باشد");
  });

  test("نقش‌ها مطلق‌اند: فهرست تازه جای قبلی می‌نشیند", async () => {
    const s = await loginAs(admin);
    const created = await app.inject({
      method: "POST",
      url: "/users",
      ...s,
      payload: {
        username: `roles_${suffix}`,
        fullName: "کاربر نقش",
        roles: [{ roleCode: "cashier", branchId: BRANCH }],
      },
    });
    const { id } = JSON.parse(created.body) as { id: string };

    const put = await app.inject({
      method: "PUT",
      url: `/users/${id}/roles`,
      ...s,
      payload: { roles: [{ roleCode: "warehouse", branchId: BRANCH }] },
    });
    assert.equal(put.statusCode, 200, put.body);
    const after2 = JSON.parse(put.body) as UserJson;
    assert.equal(after2.roles.length, 1, "نقش قبلی برداشته شد، نه اینکه اضافه شود");
    assert.equal(after2.roles[0]?.roleCode, "warehouse");

    // کاربر بدون نقش نمی‌ماند.
    const empty = await app.inject({
      method: "PUT",
      url: `/users/${id}/roles`,
      ...s,
      payload: { roles: [] },
    });
    assert.equal(empty.statusCode, 400, empty.body);
  });

  test("نقش «همه شعبه‌ها» را کسی که دامنه‌اش یک شعبه است نمی‌دهد", async () => {
    // ارتقای دامنه: کاربر شعبه‌ای نباید بتواند کاربری با دسترسی کامل
    // بسازد و از راه او چیزی را ببیند که خودش حق دیدنش را ندارد.
    //
    // کاربر مدیرِ این تست به شعبه بند است، پس `branchId: null` باید
    // رد شود — حتی با داشتن `user.manage`.
    const r = await app.inject({
      method: "POST",
      url: "/users",
      ...(await loginAs(admin)),
      payload: {
        username: `god_${suffix}`,
        fullName: "دسترسی کامل",
        roles: [{ roleCode: "admin", branchId: null }],
      },
    });
    assert.equal(r.statusCode, 403, r.body);
    assert.equal(JSON.parse(r.body).error.code, "scope_escalation");
  });

  test("PIN تعیین و برداشته می‌شود، و خودش هرگز برنمی‌گردد", async () => {
    const s = await loginAs(admin);
    const created = await app.inject({
      method: "POST",
      url: "/users",
      ...s,
      payload: {
        username: `pin_${suffix}`,
        fullName: "کاربر PIN",
        roles: [{ roleCode: "cashier", branchId: BRANCH }],
      },
    });
    const { id } = JSON.parse(created.body) as { id: string };

    const set = await app.inject({
      method: "PUT",
      url: `/users/${id}/pin`,
      ...s,
      payload: { pin: "4271" },
    });
    assert.equal(set.statusCode, 200, set.body);

    const after2 = await app.inject({ method: "GET", url: `/users/${id}`, ...s });
    const u = JSON.parse(after2.body) as UserJson;
    assert.equal(u.hasPin, true, "«دارد» برمی‌گردد");

    // ⚠️ زیررشته‌جویی روی **کل بدنه** برای یک PIN چهاررقمی گاه‌به‌گاه
    //    شکست می‌دهد، و شکستش هیچ ربطی به نشت ندارد: بدنه نام کاربری
    //    را دارد، نام کاربری از `Date.now()` ساخته می‌شود، و هر وقت آن
    //    رشتهٔ رقمی اتفاقاً «4271» را در خودش داشته باشد ادعا قرمز
    //    می‌شود. اثبات شد — با `suffix = u4271…` این تست شکست، بی‌آنکه
    //    چیزی لو رفته باشد.
    //
    //    برای رازِ پرآنتروپی (بالاتر، ۲۴ بایت تصادفی) زیررشته درست است
    //    چون برخورد عملاً ممکن نیست. برای چهار رقم نیست.
    //
    //    تستی که فقط گاهی پاس شود خودش یک نقص است، نه یک مزاحمت.
    const leaks: string[] = [];
    const scan = (node: unknown, path: string): void => {
      if (typeof node === "string" || typeof node === "number") {
        if (String(node) === "4271") leaks.push(path);
      } else if (Array.isArray(node)) {
        node.forEach((v, i) => scan(v, `${path}[${i}]`));
      } else if (node !== null && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          if (/pin/i.test(k) && k !== "hasPin") leaks.push(`${path}.${k} (کلید)`);
          scan(v, `${path}.${k}`);
        }
      }
    };
    scan(u, "user");
    assert.deepEqual(leaks, [], `خودِ PIN یا کلید PIN در پاسخ: ${leaks.join(", ")}`);

    const clear = await app.inject({
      method: "PUT",
      url: `/users/${id}/pin`,
      ...s,
      payload: { pin: null },
    });
    assert.equal(clear.statusCode, 200, clear.body);
    const gone = await app.inject({ method: "GET", url: `/users/${id}`, ...s });
    assert.equal((JSON.parse(gone.body) as UserJson).hasPin, false);

    // PIN سه‌رقمی رد می‌شود.
    const short = await app.inject({
      method: "PUT",
      url: `/users/${id}/pin`,
      ...s,
      payload: { pin: "123" },
    });
    assert.equal(short.statusCode, 400, short.body);
  });

  // ── مشتری ──────────────────────────────────────────────────────

  test("شماره تکراری، مشتری دوم نمی‌سازد", async () => {
    // **ادعای مرکزی مشتری.** اگر جدا بود، مشتری‌ای که یک بار آنلاین و
    // یک بار حضوری خرید کند دو حساب داشت و مانده‌اش بین آن دو گم
    // می‌شد.
    const s = await loginAs(supervisor);
    const first = await app.inject({
      method: "POST",
      url: "/customers",
      ...s,
      payload: { mobile: "09121234567", fullName: "مشتری تست" },
    });
    assert.equal(first.statusCode, 201, first.body);
    const a = JSON.parse(first.body) as { id: string; created: boolean; mobile: string };
    assert.equal(a.created, true);

    // همان شماره با شکل دیگر — نرمال‌سازی در دیتابیس.
    const second = await app.inject({
      method: "POST",
      url: "/customers",
      ...s,
      payload: { mobile: "+989121234567" },
    });
    assert.equal(second.statusCode, 200, second.body);
    const b = JSON.parse(second.body) as { id: string; created: boolean };
    assert.equal(b.created, false, "پیدا شد، ساخته نشد");
    assert.equal(b.id, a.id, "همان مشتری");
  });

  test("نام موجود با یک تایپ عجله‌ای بازنویسی نمی‌شود", async () => {
    const s = await loginAs(supervisor);
    const again = await app.inject({
      method: "POST",
      url: "/customers",
      ...s,
      payload: { mobile: "09121234567", fullName: "اسم اشتباه" },
    });
    assert.equal(again.statusCode, 200);
    assert.equal(
      (JSON.parse(again.body) as { fullName: string }).fullName,
      "مشتری تست",
      "نام قبلی سر جایش می‌ماند؛ ویرایش مسیر خودش را دارد",
    );
  });

  test("جست‌وجو سمت سرور است و با شماره و نام کار می‌کند", async () => {
    const s = await loginAs(supervisor);
    for (const q of ["0912123", "مشتری تست"]) {
      const r = await app.inject({
        method: "GET",
        url: `/customers?q=${encodeURIComponent(q)}`,
        ...s,
      });
      assert.equal(r.statusCode, 200, r.body);
      const rows = (JSON.parse(r.body) as { customers: Array<{ mobile: string }> }).customers;
      assert.ok(
        rows.some((c) => c.mobile.includes("9121234567")),
        `جست‌وجوی «${q}» باید مشتری را پیدا کند`,
      );
    }
  });

  test("سقف اعتبار و رضایت، ردّ حسابرسی می‌گذارند", async () => {
    const s = await loginAs(supervisor);
    const list = await app.inject({ method: "GET", url: "/customers?q=0912123", ...s });
    const id = (JSON.parse(list.body) as { customers: Array<{ id: string }> }).customers[0]!.id;

    const patch = await app.inject({
      method: "PATCH",
      url: `/customers/${id}`,
      ...s,
      payload: { creditLimit: "5000000", consentSms: true, consentMarketing: false },
    });
    assert.equal(patch.statusCode, 200, patch.body);
    const c = JSON.parse(patch.body) as {
      creditLimit: string;
      consentSms: boolean;
      consentMarketing: boolean;
    };
    assert.equal(c.creditLimit, "5000000", "پول در JSON رشته است");
    assert.equal(c.consentSms, true);
    assert.equal(c.consentMarketing, false, "رضایت پیامک و تبلیغات جدا هستند");

    const audit = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM platform.audit_log
       WHERE action = 'customer.update' AND entity_id = ${id}
    `.execute(handle.db);
    assert.equal(Number(audit.rows[0]!.n), 1, "تغییر سقف اعتبار ردّ حسابرسی دارد");
  });

  test("انباردار پرونده مشتری را نمی‌بیند", async () => {
    const s = await loginAs(admin);
    const created = await app.inject({
      method: "POST",
      url: "/users",
      ...s,
      payload: {
        username: `wh_${suffix}`,
        fullName: "انباردار",
        roles: [{ roleCode: "warehouse", branchId: BRANCH }],
      },
    });
    const { password } = JSON.parse(created.body) as { password: string };
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      remoteAddress: ipFor(`wh_${suffix}`),
      payload: {
        username: `wh_${suffix}`,
        password,
        deviceFingerprint: `fp-wh-${suffix}`,
      },
    });
    const cookie = login.cookies.find((c) => c.name === "labelmod_session")?.value ?? "";
    const r = await app.inject({
      method: "GET",
      url: "/customers",
      cookies: { labelmod_session: cookie },
    });
    assert.equal(r.statusCode, 403, r.body);
  });

  // ═══════════════════════════════════════════════════════════════════
  // شناسنامه مشتری
  // ═══════════════════════════════════════════════════════════════════

  const customerId = async (sess: Awaited<ReturnType<typeof loginAs>>) => {
    const list = await app.inject({ method: "GET", url: "/customers?q=0912123", ...sess });
    return (JSON.parse(list.body) as { customers: Array<{ id: string }> }).customers[0]!.id;
  };

  test("نشانی و کد پستی روی پرونده می‌نشینند — کد پستی نرمال‌شده", async () => {
    const s = await loginAs(supervisor);
    const id = await customerId(s);
    const r = await app.inject({
      method: "PATCH",
      url: `/customers/${id}`,
      ...s,
      // رقم فارسی با خط تیره — همان چیزی که صفحه‌کلید فارسی می‌فرستد.
      payload: {
        address: "تهران، خیابان نمونه، پلاک ۱",
        postalCode: "۱۲۳۴۵-۶۷۸۹۰",
        city: "تهران",
        province: "تهران",
      },
    });
    assert.equal(r.statusCode, 200, r.body);
    const c = JSON.parse(r.body) as { postalCode: string; city: string; address: string };
    assert.equal(c.postalCode, "1234567890", "کد پستی باید در دیتابیس نرمال شود");
    assert.equal(c.city, "تهران");
    assert.match(c.address, /پلاک/);
  });

  test("کد پستی نُه‌رقمی ۴۲۲ می‌گیرد، نه اینکه نصفه ذخیره شود", async () => {
    // کد پستی نصفه یعنی برچسب پستی غلط چاپ شود و بسته برنگردد —
    // بدتر از خالی بودنش.
    const s = await loginAs(supervisor);
    const id = await customerId(s);
    const r = await app.inject({
      method: "PATCH",
      url: `/customers/${id}`,
      ...s,
      payload: { postalCode: "123456789" },
    });
    assert.equal(r.statusCode, 422, r.body);

    // و مقدار قبلی دست‌نخورده مانده.
    const after = await app.inject({ method: "GET", url: `/customers/${id}`, ...s });
    const c = (JSON.parse(after.body) as { customer: { postalCode: string } }).customer;
    assert.equal(c.postalCode, "1234567890", "ردِ اعتبارسنجی نباید مقدار قبلی را پاک کند");
  });

  test("کد پستی خالی یعنی پاک کردن، نه خطا", async () => {
    const s = await loginAs(supervisor);
    const id = await customerId(s);
    const r = await app.inject({
      method: "PATCH", url: `/customers/${id}`, ...s, payload: { postalCode: null },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal((JSON.parse(r.body) as { postalCode: string | null }).postalCode, null);
  });

  test("کلیدهای اندازه از دیتابیس می‌آیند، با برچسب و بازه", async () => {
    const s = await loginAs(supervisor);
    const r = await app.inject({ method: "GET", url: "/measure-keys", ...s });
    assert.equal(r.statusCode, 200, r.body);
    const keys = (JSON.parse(r.body) as {
      keys: Array<{ key: string; label: string; minValue: string; groupKey: string }>;
    }).keys;
    assert.ok(keys.length >= 13, `انتظار دست‌کم ۱۳ کلید، واقعی ${keys.length}`);
    // سه گروهی که مالک نام برد: پا، پایین‌تنه، بالاتنه.
    const groups = new Set(keys.map((k) => k.groupKey));
    for (const g of ["foot", "lower", "upper"]) {
      assert.ok(groups.has(g), `گروه «${g}» باید باشد`);
    }
    const height = keys.find((k) => k.key === "height");
    assert.ok(height, "کلید قد باید باشد");
    assert.equal(height.label, "قد", "برچسب فارسی از دیتابیس می‌آید، نه از React");
  });

  test("اندازه‌ها ثبت و کامل جایگزین می‌شوند", async () => {
    const s = await loginAs(supervisor);
    const id = await customerId(s);

    const put = await app.inject({
      method: "PUT",
      url: `/customers/${id}/measures`,
      ...s,
      payload: { values: { height: 178, chest: 102, inseam: 81, shoe_size: 43 } },
    });
    assert.equal(put.statusCode, 200, put.body);
    assert.equal(
      (JSON.parse(put.body) as { measures: unknown[] }).measures.length, 4);

    // جایگزینی کامل، نه ادغام: فرمی که یک اندازه را پاک می‌کند باید
    // واقعاً پاکش کند.
    const again = await app.inject({
      method: "PUT", url: `/customers/${id}/measures`, ...s,
      payload: { values: { height: 180 } },
    });
    assert.equal(again.statusCode, 200, again.body);
    const m = (JSON.parse(again.body) as { measures: Array<{ key: string; valueCm: string }> })
      .measures;
    assert.equal(m.length, 1, "اندازه‌های قبلی باید رفته باشند");
    assert.equal(m[0]!.key, "height");
  });

  test("اندازه بیرون بازه ۴۰۹ می‌گیرد و پیامش فارسی است", async () => {
    // نگهبان دیتابیس ۴۰۹ می‌دهد نه ۵۰۰ — دفاعی که شبیه خرابی سرور
    // گزارش شود، در عمل خاموش است.
    const s = await loginAs(supervisor);
    const id = await customerId(s);
    const r = await app.inject({
      method: "PUT", url: `/customers/${id}/measures`, ...s,
      payload: { values: { height: 17 } },
    });
    assert.equal(r.statusCode, 409, r.body);
    assert.match(r.body, /بازه مجاز/, "پیام باید فارسی و برای کاربر باشد");
  });

  test("کلید اندازه تعریف‌نشده رد می‌شود", async () => {
    const s = await loginAs(supervisor);
    const id = await customerId(s);
    const r = await app.inject({
      method: "PUT", url: `/customers/${id}/measures`, ...s,
      payload: { values: { wrist: 18 } },
    });
    assert.equal(r.statusCode, 409, r.body);
  });

  test("اندازه پشت همان دروازه پرونده مشتری است", async () => {
    // صندوق‌دار `customer.manage` ندارد — پس نه پرونده می‌بیند و نه
    // اندازه. اگر روزی این دو دروازه از هم جدا شوند، همین‌جا قرمز
    // می‌شود و آن یک تصمیم آگاهانه خواهد بود، نه یک لغزش.
    const s = await loginAs(cashier);
    for (const url of ["/measure-keys", "/customers"]) {
      const r = await app.inject({ method: "GET", url, ...s });
      assert.equal(r.statusCode, 403, `${url}: ${r.body}`);
    }
  });

  test("پیشنهاد سایز — کالای بدون اندازه حذف نمی‌شود", async () => {
    const s = await loginAs(supervisor);
    const id = await customerId(s);
    await app.inject({
      method: "PUT", url: `/customers/${id}/measures`, ...s,
      payload: { values: { chest: 100, waist: 84 } },
    });

    // ⚠️ تست باید داده‌اش را خودش بسازد.
    //
    // بدون موجودی، فهرست قانوناً خالی است و ادعای «حذف نمی‌شود»
    // روی هیچ اجرا می‌شد — یک تست که خودش را گول می‌زند. پس دو
    // تنوع ساخته می‌شود: یکی با اندازه، یکی **بدون**؛ و هر دو با
    // موجودی، از راه رسید خرید که تنها مسیر ورود کالاست.
    await sql`
      DO $fit$
      DECLARE v_wh uuid; v_sup uuid; v_p uuid; v_a uuid; v_b uuid;
              v_r uuid; v_u uuid; v_br uuid;
      BEGIN
        SELECT id INTO v_wh FROM inventory.warehouse
         WHERE kind = 'store' LIMIT 1;
        SELECT id INTO v_u FROM identity.app_user WHERE username = 'system';
        PERFORM platform.set_actor(v_u, NULL, NULL);

        INSERT INTO purchasing.supplier (code, name)
        VALUES ('S-FITAPI', 'تأمین تست تناسب')
        ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
        RETURNING id INTO v_sup;

        INSERT INTO catalog.product (code, name_internal)
        VALUES ('P-FITAPI', 'پیراهن تست تناسب') RETURNING id INTO v_p;
        INSERT INTO catalog.variation (product_id, color, size, sku)
        VALUES (v_p, 'سفید', 'M', 'FITAPI-M') RETURNING id INTO v_a;
        INSERT INTO catalog.variation (product_id, color, size, sku)
        VALUES (v_p, 'سفید', 'S', 'FITAPI-S') RETURNING id INTO v_b;

        -- فقط یکی اندازه دارد. دیگری عمداً ندارد.
        INSERT INTO catalog.variation_measure (variation_id, key, value_cm)
        VALUES (v_a, 'chest', 100), (v_a, 'waist', 84);

        SELECT branch_id INTO v_br FROM inventory.warehouse WHERE id = v_wh;
        INSERT INTO purchasing.receipt (number, branch_id, supplier_id, warehouse_id, occurred_at)
        VALUES (platform.next_document_no(v_br, 'purchase', 1405::smallint),
                v_br, v_sup, v_wh, now())
        RETURNING id INTO v_r;
        INSERT INTO purchasing.receipt_line (receipt_id, variation_id, qty, unit_price, line_amount)
        VALUES (v_r, v_a, 3, 300000, 900000), (v_r, v_b, 3, 300000, 900000);
        PERFORM purchasing.post_receipt(v_r, v_u);
      END $fit$;
    `.execute(handle.db);

    const r = await app.inject({ method: "GET", url: `/customers/${id}/fitting`, ...s });
    assert.equal(r.statusCode, 200, r.body);
    const rows = (JSON.parse(r.body) as {
      variations: Array<{ sku: string; matchScore: number | null; matchedKeys: number }>;
    }).variations;

    // ⚠️ ادعای مرکزی: کالاهای بدون اندازه هم می‌آیند، با
    // `matchScore: null`. اگر حذف می‌شدند، فروشگاه نصف ویترینش را
    // نشان نمی‌داد چون انباردار هنوز اندازه‌ها را وارد نکرده.
    assert.ok(rows.length > 0, "فهرست نباید خالی باشد");
    assert.ok(
      rows.some((x) => x.matchScore === null),
      "کالای بدون اندازه باید با matchScore=null بیاید، نه حذف شود",
    );

    // و NULLها آخر می‌نشینند، نه اول.
    const firstNull = rows.findIndex((x) => x.matchScore === null);
    const lastScored = rows.map((x) => x.matchScore !== null).lastIndexOf(true);
    if (firstNull >= 0 && lastScored >= 0) {
      assert.ok(firstNull > lastScored, "کالای بی‌اندازه باید آخر فهرست باشد");
    }
  });

  test("پیشنهاد سایز پشت همان دروازه پرونده مشتری است", async () => {
    const s = await loginAs(cashier);
    const r = await app.inject({
      method: "GET",
      url: "/customers/00000000-0000-7000-8000-000000000001/fitting",
      ...s,
    });
    assert.equal(r.statusCode, 403, r.body);
  });
});
