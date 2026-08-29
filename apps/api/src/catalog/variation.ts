/**
 * تنوع کالا — ساخت خودکار، و ماتریس موجودی.
 *
 * یک مدل پیراهن در ۵ رنگ و ۶ سایز، برای سیستم **یک کالا نیست — ۳۰
 * کالاست**: هرکدام بارکد خودش، موجودی خودش و احتمالاً قیمت خودش را
 * دارد. تا امروز باید هر ۳۰ تا دستی ثبت می‌شد. با ۲۰ مدل در هر فصل
 * می‌شود ۶۰۰ ردیف دستی — یک روز کار، و هرجا دست آدم باشد غلط تایپی هم
 * هست.
 *
 * دو قاعده که این فایل رویشان بنا شده:
 *
 * **۱. دوباره‌سازی امن است.** اگر همان ترکیب رنگ×سایز از قبل باشد، رد
 *    می‌شود — نه دوباره ساخته می‌شود نه بازنویسی. یعنی می‌شود یک رنگ
 *    تازه به مدل موجود اضافه کرد بدون ترس از خراب‌کردن بارکدهای چاپ‌شده.
 *
 * **۲. بارکد و SKU زیر یک قفل تخصیص می‌یابند.** دو نفر که هم‌زمان
 *    «ساخت خودکار» بزنند نباید یک شماره بگیرند. قفل مشورتی تراکنشی این
 *    را بدون جدول شمارنده حل می‌کند.
 */
import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { Db } from "../db/client.ts";
import type { Database } from "../db/types.ts";
import { serializeMoney } from "../lib/money.ts";
import { setActor } from "../lib/idempotency.ts";
import { makeEan13, MAX_SERIAL } from "./barcode.ts";
import { sortSizes } from "./size-order.ts";

