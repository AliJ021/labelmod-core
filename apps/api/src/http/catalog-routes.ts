/**
 * مسیرهای کالا — ساخت خودکار تنوع و ماتریس موجودی.
 *
 * ساخت تنوع، مجوز تازه‌ای می‌خواهد: `catalog.manage`. تا امروز هیچ
 * عملیاتی برای تعریف کالا در `permission_rule` نبود — یعنی اگر مسیرش
 * ساخته می‌شد، یا باید بی‌مجوز می‌ماند یا یک `if` روی نام نقش می‌خورد.
 * هر دو خلاف قاعده‌اند؛ راه درست یک ردیف تازه در داده است.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AuthError } from "../auth/service.ts";
import { requireForSession } from "../auth/permission.ts";
import type { Db } from "../db/client.ts";
import { parseMoney } from "../lib/money.ts";
import { branchesOf } from "../sales/scope.ts";
import {
  CatalogError,
  generateToJson,
  type VariationService,
} from "../catalog/variation.ts";
import { labelPage, LABEL_CSP, type LabelItem } from "../catalog/label.ts";
import { CONTROL_CHARS } from "../lib/text.ts";

const uuid = z.string().uuid("شناسه نامعتبر");

const moneyString = z
  .string()
  .regex(/^\d+$/, "مبلغ باید رقم صحیح باشد (ریال، بدون اعشار)");

/**
 * نام رنگ و سایز — متن آزاد فارسی، ولی نه هر چیزی.
 *
 * کنترل طول و حذف نویسه‌های کنترلی: این مقادیر روی **برچسب چاپی** و در
 * سرستون ماتریس می‌نشینند. یک «رنگ» ۵۰۰ حرفی جدول را می‌شکند و یک
 * نویسه جهت‌دهی راست‌به‌چپ می‌تواند ظاهر برچسب را وارونه کند.
 */
const attributeName = z
  .string()
  .trim()
  .min(1, "نام نمی‌تواند خالی باشد")
  .max(40, "نام حداکثر ۴۰ نویسه")
  .refine((v) => !CONTROL_CHARS.test(v), {
    message: "نام شامل نویسه کنترلی است",
  });

const generateBody = z
  .object({
    colors: z.array(attributeName).max(40).default([]),
    sizes: z.array(attributeName).max(40).default([]),
    /** قیمت اختیاری — روی همه تنوع‌های تازه یکسان می‌نشیند. */
    price: moneyString.optional(),
  })
  .refine((v) => v.colors.length > 0 || v.sizes.length > 0, {
    message: "دست‌کم یک رنگ یا یک سایز لازم است",
  });

/**
 * درخواست چاپ برچسب.
 *
 * سقف ۵۰۰ برچسب در یک درخواست: بیش از این، صفحه‌ای می‌سازد که خودِ
 * مرورگر در چاپ گیر می‌کند — و تقریباً همیشه اشتباه ورودی است، نه یک
 * چاپ واقعی.
 */
const labelBody = z.object({
  items: z
    .array(
      z.object({
        variationId: uuid,
        count: z.number().int().min(1).max(100).default(1),
      }),
    )
    .min(1, "دست‌کم یک کالا لازم است")
    .max(200),
  layout: z.enum(["a4", "roll"]).default("a4"),
  rollWidthMm: z.number().min(20).max(120).optional(),
  rollHeightMm: z.number().min(10).max(120).optional(),
}).refine((body) => body.items.reduce((sum, item) => sum + item.count, 0) <= 500, {
  message: "حداکثر ۵۰۰ لیبل در هر درخواست مجاز است",
  path: ["items"],
});

export interface CatalogRouteDeps {
  db: Db;
  variations: VariationService;
}

