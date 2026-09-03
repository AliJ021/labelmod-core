/**
 * مسیرهای سایت — ورودی ووکامرس.
 *
 * تنها گروهی که کلاینتش یک **ماشین** است، نه یک آدم پشت مرورگر. سه
 * پیامد دارد و هر سه عمدی‌اند:
 *
 * ۱. **احراز هویت با کلید API**، نه کوکی نشست. کلید یک نشست ساختگی
 *    می‌سازد که مجوزش از همان `permission_rule` می‌آید (`auth/api-key.ts`).
 *
 * ۲. **بدون دفاع CSRF.** CSRF یک حمله مبتنی بر کوکی است: مرورگر قربانی
 *    کوکی را خودکار می‌فرستد. هدر `Authorization` را هیچ مرورگری
 *    خودکار نمی‌فرستد. اعمالش اینجا فقط سایت را از کار می‌انداخت.
 *
 * ۳. **کلید Idempotency از شماره سفارش ووکامرس ساخته می‌شود، نه از
 *    هدر.** هویت این عملیات همان سفارش است؛ پذیرفتن هدر کلاینت تنها
 *    راهِ دور زدن قفل بود — همان قاعده‌ای که بستن دوره کانال دارد.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AuthError } from "../auth/service.ts";
import { requireForSession } from "../auth/permission.ts";
import type { Db } from "../db/client.ts";
import { parseMoney, serializeMoney } from "../lib/money.ts";
import { runOnce } from "../lib/idempotency.ts";
import { assertBranch, assertWarehouseInBranch } from "../sales/scope.ts";
import { InvoiceError, type InvoiceService } from "../sales/invoice.ts";
import { assertMarkdownAllowed } from "../sales/markdown-gate.ts";
import type { WebOrderService } from "../sales/web-order.ts";

const uuid = z.string().uuid("شناسه نامعتبر");

const moneyString = z
  .string()
  .regex(/^\d+$/, "مبلغ باید رقم صحیح باشد (ریال، بدون اعشار)");

const qtyString = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, "تعداد نامعتبر")
  .refine((v) => Number(v) > 0, { message: "تعداد باید بزرگ‌تر از صفر باشد" });

/**
 * یک سفارش سایت.
 *
 * `unitPrice` **اجباری** است و این عمدی است: مشتری همان چیزی را
 * پرداخت کرده که سایت نشانش داده. اگر نیاید و ما قیمت جاری را ثبت
 * کنیم، دفتر درآمدی می‌نویسد که هرگز دریافت نشده.
 */
const webOrderBody = z.object({
  branchId: uuid,
  warehouseId: uuid,
  /** شماره سفارش ووکامرس — هویت این عملیات. */
  externalId: z.string().trim().min(1).max(64),
  customerMobile: z.string().trim().max(20).optional(),
  customerName: z.string().trim().max(120).optional(),
  lines: z
    .array(
      z.object({
        sku: z.string().trim().min(1).max(64),
        qty: qtyString,
        unitPrice: moneyString,
      }),
    )
    .min(1, "سفارش بدون قلم ثبت نمی‌شود")
    .max(200),
  shippingAmount: moneyString.default("0"),
  paymentMethod: z.string().trim().min(1).max(40),
  paymentRef: z.string().trim().max(120).optional(),
  paidAmount: moneyString.default("0"),
  note: z.string().trim().max(500).optional(),
});

export interface WebRouteDeps {
  db: Db;
  webOrders: WebOrderService;
  invoices: InvoiceService;
}

