/**
 * مسیرهای چرخه حیات کالا و قیمت.
 *
 * ── چرا جدا از `catalog-routes.ts` ───────────────────────────────────
 *
 * آن فایل درباره **تنوع** است: ساخت خودکار ترکیب‌ها، ماتریس موجودی و
 * برچسب. این فایل درباره **خودِ کالا و قیمتش**. تفکیک مجوزی هم هست:
 * تعریف کالا `catalog.manage` می‌خواهد (انباردار هم دارد) ولی تغییر
 * قیمت `price.change` که فقط مدیر دارد.
 *
 * ── قیمت از کلاینت می‌آید، و این تنها جای درستش است ──────────────────
 *
 * قاعده پروژه «قیمت از دیتابیس می‌آید نه از کلاینت» درباره **فروش**
 * است: صندوق‌دار قیمت را تعیین نمی‌کند. ولی قیمت فروش خودش باید یک
 * جا وارد شود، وگرنه هیچ‌وقت در دیتابیس نیست. اینجا همان جاست.
 *
 * محافظ‌ها به‌جای «از دیتابیس بخوان»:
 *   • `price.change` — در Seed فقط `admin` داردش
 *   • در `auth.pin_forbidden_operations` است، پس نشست بازشده با PIN
 *     نمی‌تواند قیمت عوض کند حتی اگر کاربرش مدیر باشد
 *   • `platform.audit()` مقدار پیش و پس را می‌نویسد
 *   • تاریخچه تغییرناپذیر است — Trigger روی `catalog.price`
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AuthError } from "../auth/service.ts";
import { requireForSession } from "../auth/permission.ts";
import type { Db } from "../db/client.ts";
import { parseMoney } from "../lib/money.ts";
import { runOnce } from "../lib/idempotency.ts";
import type { ProductService } from "../catalog/product.ts";

const uuid = z.string().uuid("شناسه نامعتبر");

/**
 * نویسه‌های کنترلی و جهت‌دهی — همان فهرستی که مسیر تنوع و مسیر خرید
 * رد می‌کنند.
 *
 * صریح با Escape نوشته شده، نه با خودِ نویسه: نویسه کنترلیِ خام در
 * سورس نامرئی است و فایل را از نظر گیت باینری می‌کند — آن‌وقت نه
 * `git diff` کار می‌کند نه اسکن راز. یک بار همین اتفاق افتاد.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

const cleanText = (max: number) =>
  z
    .string()
    .trim()
    .min(1, "نمی‌تواند خالی باشد")
    .max(max, `حداکثر ${max} نویسه`)
    .refine((v) => !CONTROL_CHARS.test(v), {
      message: "شامل نویسه کنترلی است",
    });

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `حداکثر ${max} نویسه`)
    .refine((v) => !CONTROL_CHARS.test(v), { message: "شامل نویسه کنترلی است" })
    .transform((v) => (v === "" ? undefined : v))
    .optional();

/** پول در JSON رشته است — رقم صحیح ریالی، بدون اعشار و جداکننده. */
const moneyString = z
  .string()
  .regex(/^\d+$/, "مبلغ باید رقم صحیح باشد (ریال، بدون اعشار)")
  .refine((v) => v.length <= 18, { message: "مبلغ بزرگ‌تر از حد مجاز است" });

/**
 * کد کالا — روی SKU و بارکد چاپ‌شده می‌نشیند، پس فقط حروف لاتین، رقم
 * و خط تیره. فارسی و فاصله اینجا یعنی SKUیی که در URL و فایل CSV
 * می‌شکند.
 */
const productCode = z
  .string()
  .trim()
  .min(2, "کد کالا حداقل ۲ نویسه")
  .max(24, "کد کالا حداکثر ۲۴ نویسه")
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, "کد فقط حروف لاتین، رقم و خط تیره");

const productBody = z.object({
  code: productCode,
  nameInternal: cleanText(120),
  nameWeb: optionalText(160),
  brandId: uuid.optional(),
  categoryId: uuid.optional(),
  season: optionalText(40),
  collection: optionalText(60),
  fabric: optionalText(80),
  fit: optionalText(40),
  originCountry: optionalText(60),
  taxRateCode: optionalText(24),
  notes: optionalText(500),
});

/** ویرایش، کد را نمی‌فرستد — دیتابیس هم عوض‌شدنش را رد می‌کند. */
const productPatchBody = productBody.omit({ code: true });

const priceBody = z.object({
  amount: moneyString,
  kind: z.enum(["regular", "markdown", "promo"]).default("regular"),
  reason: optionalText(200),
});

const bulkPriceBody = priceBody.extend({
  variationIds: z.array(uuid).min(1, "دست‌کم یک تنوع لازم است").max(400),
});

export interface ProductRouteDeps {
  db: Db;
  products: ProductService;
}

