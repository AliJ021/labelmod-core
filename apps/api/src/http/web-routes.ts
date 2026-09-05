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
import { sql } from "kysely";
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
   * ── کلید اتصال `variationId` است، نه SKU و نه نام ────────────────
   *
   * نام کالا در سایت و در حسابداری عمداً یکی نیست — تصمیم سئویی مالک.
   * SKU هم می‌تواند روزی عوض شود. پس خوراک `variationId` می‌فرستد و
   * افزونه آن را در متای کالا نگه می‌دارد؛ از آن به بعد نام و SKU هر
   * دو می‌توانند آزادانه فرق کنند بدون اینکه اتصال بشکند.
   *
   * SKU هنوز می‌آید، ولی فقط برای **یک بار** برقرار کردن اتصال روی
   * سایتی که هنوز متا ندارد. پس از آن، متا حرف آخر را می‌زند.
   *
   * ── قیمت حالا هست ────────────────────────────────────────────────
   *
   * تصمیم مالک: قیمت مرجع در حسابداری است و سایت از آن به‌روز می‌شود.
   * قیمت از `catalog.price` در **لحظه درخواست** خوانده می‌شود، از
   * فهرست قیمتی که خواسته شده (پیش‌فرض `default`).
   *
   * ⚠️ این با «قیمت سفارش سایت از کلاینت می‌آید» تعارض ندارد و آن
   *    قاعده سر جایش است: آنجا صحبت از **چیزی است که مشتری پرداخت
   *    کرده** و باید همان در دفتر بنشیند. اینجا صحبت از عددی است که
   *    ویترین **نشان می‌دهد**. اگر این دو در لحظه‌ای فرق کنند، همان
   *    که مشتری دیده و پرداخته درست است.
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
        /** کدام فهرست قیمت به سایت برود. */
        priceList: z.string().trim().min(1).max(40).default("default"),
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
      .select((eb) => [
        "v.id as variation_id",
        "v.sku",
        "b.on_hand",
        "b.reserved",
        "b.updated_at",
        "v.status",
        // قیمت باز همان فهرست، در همین لحظه. سطر بسته (`valid_to`)
        // تاریخچه است و به ویترین نمی‌رود.
        eb
          .selectFrom("catalog.price as p")
          .select("p.amount")
          .whereRef("p.variation_id", "=", "v.id")
          .where("p.price_list", "=", query.priceList)
          .where("p.valid_to", "is", null)
          .limit(1)
          .as("price"),
      ])
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
      priceList: query.priceList,
      items: rows.map((r) => ({
        /** کلید اتصال — افزونه همین را در متای کالا نگه می‌دارد. */
        variationId: r.variation_id,
        /** فقط برای برقرار کردن اتصال اولیه، نه برای تطبیق همیشگی. */
        sku: r.sku,
        // کالای غیرفعال «صفر» است، نه «غایب»: اگر از خوراک حذف شود،
        // سایت عدد قبلی‌اش را نگه می‌دارد و می‌فروشد.
        available:
          r.status === "active"
            ? String(Math.max(0, Number(r.on_hand) - Number(r.reserved)))
            : "0",
        // `null` یعنی «این کالا در این فهرست قیمت ندارد» — که با
        // «قیمتش صفر است» یکی نیست. افزونه باید ردش کند، نه اینکه
        // کالا را مجانی کند.
        price: r.price === null ? null : serializeMoney(parseMoney(r.price)),
      })),
    };
  });
  /**
   * خوراک خرید حضوری — تا سفارش فروشگاه در حساب کاربری سایت دیده شود.
   *
   * ── چرا Pull است و نه Push ────────────────────────────────────────
   *
   * همان الگوی خوراک موجودی. اگر سامانه به سایت Push می‌کرد، باید
   * آدرس و کلید سایت را می‌دانست و در قطعی سایت صف نگه می‌داشت. با
   * Pull، سایت هر وقت توانست می‌آید و مکان‌نما جای صف را می‌گیرد.
   *
   * ── حلقه بازگشتی: سفارش سایت هرگز برنمی‌گردد ─────────────────────
   *
   * `channel <> 'web'` یک نگهبان **در سرور** است، نه یک قرارداد در
   * افزونه. سفارشی که از سایت آمده اگر دوباره به سایت برود، افزونه
   * رکورد تازه می‌سازد، آن رکورد شاید Webhook بزند، و چرخه بسته
   * می‌شود. دو نگهبان داریم — این یکی و یکی در افزونه — چون یکی‌شان
   * روزی با یک تغییر بی‌ربط برداشته می‌شود.
   *
   * ── فقط مشتری شناخته‌شده ─────────────────────────────────────────
   *
   * بدون شماره موبایل، حسابی در سایت ساختنی نیست و رکورد به هیچ‌کس
   * نمی‌چسبد. فروش ناشناس عادی است و اینجا فقط رد می‌شود.
   *
   * ⚠️ این خوراک **اثر مالی ندارد**: نه سندی می‌زند، نه موجودی را
   *    تکان می‌دهد. کالا در همان `finalize_invoice` از انبار رفته.
   */
  app.get("/web/instore-purchases", async (req) => {
    const s = session(req);
    const query = z
      .object({
        branchId: uuid,
        /**
         * مکان‌نمای صفحه قبل — از پاسخ پیشین، نه از ساعت سایت.
         *
         * ⚠️ **رشته می‌ماند و به `Date` تبدیل نمی‌شود.** `timestamptz`
         *    پستگرس میکروثانیه دارد و `Date` جاوااسکریپت میلی‌ثانیه؛
         *    رفتنِ مقدار از میان `Date` یعنی مکان‌نما کمی **عقب‌تر**
         *    از سطر واقعی برگردد و همان سطر در هر دور دوباره بیاید.
         *    سایت آن خرید را برای همیشه تکراری می‌دید.
         */
        since: z.string().min(1).max(40).optional(),
        sinceId: uuid.optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query ?? {});

    await requireForSession(db, s, "sale.create");
    await assertBranch(db, s.userId, query.branchId);

    let q = db
      .selectFrom("sales.invoice as i")
      .innerJoin("sales.customer as c", "c.id", "i.customer_id")
      .select([
        "i.id",
        "i.number",
        "i.channel",
        "i.occurred_at",
        // با دقت کامل و به‌شکل متن — همان چیزی که مکان‌نما می‌شود.
        sql<string>`to_char(i.finalized_at at time zone 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as("finalized_at"),
        "i.net_amount",
        "i.discount_amount",
        "i.shipping_amount",
        "i.payable_amount",
        "c.mobile_normalized",
        "c.full_name",
      ])
      .where("i.branch_id", "=", query.branchId)
      // «فاکتور واقعی» چهار وضعیت دارد، نه دو تا: فاکتوری که مرجوعی
      // خورده هم یک خرید واقعی بوده و باید در حساب مشتری بماند.
      .where("i.status", "in", ["finalized", "paid", "partially_returned", "returned"])
      // نگهبان حلقه — سفارشی که از سایت آمده به سایت برنمی‌گردد.
      .where("i.channel", "<>", "web")
      .where("i.finalized_at", "is not", null)
      .where("c.mobile_normalized", "is not", null)
      .orderBy("i.finalized_at", "asc")
      .orderBy("i.id", "asc")
      .limit(query.limit);

    // مکان‌نمای مرکب: دو فاکتور می‌توانند در یک لحظه نهایی شوند و
    // مکان‌نمای تک‌ستونی یا یکی‌شان را جا می‌اندازد یا هر بار
    // دوباره‌اش می‌فرستد.
    if (query.since) {
      // مقایسه در SQL و روی `timestamptz` — نه در TypeScript. تبدیل
      // متن به `Date` و برگرداندنش، میکروثانیه را می‌خورد.
      const at = query.since;
      const id = query.sinceId;
      q =
        id === undefined
          ? q.where(sql<boolean>`i.finalized_at > ${at}::timestamptz`)
          : q.where(
              sql<boolean>`(i.finalized_at, i.id) > (${at}::timestamptz, ${id}::uuid)`,
            );
    }

    const rows = await q.execute();

    const lines =
      rows.length === 0
        ? []
        : await db
            .selectFrom("sales.invoice_line as l")
            .innerJoin("catalog.variation as v", "v.id", "l.variation_id")
            .innerJoin("catalog.product as p", "p.id", "v.product_id")
            .select([
              "l.invoice_id",
              "l.line_no",
              "l.qty",
              "l.unit_price",
              "l.discount_amount",
              "l.net_amount",
              "v.id as variation_id",
              "v.sku",
              "v.color",
              "v.size",
              "p.name_internal",
              "p.name_web",
            ])
            .where(
              "l.invoice_id",
              "in",
              rows.map((r) => r.id),
            )
            .orderBy("l.invoice_id")
            .orderBy("l.line_no")
            .execute();

    const byInvoice = new Map<string, typeof lines>();
    for (const l of lines) {
      const list = byInvoice.get(l.invoice_id);
      if (list) list.push(l);
      else byInvoice.set(l.invoice_id, [l]);
    }

    const last = rows.at(-1);
    return {
      branchId: query.branchId,
      cursor: last?.finalized_at ?? null,
      cursorId: last?.id ?? null,
      items: rows.map((r) => ({
        /** هویت این خرید در سایت — افزونه با همین Replay را می‌گیرد. */
        invoiceId: r.id,
        number: r.number,
        channel: r.channel,
        occurredAt: r.occurred_at,
        finalizedAt: r.finalized_at,
        customer: {
          mobile: r.mobile_normalized,
          name: r.full_name,
        },
        netAmount: serializeMoney(parseMoney(r.net_amount)),
        discountAmount: serializeMoney(parseMoney(r.discount_amount)),
        shippingAmount: serializeMoney(parseMoney(r.shipping_amount)),
        payableAmount: serializeMoney(parseMoney(r.payable_amount)),
        lines: (byInvoice.get(r.id) ?? []).map((l) => ({
          variationId: l.variation_id,
          sku: l.sku,
          // نام **مشتری‌پسند** می‌رود، نه نام داخلی: این رکورد را
          // خودِ مشتری در حساب کاربری‌اش می‌بیند. اگر افزونه کالا را
          // با متا پیدا کند نام سایت را نشان می‌دهد و این فقط جای
          // خالی را پر می‌کند — ولی جای خالی هم نباید نام انبارداری
          // باشد.
          name: l.name_web ?? l.name_internal,
          color: l.color,
          size: l.size,
          qty: String(l.qty),
          unitPrice: serializeMoney(parseMoney(l.unit_price)),
          discountAmount: serializeMoney(parseMoney(l.discount_amount)),
          netAmount: serializeMoney(parseMoney(l.net_amount)),
        })),
      })),
    };
  });
}
