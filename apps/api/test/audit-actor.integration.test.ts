/**
 * لاگ حسابرسی باید **کاربر، زمان و دستگاه** را نشان دهد — معیار ۱۳.
 *
 * ── چرا این پرونده هست ──────────────────────────────────────────────
 *
 * معیار پذیرش ۱۳ سند: «هر عملیات حساس کاربر، زمان و **دستگاه** ثبت‌کننده
 * را نشان دهد.» ستون‌ها از روز اول بودند و `platform.set_actor` هم هر سه
 * را می‌گرفت — ولی پر نمی‌شدند. اندازه‌گیری روی یک دیتابیس واقعی:
 *
 *     action        n    ip NULL   device NULL
 *     session.open  21      0           0
 *     shift.open     1      1           1      ← و همهٔ مسیرهای مالی
 *
 * علتش **دو تعریف** از یک مفهوم بود:
 *
 *     lib/idempotency.ts  setActor(trx, userId, ip?, device?)
 *     db/actor.ts         setActor(trx, { userId, ip?, device? })
 *
 * نسخهٔ اول راحت‌تر است و ~۷۰ فراخوان در همهٔ ماژول‌های مالی فقط دو
 * آرگومان اول را می‌دادند. حالا `ip` و `device` از **زمینهٔ درخواست**
 * برداشته می‌شوند (`lib/request-context.ts`).
 *
 * ⚠️ این تست از راه **HTTP** می‌رود، نه با صدا زدن سرویس: زمینهٔ درخواست
 *    در Hook فستیفای ست می‌شود، پس تستی که سرویس را مستقیم صدا بزند
 *    چیزی را که مهم است نمی‌سنجد.
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
const STORE_WH = "00000000-0000-7000-8000-000000000101";
const SYSTEM_USER = "00000000-0000-7000-8000-0000000000f1";

describe("لاگ حسابرسی: کاربر، زمان، دستگاه", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let app: FastifyInstance;

  const suffix = `aa${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-حسابرسی-و-به‌قدر-کافی-بلند";
  const admin = `admin_${suffix}`;
  let variationId = "";
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
        full_name: "مدیر حسابرسی",
        password_hash: await hashSecret(PASSWORD),
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

    const prod = await sql<{ id: string }>`
      INSERT INTO catalog.product (code, name_internal)
      VALUES (${`P-${suffix}`}, 'کالای حسابرسی') RETURNING id`.execute(handle.db);
    const v = await sql<{ id: string }>`
      INSERT INTO catalog.variation (product_id, color, size, sku)
      VALUES (${prod.rows[0]!.id}, 'طوسی', 'M', ${`SKU-${suffix}`}) RETURNING id`
      .execute(handle.db);
    variationId = v.rows[0]!.id;
    await sql`INSERT INTO catalog.price (variation_id, price_list, amount)
              VALUES (${variationId}, 'default', 900000)`.execute(handle.db);
    await sql`SELECT platform.set_actor(${SYSTEM_USER}::uuid)`.execute(handle.db);
    await sql`SELECT inventory.apply_movement(
                ${variationId}::uuid, ${STORE_WH}::uuid, 20, 'purchase_receipt',
                NULL, NULL, ${SYSTEM_USER}::uuid, 500000)`.execute(handle.db);

    app = await buildApp({
      db: handle.db,
      auth: new AuthService(handle.db),
      config: loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" }),
    });
    await app.ready();

    const r = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: admin, password: PASSWORD, deviceFingerprint: `fp-${suffix}` },
      remoteAddress: "203.0.113.7",
    });
    assert.equal(r.statusCode, 200, r.body);
    const c = (n: string) => r.cookies.find((x) => x.name === n)?.value ?? "";
    cookies = { labelmod_session: c("labelmod_session"), labelmod_csrf: c("labelmod_csrf") };
    headers = { "x-csrf-token": c("labelmod_csrf") };
  });

  after(async () => {
    await app?.close();
    await handle?.close();
    disposable?.drop();
  });

  test("عملیات مالی از راه HTTP، IP و دستگاه را ثبت می‌کند", async () => {
    // باز کردن شیفت — یک عملیات مالی که **از مسیر `withActor` نمی‌رود**
    // و پیش از این هر دو ستونش NULL می‌شد.
    const r = await app.inject({
      method: "POST",
      url: "/shifts",
      cookies,
      headers,
      payload: { branchId: BRANCH, openingCash: "1000000" },
      remoteAddress: "203.0.113.7",
    });
    assert.equal(r.statusCode, 201, r.body);

    const row = await sql<{ ip: string | null; device: string | null; actor: string | null }>`
      SELECT host(ip) AS ip, device, actor_id::text AS actor
        FROM platform.audit_log WHERE action = 'shift.open'
       ORDER BY id DESC LIMIT 1`.execute(handle.db);
    const a = row.rows[0];
    assert.ok(a, "عملیات باید یک سطر حسابرسی بسازد");
    assert.ok(a.actor, "کاربر عامل باید ثبت شود");
    assert.equal(a.ip, "203.0.113.7", `IP باید ثبت شود، نه NULL: ${JSON.stringify(a)}`);
    assert.ok(a.device, `دستگاه باید ثبت شود، نه NULL: ${JSON.stringify(a)}`);
  });

  test("هیچ عملیات حساسی در این سناریو بی IP نمی‌ماند", async () => {
    // یک فروش کامل: چند عملیات مالی پشت سر هم، همه از راه HTTP.
    const inv = await app.inject({
      method: "POST",
      url: "/invoices",
      cookies,
      headers,
      payload: { branchId: BRANCH, warehouseId: STORE_WH, channel: "pos" },
      remoteAddress: "203.0.113.7",
    });
    assert.equal(inv.statusCode, 201, inv.body);
    const id = (inv.json() as { id: string }).id;
    await app.inject({
      method: "POST",
      url: `/invoices/${id}/lines`,
      cookies,
      headers,
      payload: { variationId, qty: "2" },
      remoteAddress: "203.0.113.7",
    });
    const view = await app.inject({ method: "GET", url: `/invoices/${id}`, cookies, headers });
    await app.inject({
      method: "POST",
      url: `/invoices/${id}/payments`,
      cookies,
      headers,
      payload: {
        methodCode: "cash",
        amount: (view.json() as { payableAmount: string }).payableAmount,
      },
      remoteAddress: "203.0.113.7",
    });
    const fin = await app.inject({
      method: "POST",
      url: `/invoices/${id}/finalize`,
      cookies,
      headers: { ...headers, "idempotency-key": `aa-${suffix}` },
      payload: {},
      remoteAddress: "203.0.113.7",
    });
    assert.equal(fin.statusCode, 200, fin.body);

    // ⚠️ ادعا روی **همهٔ** سطرهای حسابرسیِ این اجراست، نه یک سطر: یک
    //    مسیرِ جامانده دقیقاً همان چیزی است که این تست باید بگیرد.
    //    کاربر «سیستم» مستثناست — آماده‌سازی، بیرون از HTTP بود.
    const gaps = await sql<{ action: string; n: string }>`
      SELECT action, count(*)::text AS n FROM platform.audit_log
       WHERE (ip IS NULL OR device IS NULL)
         AND actor_id <> ${SYSTEM_USER}::uuid
       GROUP BY action ORDER BY action`.execute(handle.db);
    assert.deepEqual(
      gaps.rows,
      [],
      `این کنش‌ها IP یا دستگاه ندارند: ${JSON.stringify(gaps.rows)}`,
    );
  });

  test("بیرون از درخواست HTTP، NULL ماندن درست است", async () => {
    // Worker و CLI آدمی پشت مرورگر ندارند. ساختن یک IP جعلی برایشان
    // بدتر از نداشتنش است، پس این ادعا عمداً برعکسِ دو تست بالاست.
    // ⚠️ هر دو در **یک تراکنش**: `set_actor` با `is_local = true` ست
    //    می‌شود، پس بیرون از تراکنش به کوئری بعدی نمی‌رسد.
    await handle.db.transaction().execute(async (trx) => {
      await sql`SELECT platform.set_actor(${SYSTEM_USER}::uuid)`.execute(trx);
      await sql`SELECT platform.set_setting('return.window_hours', '72'::jsonb,
                  'آزمون بیرون از HTTP')`.execute(trx);
    });
    const row = await sql<{ ip: string | null; device: string | null }>`
      SELECT host(ip) AS ip, device FROM platform.audit_log
       WHERE action = 'setting.change' ORDER BY id DESC LIMIT 1`.execute(handle.db);
    assert.equal(row.rows[0]!.ip, null, "بیرون از HTTP نباید IP جعلی بنشیند");
    assert.equal(row.rows[0]!.device, null, "بیرون از HTTP نباید دستگاه جعلی بنشیند");
  });
});