export function registerWebRoutes(app: FastifyInstance, deps: WebRouteDeps): void {
  const { db, webOrders, invoices } = deps;

  const session = (req: { session: unknown }) => {
    const s = req.session as
      | { userId: string; pinUnlocked: boolean; fullName: string }
      | null;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    return s;
  };

  /**
   * ثبت یک سفارش سایت.
   *
   * پیش‌نویس، اقلام، پرداخت و نهایی‌سازی همه در **یک** تراکنش با درج
   * Inbox. جدا کردنشان یعنی خرابی میانه، فاکتوری نیمه‌کاره جا بگذارد
   * که درآمدش هرگز به دفتر نمی‌رود و کسی دنبالش نمی‌گردد.
   *
   * سند درآمد و COGS اینجا زده نمی‌شود — کار بستن شبانه دوره کانال
   * است (ADR-003). `GET /posting-batches/unposted` زنگ خطر آن است.
   */
  app.post("/web/orders", async (req, reply) => {
    const s = session(req);
    const body = webOrderBody.parse(req.body);

    await assertBranch(db, s.userId, body.branchId);
    await assertWarehouseInBranch(db, body.warehouseId, body.branchId);
    await requireForSession(db, s, "sale.create");

    // ── قیمت سایت از همان دروازه قیمت دستی می‌گذرد ─────────────────
    //
    // نه یک مسیر تازه: `assertMarkdownAllowed` همان تابعی است که صندوق
    // صدا می‌زند (`sales/markdown-gate.ts`). یعنی «کاهش کل» نسبت به
    // قیمت فهرست، برای سفارش سایت هم از همان نردبان
    // `sale.discount` / `sale.discount_high` می‌گذرد.
    //
    // ⚠️ و این همان جایی است که نقش `web` سقفش را می‌گیرد. اگر مالک
    //    بخواهد کمپین سایت سقف داشته باشد، یک UPDATE روی
    //    `permission_rule` است — نه یک Deploy. پیش‌فرض بی‌سقف است و
    //    دلیلش در seed نوشته شده: پول را سایت **قبلاً** گرفته و
    //    فاکتوری که ثبت نشود، درآمدی است که هیچ‌جا نیست.
    //
    // پیش از باز کردن تراکنش سنجیده می‌شود، نه وسط آن: مجوز همیشه
    // **پیش از** نوشتن گرفته می‌شود.
    for (const line of body.lines) {
      const variationId = await webOrders.resolveSku(db, line.sku);
      await assertMarkdownAllowed(db, invoices, s, {
        variationId,
        qty: line.qty,
        discount: 0n,
        settingPrice: parseMoney(line.unitPrice),
      });
    }

    // ⚠️ کلید از **شماره سفارش** ساخته می‌شود، نه از هدر کلاینت.
    //    هویت این عملیات همان سفارش است؛ ووکامرسی که دو بار Webhook
    //    بزند باید Replay بگیرد، نه فاکتور دوم.
    const out = await runOnce<string>(db, {
      key: `woo-order:${body.externalId}`,
      source: "api.web.order",
      payload: {
        actorId: s.userId,
        branchId: body.branchId,
        warehouseId: body.warehouseId,
        externalId: body.externalId,
        lines: body.lines,
        shippingAmount: body.shippingAmount,
        paymentMethod: body.paymentMethod,
        paidAmount: body.paidAmount,
      },
      run: async (trx) => {
        const id = await webOrders.ingest(trx, {
          branchId: body.branchId,
          warehouseId: body.warehouseId,
          externalId: body.externalId,
          lines: body.lines.map((l) => ({
            sku: l.sku,
            qty: l.qty,
            unitPrice: parseMoney(l.unitPrice),
          })),
          shippingAmount: parseMoney(body.shippingAmount),
          paymentMethod: body.paymentMethod,
          paidAmount: parseMoney(body.paidAmount),
          actorId: s.userId,
          ...(body.customerMobile === undefined
            ? {}
            : { customerMobile: body.customerMobile }),
          ...(body.customerName === undefined ? {} : { customerName: body.customerName }),
          ...(body.paymentRef === undefined ? {} : { paymentRef: body.paymentRef }),
          ...(body.note === undefined ? {} : { note: body.note }),
        });
        return { value: id, ref: id };
      },
      replay: async (ref) => ref,
    });

    const invoice = await invoices.byId(out.value);
    if (!invoice) throw new InvoiceError("invoice_not_found", "فاکتور یافت نشد", 404);

    return reply.code(out.replayed ? 200 : 201).send({
      invoiceId: invoice.id,
      number: invoice.number,
      status: invoice.status,
      // پول در JSON **رشته** است، نه عدد — و `bigint` را هم اصلاً
      // نمی‌شود Serialize کرد. `serializeMoney` تنها مرز تبدیل است.
      payableAmount: serializeMoney(invoice.payableAmount),
      replayed: out.replayed,
    });
  });

  /**
   * خوراک موجودی — تا سایت بیش از موجودی نفروشد.
   *
   * فقط SKU و عدد. قیمت عمداً **نیست**: قیمت سایت می‌تواند از قیمت
   * فروشگاه فرق کند (کمپین، هزینه ارسال رایگان) و همگام‌سازی خودکارش
   * تصمیمی است که مالک باید بگیرد، نه چیزی که بی‌صدا اتفاق بیفتد.
   *
   * `reserved` کم می‌شود: کالایی که در سبدی رزرو شده، برای سایت
   * موجود نیست.
   */
  app.get("/web/stock", async (req) => {
    const s = session(req);
    const query = z
      .object({
        warehouseId: uuid,
        /** فقط کالاهایی که پس از این زمان تغییر کرده‌اند. */
        since: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(5000).default(1000),
      })
      .parse(req.query ?? {});

    await requireForSession(db, s, "sale.create");

    const wh = await db
      .selectFrom("inventory.warehouse")
      .select("branch_id")
      .where("id", "=", query.warehouseId)
      .executeTakeFirst();
    if (!wh) throw new InvoiceError("warehouse_not_found", "انبار یافت نشد", 404);
    await assertBranch(db, s.userId, wh.branch_id);

    let q = db
      .selectFrom("inventory.stock_balance as b")
      .innerJoin("catalog.variation as v", "v.id", "b.variation_id")
      .select(["v.sku", "b.on_hand", "b.reserved", "b.updated_at", "v.status"])
      .where("b.warehouse_id", "=", query.warehouseId)
      .orderBy("b.updated_at", "asc")
      .limit(query.limit);

    if (query.since) q = q.where("b.updated_at", ">", new Date(query.since));

    const rows = await q.execute();

    return {
      warehouseId: query.warehouseId,
      /**
       * زمان آخرین سطر — سایت همین را در درخواست بعدی `since`
       * می‌فرستد. با ساعت خودِ سایت کار نمی‌کند: اختلاف ساعت میان دو
       * ماشین یعنی یا تغییری جا بیفتد یا هر بار همه‌چیز دوباره
       * فرستاده شود.
       */
      cursor: rows.at(-1)?.updated_at ?? null,
      items: rows.map((r) => ({
        sku: r.sku,
        // کالای غیرفعال «صفر» است، نه «غایب»: اگر از خوراک حذف شود،
        // سایت عدد قبلی‌اش را نگه می‌دارد و می‌فروشد.
        available:
          r.status === "active"
            ? String(Math.max(0, Number(r.on_hand) - Number(r.reserved)))
            : "0",
      })),
    };
  });
}