export function registerProductRoutes(
  app: FastifyInstance,
  deps: ProductRouteDeps,
): void {
  const { db, products } = deps;

  const session = (req: { session: unknown }) => {
    const s = req.session as
      | { userId: string; pinUnlocked: boolean; fullName: string }
      | null;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    return s;
  };

  // ── خواندن ─────────────────────────────────────────────────────────

  app.get("/products", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "catalog.manage");
    const q = z
      .object({
        search: z.string().trim().max(80).optional(),
        status: z.enum(["active", "archived", "all"]).default("active"),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query ?? {});
    return { products: await products.list(q) };
  });

  app.get("/products/ref-data", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "catalog.manage");
    return products.refData();
  });

  app.get("/products/:id", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "catalog.manage");
    const { id } = z.object({ id: uuid }).parse(req.params);
    const [product, variations] = await Promise.all([
      products.get(id),
      products.variations(id),
    ]);
    return { product, variations };
  });

  app.get("/variations/:id/price-history", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "catalog.manage");
    const { id } = z.object({ id: uuid }).parse(req.params);
    return { history: await products.priceHistory(id) };
  });

  // ── ساخت و ویرایش کالا ────────────────────────────────────────────

  app.post("/products", async (req, reply) => {
    const s = session(req);
    const body = productBody.parse(req.body);
    await requireForSession(db, s, "catalog.manage");

    const out = await runOnce<string>(db, {
      key: idempotencyKey(req),
      source: "api.product.create",
      payload: { actorId: s.userId, ...body },
      run: async () => {
        const id = await products.create(body, s.userId);
        return { value: id, ref: id };
      },
      replay: async (ref) => ref,
    });

    return reply
      .code(out.replayed ? 200 : 201)
      .send({ id: out.value, replayed: out.replayed });
  });

  app.patch("/products/:id", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = productPatchBody.parse(req.body);
    await requireForSession(db, s, "catalog.manage");

    // کد از خودِ سطر خوانده می‌شود، نه از کلاینت: تابع دیتابیس
    // عوض‌شدنش را رد می‌کند و فرستادنش فقط راه یک خطای گیج‌کننده بود.
    const current = await products.get(id);
    await products.update(id, { ...body, code: current.code }, s.userId);
    return { ok: true };
  });

  app.patch("/products/:id/status", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        status: z.enum(["active", "archived"]),
        reason: optionalText(200),
      })
      .parse(req.body);
    await requireForSession(db, s, "catalog.manage");

    await products.setProductStatus(id, body.status, body.reason ?? null, s.userId);
    return { ok: true };
  });

  // ── تنوع ───────────────────────────────────────────────────────────

  app.patch("/variations/:id/status", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        status: z.enum(["active", "paused", "preorder", "archived"]),
        reason: optionalText(200),
      })
      .parse(req.body);
    await requireForSession(db, s, "catalog.manage");

    await products.setVariationStatus(id, body.status, body.reason ?? null, s.userId);
    return { ok: true };
  });

  /**
   * اصلاح رنگ و سایز — فقط تا پیش از اولین حرکت انبار و اولین فروش.
   *
   * `PATCH` است و `Idempotency-Key` نمی‌خواهد: عملیات **مطلق** است،
   * مثل سطر انبارگردانی. فرستادن دوباره همان مقدار، همان نتیجه را
   * می‌دهد.
   */
  app.patch("/variations/:id", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        color: optionalText(40),
        size: optionalText(40),
      })
      .refine((v) => v.color !== undefined || v.size !== undefined, {
        message: "دست‌کم یکی از رنگ یا سایز لازم است",
      })
      .parse(req.body);
    await requireForSession(db, s, "catalog.manage");

    await products.amendVariation(id, body.color ?? null, body.size ?? null, s.userId);
    return { ok: true };
  });

  // ── قیمت ───────────────────────────────────────────────────────────

  /**
   * تغییر قیمت یک تنوع.
   *
   * `PUT` است نه `POST`: هویت عملیات «قیمت این تنوع، این مبلغ» است و
   * فرستادن دوباره‌اش هیچ سطر تازه‌ای نمی‌سازد — خودِ
   * `catalog.set_price()` می‌بیند مبلغ عوض نشده و برمی‌گردد. پس
   * `Idempotency-Key` لازم ندارد.
   */
  app.put("/variations/:id/price", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = priceBody.parse(req.body);
    await requireForSession(db, s, "price.change");

    await products.setPrice({
      variationId: id,
      amount: parseMoney(body.amount),
      kind: body.kind,
      reason: body.reason ?? null,
      actorId: s.userId,
    });
    return { ok: true };
  });

  /**
   * قیمت‌گذاری گروهی — حراج فصلی روی یک مدل کامل.
   *
   * همان مجوز، همان تابع، ولی در **یک تراکنش**: نیمی از تنوع‌های یک
   * مدل با قیمت تازه و نیمی با قیمت قدیم، بدترین حالت ممکن است.
   */
  app.put("/prices", async (req) => {
    const s = session(req);
    const body = bulkPriceBody.parse(req.body);
    await requireForSession(db, s, "price.change");

    const n = await products.setPriceBulk({
      variationIds: body.variationIds,
      amount: parseMoney(body.amount),
      kind: body.kind,
      reason: body.reason ?? null,
      actorId: s.userId,
    });
    return { updated: n };
  });
}

function idempotencyKey(req: { headers: Record<string, unknown> }): string | undefined {
  const raw = req.headers["idempotency-key"];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}
