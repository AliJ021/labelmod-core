/**
 * چرخه حیات کالا و قیمت.
 *
 * تا پیش از این، `catalog.product` فقط از ابزار مهاجرت CSV پر می‌شد و
 * `catalog.price` فقط یک بار — لحظه ساخت تنوع. یعنی پس از واردات
 * اولیه، کالای تازه‌ای که به مغازه می‌آمد هیچ راهی برای ثبت نداشت و
 * قیمت هیچ کالایی عوض نمی‌شد.
 *
 * ── چرا همه‌چیز از تابع دیتابیس می‌گذرد ──────────────────────────────
 *
 * این فایل هیچ `UPDATE`ی روی `catalog.price` نمی‌زند و هیچ `INSERT`ی
 * هم نه. تنها کارش صدا زدن `catalog.set_price()` است.
 *
 * دلیلش همان دلیل `apply_movement` و `post_entry` است: قاعده «قیمت
 * قبلی پاک نمی‌شود» باید جایی باشد که هیچ مسیر تازه‌ای نتواند دورش
 * بزند. یک Trigger روی `catalog.price` این را اجبار می‌کند؛ اگر
 * منطق اینجا بود، اولین اسکریپت psql از کنارش رد می‌شد.
 */
import { sql } from "kysely";
import type { Db } from "../db/client.ts";
import { parseMoney, serializeMoney } from "../lib/money.ts";
import { setActor } from "../lib/idempotency.ts";
import { CatalogError } from "./variation.ts";

export interface ProductInput {
  code: string;
  nameInternal: string;
  nameWeb?: string | undefined;
  brandId?: string | undefined;
  categoryId?: string | undefined;
  season?: string | undefined;
  collection?: string | undefined;
  fabric?: string | undefined;
  fit?: string | undefined;
  originCountry?: string | undefined;
  taxRateCode?: string | undefined;
  notes?: string | undefined;
}

export interface ProductRow {
  id: string;
  code: string;
  nameInternal: string;
  nameWeb: string | null;
  brandId: string | null;
  brandName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  season: string | null;
  collection: string | null;
  fabric: string | null;
  fit: string | null;
  originCountry: string | null;
  taxRateCode: string;
  notes: string | null;
  status: string;
  variationCount: number;
  /**
   * چند تنوع (با هر وضعیتی) همین حالا قیمت معتبر در فهرست `default`
   * دارند. برای سازگاری و اعتبارسنجی مانده؛ صفحهٔ فهرست دیگر ستونش را
   * نشان نمی‌دهد.
   */
  pricedCount: number;
  /** تنوع‌های فروختنی — `status = 'active'`، همان دروازهٔ `resolveVariation`. */
  sellableCount: number;
  /** چندتا از تنوع‌های فروختنی همین حالا قیمت معتبر دارند. */
  sellablePricedCount: number;
  /**
   * کمینه و بیشینهٔ قیمت جاری تنوع‌های فروختنیِ **قیمت‌دار** — رشتهٔ
   * ریالی. `null` یعنی هیچ تنوع فروختنی‌ای قیمت ندارد؛ هرگز صفر نیست.
   * تنوع بی‌قیمت در این بازه نمی‌آید و از `sellablePricedCount` دیده
   * می‌شود.
   */
  priceMin: string | null;
  priceMax: string | null;
}

export interface VariationRow {
  id: string;
  color: string | null;
  size: string | null;
  sku: string;
  barcode: string | null;
  status: string;
  /** قیمت باز — رشته ریالی، یا `null` وقتی هنوز قیمتی ثبت نشده. */
  price: string | null;
  priceKind: string | null;
  priceSince: string | null;
  /** آیا اصلاً حرکت انبار یا فروش داشته؟ تعیین می‌کند رنگ و سایز قفل‌اند یا نه. */
  locked: boolean;
}

export interface PriceHistoryRow {
  amount: string;
  kind: string;
  reason: string | null;
  validFrom: string;
  validTo: string | null;
  byUser: string | null;
}