export function registerCatalogRoutes(
  app: FastifyInstance,
  deps: CatalogRouteDeps,
): void {
  const { db, variations } = deps;

  const session = (req: { session: unknown }) => {
    const s = req.session as
      | { userId: string; pinUnlocked: boolean; fullName: string }
      | null;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    return s;
  };

  /**
   * ساخت خودکار همه ترکیب‌های رنگ×سایز.
   *
   * عمداً **Idempotency-Key نمی‌گیرد**: خودِ عملیات از پایه تکرارپذیر
   * است — ترکیبِ موجود رد می‌شود، نه دوباره ساخته. یعنی فشار دوباره
   * روی دکمه هیچ‌چیز اضافه نمی‌سازد و نیازی به کلید نیست.
   */
  app.post("/products/:id/variations/generate", async (req, reply) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = generateBody.parse(req.body);
    await requireForSession(db, s, "catalog.manage");

    const result = await variations.generate({
      productId: id,
      colors: body.colors,
      sizes: body.sizes,
      actorId: s.userId,
      ...(body.price === undefined ? {} : { price: parseMoney(body.price) }),
    });
    return reply.code(201).send(generateToJson(result));
  });

  /**
   * برچسب قیمت آماده چاپ.
   *
   * `POST` است نه `GET`، با اینکه چیزی را عوض نمی‌کند: فهرست کالاها و
   * تعدادشان در URL جا نمی‌شود، و URL در تاریخچه مرورگر و لاگ
   * می‌نشیند. به همین دلیل هم دفاع CSRF رویش اعمال می‌شود.
   *
   * پاسخ HTML است، نه JSON — تنها مسیر این پروژه که چنین است. سه
   * هدر همراهش می‌رود که هیچ‌کدام تزئینی نیستند:
   *   • CSP بدون هیچ اسکریپتی — صفحه جاوااسکریپت لازم ندارد
   *   • nosniff — تا مرورگر نوع دیگری حدس نزند
   *   • no-store — برچسب قیمت نباید در Cache بماند و قیمت کهنه بدهد
   */
  app.post("/labels", async (req, reply) => {
    const s = session(req);
    const body = labelBody.parse(req.body);
    await requireForSession(db, s, "catalog.manage");

    const wanted = new Map(body.items.map((i) => [i.variationId, i.count]));
    const rows = await variations.labelData([...wanted.keys()]);

    if (rows.length === 0) {
      throw new CatalogError("variation_not_found", "هیچ‌کدام از کالاها یافت نشدند", 404);
    }

    const shop = await db
      .selectFrom("platform.branch")
      .select("name")
      .where("is_active", "=", true)
      .orderBy("code")
      .executeTakeFirst();

    const items: LabelItem[] = rows.map((r) => ({
      barcode: r.barcode,
      sku: r.sku,
      productName: r.productName,
      color: r.color,
      size: r.size,
      priceRial: r.priceRial,
      count: wanted.get(r.id) ?? 1,
    }));

    const html = labelPage(items, {
      layout: body.layout,
      shopName: shop?.name ?? "فروشگاه",
      ...(body.layout === "roll"
        ? {
            rollMm: {
              width: body.rollWidthMm ?? 50,
              height: body.rollHeightMm ?? 30,
            },
          }
        : {}),
    });

    return reply
      .code(200)
      .header("content-type", "text/html; charset=utf-8")
      .header("content-security-policy", LABEL_CSP)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "no-store")
      .send(html);
  });

  /**
   * ماتریس موجودی — سطر رنگ، ستون سایز.
   *
   * بدون `warehouseId` جمع همه انبارهای **شعبه‌های خودِ کاربر** را
   * می‌دهد، نه کل سیستم. مثل بقیه مسیرها، دامنه شعبه از
   * `identity.user_role` می‌آید.
   */
  app.get("/products/:id/stock-matrix", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const query = z
      .object({ warehouseId: uuid.optional() })
      .parse(req.query ?? {});

    const allowed = await visibleWarehouses(db, s.userId, query.warehouseId);
    return variations.stockMatrix(id, allowed);
  });
}

/**
 * انبارهایی که این کاربر حق دیدنشان را دارد.
 *
 * `null` یعنی «همه» و فقط برای نقشی صادر می‌شود که دامنه‌اش همه شعب
 * است. برای بقیه، فهرست صریح انبارهای شعبه‌هایشان — پس حتی اگر
 * `warehouseId` انبار شعبه دیگری باشد، در فهرست نمی‌آید و ماتریس
 * صفر برمی‌گردد به‌جای اینکه موجودی شعبه دیگر را لو بدهد.
 */
async function visibleWarehouses(
  db: Db,
  userId: string,
  requested: string | undefined,
): Promise<string[] | null> {
  const scope = await branchesOf(db, userId);

  if (scope === "all") {
    return requested === undefined ? null : [requested];
  }
  if (scope.length === 0) return [];

  const rows = await db
    .selectFrom("inventory.warehouse")
    .select("id")
    .where("branch_id", "in", scope)
    .execute();
  const ids = rows.map((r) => r.id);

  if (requested === undefined) return ids;
  return ids.includes(requested) ? [requested] : [];
}