export class CatalogError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, message: string, statusCode = 409) {
    super(message);
    this.name = "CatalogError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * کلید قفل مشورتی تخصیص بارکد و SKU.
 *
 * قفل **تراکنشی** است، پس با Commit یا Rollback خودش آزاد می‌شود و
 * نشتی ندارد. عدد فقط باید در کل برنامه یکتا باشد.
 */
const ALLOC_LOCK = 814_05;

/** سقف یک درخواست. بالاتر از این تقریباً همیشه اشتباه ورودی است. */
const MAX_COMBINATIONS = 400;

export interface GeneratedVariation {
  id: string;
  color: string | null;
  size: string | null;
  sku: string;
  barcode: string | null;
}

export interface GenerateResult {
  productId: string;
  productCode: string;
  created: GeneratedVariation[];
  /** ترکیب‌هایی که از قبل بودند — ساخته نشدند، دست هم نخوردند. */
  skipped: Array<{ color: string | null; size: string | null }>;
}

/** یک خانه از ماتریس موجودی. */
export interface MatrixCell {
  variationId: string;
  sku: string;
  barcode: string | null;
  onHand: string;
  reserved: string;
}

export interface StockMatrix {
  productId: string;
  productCode: string;
  productName: string;
  colors: Array<string | null>;
  sizes: Array<string | null>;
  /** `cells[رنگ][سایز]` — خانه نبودن یعنی این ترکیب اصلاً تعریف نشده. */
  cells: Record<string, Record<string, MatrixCell>>;
  totalOnHand: string;
  /** برای هر رنگ، سایزهایی که صفر شده‌اند — سیگنال سفارش مجدد. */
  soldOut: Array<{ color: string | null; sizes: Array<string | null> }>;
}

export class VariationService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * ساخت خودکار همه ترکیب‌های رنگ×سایز برای یک مدل.
   *
   * `colors` یا `sizes` می‌تواند تهی باشد — مدلی که فقط سایز دارد (شال)
   * یا فقط رنگ. تهی بودنِ هر دو رد می‌شود: آن‌وقت «ساخت خودکار» یعنی
   * ساخت یک تنوع بی‌مشخصه، که کار این تابع نیست.
   */
  async generate(input: {
    productId: string;
    colors: string[];
    sizes: string[];
    price?: bigint | undefined;
    actorId: string;
  }): Promise<GenerateResult> {
    const colors = dedupe(input.colors);
    const sizes = dedupe(input.sizes);

    if (colors.length === 0 && sizes.length === 0) {
      throw new CatalogError("no_attributes", "دست‌کم یک رنگ یا یک سایز لازم است", 400);
    }

    const total = Math.max(colors.length, 1) * Math.max(sizes.length, 1);
    if (total > MAX_COMBINATIONS) {
      throw new CatalogError(
        "too_many_combinations",
        `${total} ترکیب یک‌جا ساخته نمی‌شود. حداکثر ${MAX_COMBINATIONS} — رنگ یا سایزها را در چند مرحله وارد کنید.`,
        422,
      );
    }

    const product = await this.#db
      .selectFrom("catalog.product")
      .select(["id", "code", "name_internal"])
      .where("id", "=", input.productId)
      .executeTakeFirst();
    if (!product) throw new CatalogError("product_not_found", "کالا یافت نشد", 404);

    const combos: Array<{ color: string | null; size: string | null }> = [];
    for (const color of colors.length > 0 ? colors : [null]) {
      for (const size of sizes.length > 0 ? sizes : [null]) {
        combos.push({ color, size });
      }
    }

    return this.#db.transaction().execute(async (trx) => {
      await setActor(trx, input.actorId);
      // از اینجا تا Commit، تخصیص شماره فقط دست ماست.
      await sql`SELECT pg_advisory_xact_lock(${ALLOC_LOCK})`.execute(trx);

      const existing = await trx
        .selectFrom("catalog.variation")
        .select(["color", "size", "sku"])
        .where("product_id", "=", input.productId)
        .execute();
      const seen = new Set(existing.map((e) => comboKey(e.color, e.size)));

      const todo = combos.filter((c) => !seen.has(comboKey(c.color, c.size)));
      const skipped = combos.filter((c) => seen.has(comboKey(c.color, c.size)));

      let serial = await nextBarcodeSerial(trx);
      let seq = nextSkuSeq(product.code, existing.map((e) => e.sku));
      const created: GeneratedVariation[] = [];

      for (const combo of todo) {
        if (serial > MAX_SERIAL) {
          throw new CatalogError(
            "barcode_space_exhausted",
            "شماره‌های بارکد داخلی تمام شده‌اند",
            500,
          );
        }
        const row = await trx
          .insertInto("catalog.variation")
          .values({
            product_id: product.id,
            color: combo.color,
            size: combo.size,
            sku: `${product.code}-${String(seq).padStart(3, "0")}`,
            barcode: makeEan13(serial),
            status: "active",
          })
          .returning(["id", "color", "size", "sku", "barcode"])
          .executeTakeFirstOrThrow();

        created.push(row);
        serial += 1;
        seq += 1;

        // قیمت اختیاری است. مدلی که هنوز قیمت‌گذاری نشده تنوع‌هایش
        // ساخته می‌شوند ولی فروخته نمی‌شوند — `invoice.addLine` بدون
        // قیمت جاری خطا می‌دهد، و همان درست است.
        if (input.price !== undefined) {
          await trx
            .insertInto("catalog.price")
            .values({
              variation_id: row.id,
              price_list: "default",
              amount: serializeMoney(input.price),
              kind: "regular",
              reason: null,
              valid_to: null,
              created_by: input.actorId,
            })
            .execute();
        }
      }

      return { productId: product.id, productCode: product.code, created, skipped };
    });
  }

  /**
   * ماتریس موجودی یک مدل — سطر رنگ، ستون سایز.
   *
   * `warehouseIds` تهی یعنی جمع همه انبارها. صندوق‌دار معمولاً انبار
   * فروشگاه را می‌خواهد و مدیر جمع کل را.
   */
  async stockMatrix(
    productId: string,
    warehouseIds: string[] | null,
  ): Promise<StockMatrix> {
    const product = await this.#db
      .selectFrom("catalog.product")
      .select(["id", "code", "name_internal"])
      .where("id", "=", productId)
      .executeTakeFirst();
    if (!product) throw new CatalogError("product_not_found", "کالا یافت نشد", 404);

    const allWarehouses = warehouseIds === null;
    const ids = warehouseIds ?? [];

    // جمع در SQL، نه در جاوااسکریپت — `on_hand` سه رقم اعشار دارد و
    // جمع شناور روی چند انبار همان خطایی را می‌دهد که یک بار روی
    // `qty × price` گرفتیمش.
    const rows = await sql<{
      id: string;
      color: string | null;
      size: string | null;
      sku: string;
      barcode: string | null;
      on_hand: string;
      reserved: string;
    }>`
      SELECT v.id, v.color, v.size, v.sku, v.barcode,
             coalesce(sum(sb.on_hand),  0)::text AS on_hand,
             coalesce(sum(sb.reserved), 0)::text AS reserved
        FROM catalog.variation v
        LEFT JOIN inventory.stock_balance sb
               ON sb.variation_id = v.id
              AND (${allWarehouses}::boolean
                   OR sb.warehouse_id = ANY(${ids}::uuid[]))
       WHERE v.product_id = ${productId}::uuid
         AND v.status <> 'archived'
       GROUP BY v.id, v.color, v.size, v.sku, v.barcode
    `.execute(this.#db);

    const colors = uniqueInOrder(rows.rows.map((r) => r.color));
    const sizes = sortSizes(uniqueInOrder(rows.rows.map((r) => r.size)));

    const cells: Record<string, Record<string, MatrixCell>> = {};
    for (const r of rows.rows) {
      const row = (cells[label(r.color)] ??= {});
      row[label(r.size)] = {
        variationId: r.id,
        sku: r.sku,
        barcode: r.barcode,
        onHand: r.on_hand,
        reserved: r.reserved,
      };
    }

    // جمع کل هم در SQL. جمع‌زدن رشته‌های `on_hand` در جاوااسکریپت
    // یعنی برگرداندنِ همان خطای شناوری که بالا از آن پرهیز شد.
    const totalRow = await sql<{ t: string }>`
      SELECT coalesce(sum(x.on_hand), 0)::text AS t FROM (
        SELECT coalesce(sum(sb.on_hand), 0) AS on_hand
          FROM catalog.variation v
          LEFT JOIN inventory.stock_balance sb
                 ON sb.variation_id = v.id
                AND (${allWarehouses}::boolean
                     OR sb.warehouse_id = ANY(${ids}::uuid[]))
         WHERE v.product_id = ${productId}::uuid
           AND v.status <> 'archived'
         GROUP BY v.id) x
    `.execute(this.#db);

    const soldOut = colors
      .map((color) => ({
        color,
        sizes: sizes.filter((size) => {
          const cell = cells[label(color)]?.[label(size)];
          return cell !== undefined && Number(cell.onHand) <= 0;
        }),
      }))
      .filter((s) => s.sizes.length > 0);

    return {
      productId: product.id,
      productCode: product.code,
      productName: product.name_internal,
      colors,
      sizes,
      cells,
      totalOnHand: totalRow.rows[0]?.t ?? "0",
      soldOut,
    };
  }
}

/**
 * شماره سریال بعدی بارکد داخلی.
 *
 * از خودِ بارکدهای موجود خوانده می‌شود، نه از یک شمارنده جدا — شمارنده
 * جدا می‌تواند با داده واقعی از هم بیفتد و آن‌وقت درج روی قید یکتایی
 * می‌شکند بی‌آنکه کسی بفهمد چرا. فقط بارکدهای **خودمان** شمرده می‌شوند؛
 * بارکد کارخانه‌ای که روی کالا چسبیده در این محدوده نیست.
 */
async function nextBarcodeSerial(trx: Transaction<Database>): Promise<number> {
  const r = await sql<{ next: string }>`
    SELECT coalesce(max(substring(barcode from 3 for 10)::bigint), 0) + 1 AS next
      FROM catalog.variation
     WHERE barcode ~ '^20[0-9]{11}$'
  `.execute(trx);
  return Number(r.rows[0]?.next ?? 1);
}

/**
 * شماره ترتیبی بعدی SKU برای همین مدل — از روی SKUهای موجودِ خودش.
 *
 * این یک بار در SQL نوشته شده بود، با
 * `max(substring(sku from $1)::bigint)`، و **بی‌صدا غلط جواب می‌داد**:
 * پارامتر بدون Cast از نوع `text` بسته می‌شود و پستگرس آن‌وقت نسخه
 * **Regex** تابع `substring(text from text)` را انتخاب می‌کند، نه نسخه
 * موقعیتی را. نتیجه `NULL` بود، `coalesce` صفرش می‌کرد، و شماره‌گذاری
 * از ۰۰۱ شروع می‌شد — تا روی قید یکتایی بشکند. نه خطایی، نه هشداری.
 *
 * حالا از همان سطرهایی حساب می‌شود که برای یافتن ترکیب‌های تکراری
 * خوانده شده‌اند: یک کوئری کمتر، و بدون هیچ فرضی درباره اینکه شمارش
 * نویسه در جاوااسکریپت و پستگرس یکی است.
 */
function nextSkuSeq(productCode: string, existingSkus: string[]): number {
  const prefix = `${productCode}-`;
  let max = 0;
  for (const sku of existingSkus) {
    if (!sku.startsWith(prefix)) continue;
    const tail = sku.slice(prefix.length);
    if (!/^\d+$/.test(tail)) continue;
    max = Math.max(max, Number(tail));
  }
  return max + 1;
}

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const v = raw.trim();
    if (v === "" || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function comboKey(color: string | null, size: string | null): string {
  return `${color ?? " "}|${size ?? " "}`;
}

/** `null` کلید JSON نمی‌شود؛ یک برچسب ثابت جایش می‌گیرد. */
function label(v: string | null): string {
  return v ?? "—";
}

function uniqueInOrder(values: Array<string | null>): Array<string | null> {
  const out: Array<string | null> = [];
  const seen = new Set<string>();
  for (const v of values) {
    const k = label(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

export function generateToJson(r: GenerateResult) {
  return {
    productId: r.productId,
    productCode: r.productCode,
    createdCount: r.created.length,
    skippedCount: r.skipped.length,
    created: r.created,
    skipped: r.skipped,
  };
}