export class ProductService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * فهرست کالاها با شمارش تنوع و قیمت جاری فروش.
   *
   * ── قیمت جاری یعنی همان قیمتی که صندوق می‌خواند ───────────────────
   *
   * `invoice.currentPrice` قیمت قلم را از فهرست `default` و ردیفی
   * می‌خواند که `valid_from <= اکنون` و `valid_to` تهی یا آینده دارد،
   * تازه‌ترین اول؛ و `resolveVariation` فقط تنوع `active` را می‌فروشد.
   * بازهٔ قیمت اینجا **همان دو قاعده** را دارد، پس عددی که فهرست نشان
   * می‌دهد همان عددی است که روی فاکتور می‌نشیند. قیمت در این اسکیما
   * شعبه ندارد؛ فهرست `web.price_list` سایت جداست و اینجا خوانده
   * نمی‌شود.
   *
   * تنوع بی‌قیمت اصلاً فروخته نمی‌شود (`currentPrice` خطا می‌دهد)،
   * پس صفر حساب نمی‌شود: از بازه بیرون می‌ماند و در
   * `sellablePricedCount` دیده می‌شود.
   *
   * ⚠️ یک کوئری با `LATERAL`، نه درخواست به‌ازای هر کالا یا هر تنوع.
   */
  async list(opts: {
    search?: string | undefined;
    status?: "active" | "archived" | "all" | undefined;
    limit?: number | undefined;
  } = {}): Promise<ProductRow[]> {
    const limit = Math.min(opts.limit ?? 100, 500);
    const search = opts.search?.trim();
    const status = opts.status ?? "active";

    let q = this.#db
      .selectFrom("catalog.product as p")
      .leftJoin("catalog.brand as b", "b.id", "p.brand_id")
      .leftJoin("catalog.category as c", "c.id", "p.category_id")
      // قیمت جاری هر تنوع با همان محمول `invoice.currentPrice`، و بعد
      // تجمیع به‌ازای کالا. `count(cp.amount)` فقط تنوع قیمت‌دار را
      // می‌شمارد و `min`/`max` تهی را نادیده می‌گیرند — پس قیمت نبوده
      // هرگز صفر نمی‌شود.
      .leftJoinLateral(
        sql<{
          variation_count: string;
          priced_count: string;
          sellable_count: string;
          sellable_priced_count: string;
          price_min: string | null;
          price_max: string | null;
        }>`(
          SELECT count(*)                                           AS variation_count,
                 count(cp.amount)                                   AS priced_count,
                 count(*)         FILTER (WHERE v.status = 'active') AS sellable_count,
                 count(cp.amount) FILTER (WHERE v.status = 'active') AS sellable_priced_count,
                 min(cp.amount)   FILTER (WHERE v.status = 'active') AS price_min,
                 max(cp.amount)   FILTER (WHERE v.status = 'active') AS price_max
            FROM catalog.variation v
            LEFT JOIN LATERAL (
              SELECT pr.amount
                FROM catalog.price pr
               WHERE pr.variation_id = v.id
                 AND pr.price_list = 'default'
                 AND pr.valid_from <= now()
                 AND (pr.valid_to IS NULL OR pr.valid_to > now())
               ORDER BY pr.valid_from DESC
               LIMIT 1
            ) cp ON true
           WHERE v.product_id = p.id
        )`.as("agg"),
        (j) => j.onTrue(),
      )
      .select([
        "p.id",
        "p.code",
        "p.name_internal",
        "p.name_web",
        "p.brand_id",
        "b.name as brand_name",
        "p.category_id",
        "c.name as category_name",
        "p.season",
        "p.collection",
        "p.fabric",
        "p.fit",
        "p.origin_country",
        "p.tax_rate_code",
        "p.notes",
        "p.status",
        "agg.variation_count",
        "agg.priced_count",
        "agg.sellable_count",
        "agg.sellable_priced_count",
        "agg.price_min",
        "agg.price_max",
      ])
      .orderBy("p.code")
      .limit(limit);

    if (status !== "all") q = q.where("p.status", "=", status);
    if (search !== undefined && search !== "") {
      const like = `%${search}%`;
      q = q.where((eb) =>
        eb.or([
          eb("p.code", "ilike", like),
          eb("p.name_internal", "ilike", like),
          eb("p.name_web", "ilike", like),
        ]),
      );
    }

    const rows = await q.execute();
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      nameInternal: r.name_internal,
      nameWeb: r.name_web,
      brandId: r.brand_id,
      brandName: r.brand_name,
      categoryId: r.category_id,
      categoryName: r.category_name,
      season: r.season,
      collection: r.collection,
      fabric: r.fabric,
      fit: r.fit,
      originCountry: r.origin_country,
      taxRateCode: r.tax_rate_code,
      notes: r.notes,
      status: r.status,
      variationCount: Number(r.variation_count ?? 0),
      pricedCount: Number(r.priced_count ?? 0),
      sellableCount: Number(r.sellable_count ?? 0),
      sellablePricedCount: Number(r.sellable_priced_count ?? 0),
      priceMin: r.price_min === null ? null : serializeMoney(parseMoney(r.price_min)),
      priceMax: r.price_max === null ? null : serializeMoney(parseMoney(r.price_max)),
    }));
  }

  async get(id: string): Promise<ProductRow> {
    const rows = await this.#db
      .selectFrom("catalog.product")
      .select("code")
      .where("id", "=", id)
      .execute();
    if (rows.length === 0) {
      throw new CatalogError("product_not_found", "کالا یافت نشد", 404);
    }
    const all = await this.list({ status: "all", search: rows[0]!.code });
    const found = all.find((p) => p.id === id);
    if (!found) throw new CatalogError("product_not_found", "کالا یافت نشد", 404);
    return found;
  }

  /**
   * تنوع‌های یک کالا، با قیمت باز و پرچم «قفل».
   *
   * `locked` یعنی این تنوع حرکت انبار یا سطر فاکتور دارد، پس رنگ و
   * سایزش دیگر عوض نمی‌شود. UI با همین پرچم فرم را غیرفعال می‌کند تا
   * کاربر دکمه‌ای نبیند که سرور بعداً ردش می‌کند.
   */
  async variations(productId: string): Promise<VariationRow[]> {
    const rows = await this.#db
      .selectFrom("catalog.variation as v")
      .leftJoin("catalog.price as pr", (j) =>
        j
          .onRef("pr.variation_id", "=", "v.id")
          .on("pr.valid_to", "is", null)
          .on("pr.price_list", "=", "default"),
      )
      .select((_eb) => [
        "v.id",
        "v.color",
        "v.size",
        "v.sku",
        "v.barcode",
        "v.status",
        "pr.amount as price",
        "pr.kind as price_kind",
        "pr.valid_from as price_since",
        // ⚠️ SQL خام و نه Kysely: `inventory.stock_movement` عمداً در
        // `db/types.ts` ثبت نشده تا هیچ‌کس نتواند مستقیم درجش کند —
        // تنها راه نوشتن، `inventory.apply_movement()` است. خواندنش
        // اما لازم است، پس همان‌جا با SQL صریح خوانده می‌شود.
        sql<boolean>`EXISTS (SELECT 1 FROM inventory.stock_movement m
                              WHERE m.variation_id = v.id)`.as("has_movement"),
        sql<boolean>`EXISTS (SELECT 1 FROM sales.invoice_line l
                              WHERE l.variation_id = v.id)`.as("has_sale"),
      ])
      .where("v.product_id", "=", productId)
      .orderBy("v.color")
      .orderBy("v.sku")
      .execute();

    return rows.map((r) => ({
      id: r.id,
      color: r.color,
      size: r.size,
      sku: r.sku,
      barcode: r.barcode,
      status: r.status,
      price: r.price === null ? null : serializeMoney(parseMoney(r.price)),
      priceKind: r.price_kind,
      priceSince: r.price_since === null ? null : new Date(r.price_since).toISOString(),
      locked: Boolean(r.has_movement) || Boolean(r.has_sale),
    }));
  }

  /** تاریخچه کامل قیمت یک تنوع — تازه‌ترین اول. */
  async priceHistory(variationId: string): Promise<PriceHistoryRow[]> {
    const rows = await this.#db
      .selectFrom("catalog.price as p")
      .leftJoin("identity.app_user as u", "u.id", "p.created_by")
      .select([
        "p.amount",
        "p.kind",
        "p.reason",
        "p.valid_from",
        "p.valid_to",
        "u.full_name as by_user",
      ])
      .where("p.variation_id", "=", variationId)
      .where("p.price_list", "=", "default")
      .orderBy("p.valid_from", "desc")
      .limit(200)
      .execute();

    return rows.map((r) => ({
      amount: serializeMoney(parseMoney(r.amount)),
      kind: r.kind,
      reason: r.reason,
      validFrom: new Date(r.valid_from).toISOString(),
      validTo: r.valid_to === null ? null : new Date(r.valid_to).toISOString(),
      byUser: r.by_user,
    }));
  }

  async create(input: ProductInput, actorId: string): Promise<string> {
    return this.#upsert(null, input, actorId);
  }

  async update(id: string, input: ProductInput, actorId: string): Promise<string> {
    return this.#upsert(id, input, actorId);
  }

  async #upsert(
    id: string | null,
    input: ProductInput,
    actorId: string,
  ): Promise<string> {
    return this.#db.transaction().execute(async (trx) => {
      await setActor(trx, actorId);
      const r = await sql<{ upsert_product: string }>`
        SELECT catalog.upsert_product(
          ${id}::uuid, ${input.code}, ${input.nameInternal},
          ${input.nameWeb ?? null}, ${input.brandId ?? null}::uuid,
          ${input.categoryId ?? null}::uuid, ${input.season ?? null},
          ${input.collection ?? null}, ${input.fabric ?? null},
          ${input.fit ?? null}, ${input.originCountry ?? null},
          ${input.taxRateCode ?? "standard"}, ${input.notes ?? null})
      `.execute(trx);
      const out = r.rows[0]?.upsert_product;
      if (out === undefined) {
        throw new CatalogError("upsert_failed", "ثبت کالا انجام نشد", 500);
      }
      return out;
    });
  }

  async setProductStatus(
    id: string,
    status: "active" | "archived",
    reason: string | null,
    actorId: string,
  ): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, actorId);
      await sql`SELECT catalog.set_product_status(${id}::uuid, ${status}, ${reason})`.execute(
        trx,
      );
    });
  }

  async setVariationStatus(
    id: string,
    status: "active" | "paused" | "preorder" | "archived",
    reason: string | null,
    actorId: string,
  ): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, actorId);
      await sql`SELECT catalog.set_variation_status(${id}::uuid, ${status}, ${reason})`.execute(
        trx,
      );
    });
  }

  async amendVariation(
    id: string,
    color: string | null,
    size: string | null,
    actorId: string,
  ): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, actorId);
      await sql`SELECT catalog.amend_variation(${id}::uuid, ${color}, ${size})`.execute(
        trx,
      );
    });
  }

  /**
   * تغییر قیمت.
   *
   * ⚠️ `amount` از کلاینت می‌آید و **این درست است** — برعکس فروش.
   * قیمت فروش یک تصمیم مالک است و هیچ‌جای دیگری در دیتابیس نیست تا از
   * آن خوانده شود. محافظ جای دیگری است: مجوز `price.change` که فقط
   * مدیر دارد، ممنوعیتش برای نشست بازشده با PIN، و ردّ حسابرسی با
   * مقدار پیش و پس.
   */
  async setPrice(input: {
    variationId: string;
    amount: bigint;
    kind: "regular" | "markdown" | "promo";
    reason: string | null;
    actorId: string;
  }): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      await setActor(trx, input.actorId);
      await sql`
        SELECT catalog.set_price(
          ${input.variationId}::uuid, ${serializeMoney(input.amount)}::platform.money,
          ${input.kind}, ${input.reason})
      `.execute(trx);
    });
  }

  /**
   * قیمت‌گذاری گروهی — یک مبلغ روی چند تنوع، در **یک تراکنش**.
   *
   * حراج فصلی روی یک مدل با ۳۰ تنوع، ۳۰ درخواست جدا یعنی نیمی از
   * تنوع‌ها قیمت تازه بگیرند و نیمی قدیم بمانند اگر وسطش چیزی بشکند.
   */
  async setPriceBulk(input: {
    variationIds: string[];
    amount: bigint;
    kind: "regular" | "markdown" | "promo";
    reason: string | null;
    actorId: string;
  }): Promise<number> {
    if (input.variationIds.length === 0) return 0;
    return this.#db.transaction().execute(async (trx) => {
      await setActor(trx, input.actorId);
      // ترتیب ثابت، تا دو درخواست گروهی همزمان بن‌بست (Deadlock) نسازند:
      // هر دو سطرها را به یک ترتیب قفل می‌کنند.
      const ids = [...new Set(input.variationIds)].sort();
      for (const id of ids) {
        await sql`
          SELECT catalog.set_price(
            ${id}::uuid, ${serializeMoney(input.amount)}::platform.money,
            ${input.kind}, ${input.reason})
        `.execute(trx);
      }
      return ids.length;
    });
  }

  /** برندها و دسته‌ها — برای پرکردن فهرست کشویی فرم. */
  async refData(): Promise<{
    brands: Array<{ id: string; name: string }>;
    categories: Array<{ id: string; name: string; path: string }>;
  }> {
    const [brands, categories] = await Promise.all([
      this.#db
        .selectFrom("catalog.brand")
        .select(["id", "name"])
        .orderBy("name")
        .execute(),
      this.#db
        .selectFrom("catalog.category")
        .select(["id", "name", "path"])
        .orderBy("path")
        .execute(),
    ]);
    return { brands, categories };
  }
}
