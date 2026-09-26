import { loginWithMfa } from "./helpers/login-with-mfa.ts";
/**
 * تست یکپارچه سفارش خرید — روی پستگرس واقعی.
 *
 * ادعای مرکزی: **سفارش هیچ اثر مالی و انباری ندارد.**
 *
 * و مسیر عملیاتی که بدون آن سفارش بی‌فایده است: «محموله این سفارش
 * رسید» → پیش‌نویس رسید از روی باقی‌مانده → ثبت → پیشرفت سفارش جلو
 * می‌رود.
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

interface OrderBody {
  id: string;
  number: string | null;
  status: string;
  orderedAmount: string;
  lines: {
    id: string;
    variationId: string;
    qty: string;
    unitPrice: string;
    receivedQty: string;
    remainingQty: string;
    overQty: string;
  }[];
}

interface ReceiptBody {
  id: string;
  number: string | null;
  status: string;
  orderId: string | null;
  orderNumber: string | null;
  goodsAmount: string;
  lines: { id: string; qty: string; unitPrice: string }[];
}

describe("سفارش خرید", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;
  let app: FastifyInstance;

  const suffix = `po${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const PASSWORD = "رمز-سفارش-خرید-و-به‌قدر-کافی-بلند";
  const keeper = `pokeeper_${suffix}`;

  let supplierId = "";
  let variationA = "";
  let variationB = "";

  const sessions = new Map<
    string,
    { cookies: Record<string, string>; headers: Record<string, string> }
  >();

  async function loginAs(username: string) {
    const cached = sessions.get(username);
    if (cached) return cached;
    const r = await loginWithMfa(app, {
      method: "POST",
      url: "/auth/login",
      payload: { username, password: PASSWORD, deviceFingerprint: `fp-${suffix}-${username}` },
    });
    assert.equal(r.statusCode, 200, `ورود ناموفق: ${r.body}`);
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

  /** یک سفارش فرستاده‌شده با دو قلم. */
  async function sentOrder(): Promise<OrderBody> {
    const s = await loginAs(keeper);
    const created = await app.inject({
      method: "POST",
      url: "/purchase-orders",
      ...s,
      payload: { branchId: BRANCH, supplierId, warehouseId: STORE_WH },
    });
    assert.equal(created.statusCode, 201, created.body);
    const id = (created.json() as OrderBody).id;

    for (const [variationId, qty, price] of [
      [variationA, "10", "1000000"],
      [variationB, "5", "2000000"],
    ] as const) {
      const r = await app.inject({
        method: "PUT",
        url: `/purchase-orders/${id}/lines`,
        ...s,
        payload: { variationId, qty, unitPrice: price },
      });
      assert.equal(r.statusCode, 200, r.body);
    }

    const sent = await app.inject({ method: "POST", url: `/purchase-orders/${id}/send`, ...s });
    assert.equal(sent.statusCode, 200, sent.body);
    return sent.json() as OrderBody;
  }

  async function counts(): Promise<{ entries: number; moves: number }> {
    const r = await sql<{ entries: string; moves: string }>`
      SELECT (SELECT count(*) FROM ledger.journal_entry)     AS entries,
             (SELECT count(*) FROM inventory.stock_movement) AS moves`
      .execute(handle.db);
    return {
      entries: Number(r.rows[0]?.entries ?? 0),
      moves: Number(r.rows[0]?.moves ?? 0),
    };
  }

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);

    const u = await handle.db
      .insertInto("identity.app_user")
      .values({
        username: keeper,
        full_name: "انباردار سفارش",
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
      .values({ user_id: u.id, role_code: "warehouse", branch_id: BRANCH })
      .execute();

    const sup = await handle.db
      .insertInto("purchasing.supplier")
      .values({
        code: `S-${suffix}`,
        name: "تأمین‌کننده سفارش",
        mobile: null,
        phone: null,
        address: null,
        national_id: null,
        is_active: true,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    supplierId = sup.id;

    const product = await handle.db
      .insertInto("catalog.product")
      .values({
        code: `P-${suffix}`,
        name_internal: "کالای تست سفارش",
        name_web: null,
        tax_rate_code: "standard",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    for (const [sku, barcode, color] of [
      [`SKU-${suffix}-A`, "2000000000015", "مشکی"],
      [`SKU-${suffix}-B`, "2000000000022", "سفید"],
    ] as const) {
      const v = await handle.db
        .insertInto("catalog.variation")
        .values({ product_id: product.id, sku, barcode, color, size: "L", status: "active" })
        .returning("id")
        .executeTakeFirstOrThrow();
      if (color === "مشکی") variationA = v.id;
      else variationB = v.id;
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

  test("سفارش هیچ سندی و هیچ حرکت انباری نمی‌سازد", async () => {
    const before = await counts();
    const order = await sentOrder();

    assert.match(order.number ?? "", /^PO-\d{4}-\d{6}$/, `شماره نگرفت: ${order.number}`);
    assert.equal(order.status, "sent");
    assert.equal(order.orderedAmount, "20000000");

    const after = await counts();
    // تعهد، نه رویداد مالی. سیستمی که سفارش را در دفتر بنشاند،
    // ترازنامه‌ای می‌سازد که کالای نرسیده را دارایی می‌بیند.
    assert.equal(after.entries, before.entries, "هیچ سندی نباید ساخته شود");
    assert.equal(after.moves, before.moves, "هیچ حرکت انباری نباید ساخته شود");
  });

  test("پیش‌نویس شماره ندارد؛ سفارش فرستاده‌شده ویرایش نمی‌شود", async () => {
    const s = await loginAs(keeper);
    const created = await app.inject({
      method: "POST",
      url: "/purchase-orders",
      ...s,
      payload: { branchId: BRANCH, supplierId, warehouseId: STORE_WH },
    });
    const draft = created.json() as OrderBody;
    assert.equal(draft.number, null);

    await app.inject({
      method: "PUT",
      url: `/purchase-orders/${draft.id}/lines`,
      ...s,
      payload: { variationId: variationA, qty: "2", unitPrice: "1000" },
    });
    await app.inject({ method: "POST", url: `/purchase-orders/${draft.id}/send`, ...s });

    const edit = await app.inject({
      method: "PUT",
      url: `/purchase-orders/${draft.id}/lines`,
      ...s,
      payload: { variationId: variationB, qty: "1", unitPrice: "1000" },
    });
    assert.equal(edit.statusCode, 409, edit.body);
    assert.equal(edit.json().error.code, "order_sent");
  });

  test("قلم سفارش مطلق است: ارسال دوباره جایگزین می‌کند", async () => {
    const s = await loginAs(keeper);
    const created = await app.inject({
      method: "POST",
      url: "/purchase-orders",
      ...s,
      payload: { branchId: BRANCH, supplierId, warehouseId: STORE_WH },
    });
    const id = (created.json() as OrderBody).id;

    for (const qty of ["3", "7"]) {
      await app.inject({
        method: "PUT",
        url: `/purchase-orders/${id}/lines`,
        ...s,
        payload: { variationId: variationA, qty, unitPrice: "1000000" },
      });
    }

    const after = (await app.inject({
      method: "GET",
      url: `/purchase-orders/${id}`,
      ...s,
    })).json() as OrderBody;
    assert.equal(after.lines.length, 1, "یک کالا، یک سطر");
    assert.equal(after.lines[0]?.qty, "7.000", "«۷ تا» یعنی ۷، نه ۳ به‌علاوه ۷");
  });

  test("محموله سفارش: پیش‌نویس رسید از روی باقی‌مانده و به قیمت توافقی", async () => {
    const s = await loginAs(keeper);
    const order = await sentOrder();

    const made = await app.inject({
      method: "POST",
      url: `/purchase-orders/${order.id}/receipt`,
      ...s,
    });
    assert.equal(made.statusCode, 201, made.body);

    const receipt = made.json() as ReceiptBody;
    assert.equal(receipt.orderId, order.id, "رسید باید به سفارش وصل باشد");
    assert.equal(receipt.orderNumber, order.number);
    assert.equal(receipt.lines.length, 2);
    // ۱۰ × ۱٬۰۰۰٬۰۰۰ + ۵ × ۲٬۰۰۰٬۰۰۰
    assert.equal(receipt.goodsAmount, "20000000");
  });

  test("ثبت رسید، پیشرفت سفارش را جلو می‌برد", async () => {
    const s = await loginAs(keeper);
    const order = await sentOrder();

    const receipt = (await app.inject({
      method: "POST",
      url: `/purchase-orders/${order.id}/receipt`,
      ...s,
    })).json() as ReceiptBody;

    // محموله ناقص است: یکی از دو قلم را حذف می‌کنیم.
    const drop = receipt.lines[1];
    await app.inject({
      method: "DELETE",
      url: `/receipts/${receipt.id}/lines/${drop?.id}`,
      ...s,
    });
    await app.inject({ method: "POST", url: `/receipts/${receipt.id}/post`, ...s });

    const after = (await app.inject({
      method: "GET",
      url: `/purchase-orders/${order.id}`,
      ...s,
    })).json() as OrderBody;

    const first = after.lines.find((l) => l.variationId === variationA);
    const second = after.lines.find((l) => l.variationId === variationB);
    assert.equal(first?.receivedQty, "10.000");
    assert.equal(first?.remainingQty, "0.000");
    assert.equal(second?.receivedQty, "0.000", "قلم حذف‌شده نباید رسیده شمرده شود");
    assert.equal(second?.remainingQty, "5.000");
  });

  test("برگشت از خرید، پیشرفت را عقب می‌برد", async () => {
    const s = await loginAs(keeper);
    const order = await sentOrder();
    const receipt = (await app.inject({
      method: "POST",
      url: `/purchase-orders/${order.id}/receipt`,
      ...s,
    })).json() as ReceiptBody;
    await app.inject({ method: "POST", url: `/receipts/${receipt.id}/post`, ...s });

    const view = (await app.inject({
      method: "GET",
      url: `/receipts/${receipt.id}/returnable`,
      ...s,
    })).json() as { lines: { receiptLineId: string; remainingQty: string }[] };

    await app.inject({
      method: "POST",
      url: "/purchase-returns",
      ...s,
      headers: { ...s.headers, "idempotency-key": `order-return-${receipt.id}` },
      payload: {
        receiptId: receipt.id,
        reasonCode: "quality",
        lines: [{ receiptLineId: view.lines[0]?.receiptLineId, qty: "3" }],
      },
    });

    const after = (await app.inject({
      method: "GET",
      url: `/purchase-orders/${order.id}`,
      ...s,
    })).json() as OrderBody;
    const first = after.lines.find((l) => l.variationId === variationA);
    // کالایی که آمده و پس رفته، سفارش را برآورده نکرده.
    assert.equal(first?.receivedQty, "7.000");
    assert.equal(first?.remainingQty, "3.000");
  });

  test("بستن سفارش نیمه‌رسیده بدون دلیل رد می‌شود", async () => {
    const s = await loginAs(keeper);
    const order = await sentOrder();

    const noReason = await app.inject({
      method: "POST",
      url: `/purchase-orders/${order.id}/close`,
      ...s,
      payload: {},
    });
    assert.notEqual(noReason.statusCode, 200, "بستن بدون دلیل نباید بپذیرد");

    const withReason = await app.inject({
      method: "POST",
      url: `/purchase-orders/${order.id}/close`,
      ...s,
      payload: { reason: "تأمین‌کننده گفت بقیه‌اش نمی‌آید" },
    });
    assert.equal(withReason.statusCode, 200, withReason.body);
    assert.equal((withReason.json() as OrderBody).status, "closed");
  });

  test("سفارش نافرستاده رسید نمی‌گیرد", async () => {
    const s = await loginAs(keeper);
    const created = await app.inject({
      method: "POST",
      url: "/purchase-orders",
      ...s,
      payload: { branchId: BRANCH, supplierId, warehouseId: STORE_WH },
    });
    const id = (created.json() as OrderBody).id;

    const r = await app.inject({ method: "POST", url: `/purchase-orders/${id}/receipt`, ...s });
    assert.equal(r.statusCode, 422, r.body);
    assert.equal(r.json().error.code, "order_not_sent");
  });

  test("سفارش بدون قلم فرستادنی نیست و شماره نمی‌سوزاند", async () => {
    const s = await loginAs(keeper);
    const created = await app.inject({
      method: "POST",
      url: "/purchase-orders",
      ...s,
      payload: { branchId: BRANCH, supplierId, warehouseId: STORE_WH },
    });
    const id = (created.json() as OrderBody).id;

    const r = await app.inject({ method: "POST", url: `/purchase-orders/${id}/send`, ...s });
    assert.equal(r.statusCode, 422, r.body);

    const again = (await app.inject({
      method: "GET",
      url: `/purchase-orders/${id}`,
      ...s,
    })).json() as OrderBody;
    assert.equal(again.number, null);
  });
});
