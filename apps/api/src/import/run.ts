/**
 * مهاجرت داده از سیستم فعلی.
 *
 * ── سه قاعده که این ماژول رویشان ایستاده ────────────────────────────
 *
 * ۱. **همه یا هیچ.** هر پنج فایل اعتبارسنجی می‌شوند و تنها اگر
 *    **هیچ** خطایی نبود، نوشتن شروع می‌شود — آن هم در یک تراکنش.
 *    وارداتِ نیمه‌کاره از واردات‌نشده بدتر است: کاتالوگی که نصفش
 *    آمده و کسی نمی‌داند از کجا ادامه دهد.
 *
 * ۲. **پیش‌فرض، آزمایشی است.** بدون `--commit` هیچ‌چیز نوشته نمی‌شود؛
 *    فقط گزارش می‌آید. مهاجرت داده کاری است که یک بار انجام می‌شود و
 *    برگرداندنش سخت است.
 *
 * ۳. **تکرارپذیر.** `platform.external_id_map` می‌گوید کدام سطر
 *    قبلاً آمده. اجرای دوباره کالای تکراری نمی‌سازد — ولی
 *    **موجودی و سند افتتاحیه را هم دوباره نمی‌زند**، که مهم‌تر است:
 *    یک اجرای دوباره نباید موجودی را دو برابر کند.
 *
 * ── و یک قاعده که از دیتابیس می‌آید، نه از اینجا ────────────────────
 *
 * موجودی فقط از `inventory.apply_movement()` و سند فقط از
 * `ledger.post_opening_balance()`. این ماژول هیچ `INSERT` مستقیمی در
 * `stock_movement` یا `journal_line` نمی‌زند و نمی‌تواند بزند.
 */
import { sql } from "kysely";
import type { Transaction } from "kysely";
import type { Db } from "../db/client.ts";
import type { Database } from "../db/types.ts";
import { serializeMoney } from "../lib/money.ts";
import { toTable, CsvError, normalizeDigits } from "./csv.ts";
import {
  FILES,
  validateRows,
  type CustomerRow,
  type FileName,
  type OpeningRow,
  type ProductRow,
  type RowError,
  type StockRow,
  type SupplierRow,
  type ValidRow,
} from "./schema.ts";

/** منبع در `platform.external_id_map`. */
const SOURCE = "legacy_acc";

export interface ImportInput {
  files: Partial<Record<FileName, string>>;
  branchId: string;
  warehouseId: string;
  fiscalYear: number;
  actorId: string;
  /** بدون این، هیچ‌چیز نوشته نمی‌شود. */
  commit: boolean;
}

export interface ImportPlan {
  products: { create: number; existing: number };
  customers: { create: number; existing: number };
  suppliers: { create: number; existing: number };
  stock: { lines: number; totalValue: bigint };
  opening: {
    cash: bigint;
    bank: bigint;
    receivable: bigint;
    payable: bigint;
    inventory: bigint;
    /** رقم متوازن‌کننده — محاسبه‌شده، نه ورودی. */
    equity: bigint;
  };
  warnings: string[];
}

export interface ImportResult {
  plan: ImportPlan;
  errors: RowError[];
  committed: boolean;
  openingEntryId: string | null;
}

export class ImportError extends Error {
  readonly statusCode = 422;
  readonly code = "import_failed";

  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

/** یک فایل را می‌خواند و می‌سنجد. نبودنش خطا نیست — همه اجباری نیستند. */
function readFile<K extends FileName>(
  files: Partial<Record<FileName, string>>,
  name: K,
): { rows: ValidRow<unknown>[]; errors: RowError[] } {
  const raw = files[name];
  if (raw === undefined) return { rows: [], errors: [] };

  try {
    const table = toTable(raw);
    const { ok, errors } = validateRows(name, FILES[name], table.rows);
    return { rows: ok, errors };
  } catch (err) {
    if (err instanceof CsvError) {
      return {
        rows: [],
        errors: [{ file: name, line: err.line, column: "—", message: err.message }],
      };
    }
    throw err;
  }
}

/**
 * اجرای مهاجرت.
 *
 * حتی با `commit: false` هم همه چیز سنجیده می‌شود و نقشه کامل
 * برمی‌گردد — پس گزارش آزمایشی دقیقاً همان چیزی است که اجرای واقعی
 * انجام می‌دهد.
 */
export async function runImport(db: Db, input: ImportInput): Promise<ImportResult> {
  const errors: RowError[] = [];

  const p = readFile(input.files, "products.csv");
  const c = readFile(input.files, "customers.csv");
  const s = readFile(input.files, "suppliers.csv");
  const st = readFile(input.files, "opening-stock.csv");
  const ob = readFile(input.files, "opening-balances.csv");

  errors.push(...p.errors, ...c.errors, ...s.errors, ...st.errors, ...ob.errors);

  const products = p.rows as ValidRow<ProductRow>[];
  const customers = c.rows as ValidRow<CustomerRow>[];
  const suppliers = s.rows as ValidRow<SupplierRow>[];
  const stock = st.rows as ValidRow<StockRow>[];
  const opening = ob.rows as ValidRow<OpeningRow>[];

  const warnings: string[] = [];

  // ── سنجش‌های میان‌فایلی ─────────────────────────────────────────
  //
  // این‌ها را Zod نمی‌تواند بگیرد چون به **بقیه فایل‌ها** ربط دارند —
  // و دقیقاً همان‌هایی‌اند که در اجرای واقعی نصفه‌کاره‌شان می‌کنند.

  const skus = new Set<string>();
  for (const { value: row, line } of products) {
    if (skus.has(row.sku)) {
      errors.push({
        file: "products.csv",
        line,
        column: "sku",
        message: `SKU تکراری: ${row.sku}`,
      });
    }
    skus.add(row.sku);
  }

  // ⚠️ بارکد تکراری هم رد می‌شود، و اینجا نه وسط تراکنش.
  //
  //    `catalog.variation.barcode` قید یکتایی دارد. بدون این سنجش،
  //    فایلی با دو بارکد یکسان تا **وسط نوشتن** می‌رفت و بعد با یک
  //    خطای خام پستگرس می‌مرد — بدون نام فایل، بدون شماره خط، و
  //    بدون اینکه معلوم باشد کدام دو سطر مقصرند.
  const barcodes = new Map<string, number>();
  for (const { value: row, line } of products) {
    if (row.barcode === "") continue;
    const first = barcodes.get(row.barcode);
    if (first !== undefined) {
      errors.push({
        file: "products.csv",
        line,
        column: "barcode",
        message: `بارکد «${row.barcode}» تکراری است — خط ${first} هم همین را دارد`,
      });
    } else {
      barcodes.set(row.barcode, line);
    }
  }

  // بارکدی که از قبل روی کالای دیگری نشسته، همان قید را می‌شکند.
  if (barcodes.size > 0) {
    const taken = await db
      .selectFrom("catalog.variation")
      .select(["barcode", "sku"])
      .where("barcode", "in", [...barcodes.keys()])
      .execute();
    const bySku = new Map(products.map((x) => [x.value.barcode, x.value.sku]));
    for (const t of taken) {
      if (t.barcode === null) continue;
      // همان کالا با همان بارکد، تکرار نیست — اجرای دوباره است.
      if (bySku.get(t.barcode) === t.sku) continue;
      errors.push({
        file: "products.csv",
        line: barcodes.get(t.barcode) as number,
        column: "barcode",
        message: `بارکد «${t.barcode}» از قبل روی کالای «${t.sku}» است`,
      });
    }
  }

  // موجودیِ کالایی که در فایل کالاها نیست، جایی برای نشستن ندارد.
  for (const { value: row, line } of stock) {
    if (!skus.has(row.sku)) {
      errors.push({
        file: "opening-stock.csv",
        line,
        column: "sku",
        message: `SKU «${row.sku}» در فایل کالاها نیست`,
      });
    }
    if (Number(row.qty) <= 0) {
      warnings.push(`موجودی «${row.sku}» صفر یا منفی است و رد می‌شود`);
    } else if (row.unit_cost === 0n) {
      // بهای صفرِ **نوشته‌شده** یک تصمیم است، نه یک فراموشی (سلول
      // خالی خطا می‌گیرد). ولی باید دیده شود: اولین فروش این کالا
      // سودِ صددرصد نشان می‌دهد.
      warnings.push(
        `بهای تمام‌شده «${row.sku}» صفر نوشته شده — اولین فروشش سودِ صددرصد نشان می‌دهد`,
      );
    }
  }

  // ── تطبیق شخص ───────────────────────────────────────────────────
  //
  // ⚠️ کلید تطبیق **نرمال‌شده** است، نه رشته خام. فایل مشتریان و فایل
  //    مانده‌ها را یک نفر در دو Sheet می‌سازد و هیچ تضمینی نیست که
  //    شماره را در هر دو یک‌شکل بنویسد: یکی «۰۹۱۲…» فارسی و دیگری
  //    «0912…» لاتین. با مقایسه خام، مشتریِ موجود «در فایل مشتریان
  //    نیست» گزارش می‌شد — خطایی که کاربر هرچه نگاه کند دلیلش را
  //    نمی‌فهمد، چون هر دو شماره «به نظر» یکی‌اند.
  const mobiles = new Set(customers.map((x) => mobileKey(x.value.mobile)));
  const codes = new Set(suppliers.map((x) => x.value.code));

  for (const { value: row, line } of customers) {
    // موبایل نامعتبر باید **اینجا** گرفته شود، نه هنگام نوشتن:
    // اجرای آزمایشی سبز می‌داد و اجرای واقعی وسط کار می‌شکست.
    if (mobileKey(row.mobile) === "") {
      errors.push({
        file: "customers.csv",
        line,
        column: "mobile",
        message: `«${row.mobile}» شماره موبایل معتبری نیست`,
      });
    }
  }

  for (const { value: row, line } of opening) {
    const needsParty = row.leg === "receivable" || row.leg === "payable";
    if (needsParty && row.party === "") {
      errors.push({
        file: "opening-balances.csv",
        line,
        column: "party",
        message: `مؤلفه «${row.leg}» بدون شخص ثبت نمی‌شود — گردش حساب اشخاص از دفتر ساختنی نیست`,
      });
    }
    if (row.leg === "receivable" && row.party !== "" && !mobiles.has(mobileKey(row.party))) {
      errors.push({
        file: "opening-balances.csv",
        line,
        column: "party",
        message: `مشتری با موبایل «${row.party}» در فایل مشتریان نیست`,
      });
    }
    if (row.leg === "payable" && row.party !== "" && !codes.has(row.party)) {
      errors.push({
        file: "opening-balances.csv",
        line,
        column: "party",
        message: `تأمین‌کننده با کد «${row.party}» در فایل تأمین‌کنندگان نیست`,
      });
    }
    if (row.amount <= 0n) {
      errors.push({
        file: "opening-balances.csv",
        line,
        column: "amount",
        message: "مانده افتتاحیه باید مثبت باشد — جهت از مؤلفه می‌آید، نه از علامت",
      });
    }
  }

  // ── نقشه ────────────────────────────────────────────────────────

  const sum = (leg: OpeningRow["leg"]) =>
    opening.filter((x) => x.value.leg === leg).reduce((a, x) => a + x.value.amount, 0n);

  // ارزش موجودی در **SQL** حساب می‌شود، نه اینجا: `qty` اعشاری است و
  // تقسیم صحیح bigint نتیجه‌ای می‌دهد که با جمع دیتابیس یکی نیست.
  let inventoryValue = 0n;
  if (stock.length > 0) {
    const r = await sql<{ total: string }>`
      SELECT coalesce(sum(round(q::numeric * c::numeric)), 0)::text AS total
        FROM unnest(
          ${sql.val(stock.map((x) => x.value.qty))}::text[],
          ${sql.val(stock.map((x) => serializeMoney(x.value.unit_cost)))}::text[]
        ) AS t(q, c)
       WHERE q::numeric > 0
    `.execute(db);
    inventoryValue = BigInt(r.rows[0]?.total ?? "0");
  }

  const cash = sum("cash");
  const bank = sum("bank");
  const receivable = sum("receivable");
  const payable = sum("payable");

  // ⚠️ سرمایه **رقم متوازن‌کننده** است، نه یک ورودی: دارایی منهای
  //    بدهی. اگر ورودی بود و سند را متوازن نمی‌کرد، فقط یک خطای
  //    دیرهنگام می‌ساخت.
  const equity = inventoryValue + cash + bank + receivable - payable;
  if (equity < 0n) {
    warnings.push(
      "سرمایه محاسبه‌شده منفی است: بدهی‌ها از دارایی‌ها بیشترند. " +
        "این ممکن است درست باشد، ولی حسابدار باید تأییدش کند.",
    );
  }

  const existing = await existingKeys(db, products, customers, suppliers);

  const plan: ImportPlan = {
    products: {
      create: products.filter((x) => !existing.skus.has(x.value.sku)).length,
      existing: products.filter((x) => existing.skus.has(x.value.sku)).length,
    },
    customers: {
      create: customers.filter((x) => !existing.mobiles.has(mobileKey(x.value.mobile))).length,
      existing: customers.filter((x) => existing.mobiles.has(mobileKey(x.value.mobile))).length,
    },
    suppliers: {
      create: suppliers.filter((x) => !existing.codes.has(x.value.code)).length,
      existing: suppliers.filter((x) => existing.codes.has(x.value.code)).length,
    },
    stock: {
      lines: stock.filter((x) => Number(x.value.qty) > 0).length,
      totalValue: inventoryValue,
    },
    opening: { cash, bank, receivable, payable, inventory: inventoryValue, equity },
    warnings,
  };

  if (errors.length > 0 || !input.commit) {
    return { plan, errors, committed: false, openingEntryId: null };
  }

  const openingEntryId = await write(db, input, {
    products,
    customers,
    suppliers,
    stock,
    opening,
    equity,
  });

  return { plan, errors, committed: true, openingEntryId };
}

/**
 * کلید تطبیق موبایل — فقط برای **مقایسه داخل همین ابزار**.
 *
 * ⚠️ این جایگزین `sales.normalize_mobile()` نیست و نباید باشد: مرجعِ
 *    ذخیره همان تابع دیتابیس است و `upsertCustomer` از آن استفاده
 *    می‌کند. اینجا فقط باید بشود فهمید «آیا این شماره در فایل
 *    مشتریان هست» — بدون یک رفت‌وبرگشت دیتابیس به‌ازای هر سطر.
 *
 * ⚠️ **رقم فارسی اول لاتین می‌شود.** نسخه اول مستقیم `\D` را حذف
 *    می‌کرد و «۰۹۱۲۱۱۱۲۲۳۳» را به رشته **خالی** تبدیل می‌کرد — یعنی
 *    مشتریِ فارسی‌نوشته هرگز «موجود» شناخته نمی‌شد و در هر اجرای
 *    دوباره «تازه» شمرده می‌شد.
 *
 * رشته خالی یعنی «موبایل نیست» و خطای اعتبارسنجی می‌سازد.
 */
export function mobileKey(raw: string): string {
  const digits = normalizeDigits(raw).replace(/\D/g, "");
  // ترتیب مهم است: «0098…» با الگوی «98…» هم می‌خواند.
  if (/^0098\d{10}$/.test(digits)) return `0${digits.slice(4)}`;
  if (/^98\d{10}$/.test(digits)) return `0${digits.slice(2)}`;
  if (/^09\d{9}$/.test(digits)) return digits;
  if (/^9\d{9}$/.test(digits)) return `0${digits}`;
  return "";
}

async function existingKeys(
  db: Db,
  products: ValidRow<ProductRow>[],
  customers: ValidRow<CustomerRow>[],
  suppliers: ValidRow<SupplierRow>[],
): Promise<{ skus: Set<string>; mobiles: Set<string>; codes: Set<string> }> {
  const skus = new Set<string>();
  const mobiles = new Set<string>();
  const codes = new Set<string>();

  if (products.length > 0) {
    const r = await db
      .selectFrom("catalog.variation")
      .select("sku")
      .where(
        "sku",
        "in",
        products.map((x) => x.value.sku),
      )
      .execute();
    for (const x of r) skus.add(x.sku);
  }
  if (customers.length > 0) {
    const r = await sql<{ m: string }>`
      SELECT mobile_normalized AS m FROM sales.customer
       WHERE mobile_normalized = ANY(
         SELECT sales.normalize_mobile(x) FROM unnest(
           ${sql.val(customers.map((c) => c.value.mobile))}::text[]) AS x)
    `.execute(db);
    for (const x of r.rows) mobiles.add(mobileKey(x.m));
  }
  if (suppliers.length > 0) {
    const r = await db
      .selectFrom("purchasing.supplier")
      .select("code")
      .where(
        "code",
        "in",
        suppliers.map((x) => x.value.code),
      )
      .execute();
    for (const x of r) codes.add(x.code);
  }
  return { skus, mobiles, codes };
}

/**
 * نوشتن — همه در یک تراکنش.
 *
 * ترتیب اهمیت دارد و تصادفی نیست: کالا پیش از موجودی، و اشخاص پیش از
 * سند افتتاحیه. سند آخر است چون به شناسه اشخاص نیاز دارد.
 */
async function write(
  db: Db,
  input: ImportInput,
  data: {
    products: ValidRow<ProductRow>[];
    customers: ValidRow<CustomerRow>[];
    suppliers: ValidRow<SupplierRow>[];
    stock: ValidRow<StockRow>[];
    opening: ValidRow<OpeningRow>[];
    equity: bigint;
  },
): Promise<string | null> {
  return await db.transaction().execute(async (trx) => {
    await sql`SELECT platform.set_actor(${input.actorId}::uuid)`.execute(trx);

    const variationBySku = new Map<string, string>();
    for (const { value: row } of data.products) {
      variationBySku.set(row.sku, await upsertProduct(trx, row));
    }

    // ⚠️ کلید نگاشت **نرمال‌شده** است، همان کلیدی که اعتبارسنجی با آن
    //    تطبیق داد. با کلید خام، مانده‌ای که شماره‌اش لاتین نوشته شده
    //    مشتریِ فارسی‌نوشته را پیدا نمی‌کرد و `party_id` تهی می‌ماند.
    const customerByMobile = new Map<string, string>();
    for (const { value: row } of data.customers) {
      customerByMobile.set(mobileKey(row.mobile), await upsertCustomer(trx, row));
    }

    const supplierByCode = new Map<string, string>();
    for (const { value: row } of data.suppliers) {
      supplierByCode.set(row.code, await upsertSupplier(trx, row));
    }

    // ── موجودی: فقط از دروازه ───────────────────────────────────
    //
    // ⚠️ `apply_movement` تنها راه تغییر موجودی است. اگر روزی کسی
    //    اینجا `INSERT` مستقیم بزند، Trigger دیتابیس ردش می‌کند —
    //    و باید بکند.
    for (const { value: row } of data.stock) {
      if (Number(row.qty) <= 0) continue;
      const variationId = variationBySku.get(row.sku);
      if (!variationId) throw new ImportError(`SKU «${row.sku}» یافت نشد`);

      // Idempotency: کالایی که قبلاً موجودی افتتاحیه گرفته، دوباره
      // نمی‌گیرد. بدون این، اجرای دوباره موجودی را دو برابر می‌کرد.
      const already = await sql<{ n: string }>`
        SELECT count(*)::text AS n FROM inventory.stock_movement
         WHERE variation_id = ${variationId}::uuid
           AND warehouse_id = ${input.warehouseId}::uuid
           AND kind = 'opening'
      `.execute(trx);
      if (already.rows[0]!.n !== "0") continue;

      await sql`
        SELECT inventory.apply_movement(
          ${variationId}::uuid, ${input.warehouseId}::uuid,
          ${row.qty}::platform.qty, 'opening', NULL, NULL,
          ${input.actorId}::uuid, ${serializeMoney(row.unit_cost)}::platform.money)
      `.execute(trx);
    }

    // ── سند افتتاحیه: فقط از دروازه ─────────────────────────────
    const legs: Record<string, unknown>[] = [];

    const inventoryValue = await sql<{ total: string }>`
      SELECT coalesce(sum(value_delta), 0)::text AS total
        FROM inventory.stock_movement
       WHERE warehouse_id = ${input.warehouseId}::uuid AND kind = 'opening'
    `.execute(trx);
    const invValue = BigInt(inventoryValue.rows[0]?.total ?? "0");
    if (invValue > 0n) {
      legs.push({ leg: "inventory", amount: serializeMoney(invValue) });
    }

    for (const { value: row } of data.opening) {
      const base: Record<string, unknown> = {
        leg: row.leg,
        amount: serializeMoney(row.amount),
      };
      if (row.leg === "receivable") {
        base["party_type"] = "customer";
        base["party_id"] = customerByMobile.get(mobileKey(row.party));
      } else if (row.leg === "payable") {
        base["party_type"] = "supplier";
        base["party_id"] = supplierByCode.get(row.party);
      }
      legs.push(base);
    }

    // سرمایه از **موجودی واقعیِ ثبت‌شده** دوباره حساب می‌شود، نه از
    // عددی که در مرحله نقشه ساخته شد: اگر بخشی از موجودی به‌خاطر
    // Idempotency رد شده باشد، آن عدد دیگر درست نیست.
    const legSum = (leg: OpeningRow["leg"]) =>
      data.opening.filter((x) => x.value.leg === leg).reduce((a, x) => a + x.value.amount, 0n);
    const equity =
      invValue + legSum("cash") + legSum("bank") + legSum("receivable") - legSum("payable");

    // ⚠️ واردات **فقط کاتالوگ** یک حالت پشتیبانی‌شده است: کسی که
    //    می‌خواهد اول کالاها را بیاورد و مانده‌ها را بعداً.
    //
    //    نسخه اول اینجا خطا می‌داد و کل تراکنش را برمی‌گرداند — یعنی
    //    هیچ کالایی هم نوشته نمی‌شد، و CLI با Stack Trace می‌مرد.
    //    سند بدون سطر معنا ندارد، ولی «سندی لازم نیست» یک شکست نیست.
    if (legs.length === 0) return null;

    legs.push({ leg: "equity", amount: serializeMoney(equity) });

    const entry = await sql<{ post_opening_balance: string }>`
      SELECT ledger.post_opening_balance(
        ${input.branchId}::uuid, ${input.fiscalYear}::smallint,
        ${JSON.stringify(legs)}::jsonb, ${input.actorId}::uuid)
    `.execute(trx);

    return entry.rows[0]!.post_opening_balance;
  });
}

/** کالا + تنوع. کالای موجود دست‌نخورده می‌ماند. */
async function upsertProduct(
  trx: Transaction<Database>,
  row: ProductRow,
): Promise<string> {
  const found = await trx
    .selectFrom("catalog.variation")
    .select("id")
    .where("sku", "=", row.sku)
    .executeTakeFirst();
  // ⚠️ کالای موجود **به‌روز نمی‌شود**. مهاجرت داده یک بار انجام
  //    می‌شود؛ اجرای دوم نباید نامی را که کسی در سیستم اصلاح کرده،
  //    به مقدار فایل قدیمی برگرداند.
  if (found) return found.id;

  const product = await trx
    .insertInto("catalog.product")
    .values({
      // کد کالا از SKU ساخته می‌شود: در سیستم قبلی کد کالا و کد تنوع
      // معمولاً یکی‌اند، و ساختن یک کد تازه فقط یک شناسه بی‌ریشه بود.
      code: row.sku,
      name_internal: row.name,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  const variation = await trx
    .insertInto("catalog.variation")
    .values({
      product_id: product.id,
      sku: row.sku,
      color: row.color === "" ? null : row.color,
      size: row.size === "" ? null : row.size,
      barcode: row.barcode === "" ? null : row.barcode,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  if (row.price !== undefined && row.price > 0n) {
    await trx
      .insertInto("catalog.price")
      .values({
        variation_id: variation.id,
        price_list: "default",
        amount: serializeMoney(row.price),
      })
      .execute();
  }

  if (row.legacy_id !== "") {
    await mapExternal(trx, "variation", row.legacy_id, variation.id);
  }
  return variation.id;
}

async function upsertCustomer(
  trx: Transaction<Database>,
  row: CustomerRow,
): Promise<string> {
  const norm = await sql<{ m: string | null }>`
    SELECT sales.normalize_mobile(${row.mobile}) AS m
  `.execute(trx);
  const mobile = norm.rows[0]?.m;
  if (!mobile) throw new ImportError(`موبایل «${row.mobile}» معتبر نیست`);

  const found = await trx
    .selectFrom("sales.customer")
    .select("id")
    .where("mobile_normalized", "=", mobile)
    .executeTakeFirst();
  if (found) return found.id;

  const created = await trx
    .insertInto("sales.customer")
    .values({
      mobile_normalized: mobile,
      full_name: row.name === "" ? null : row.name,
      ...(row.credit_limit !== undefined
        ? { credit_limit: serializeMoney(row.credit_limit) }
        : {}),
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  if (row.legacy_id !== "") {
    await mapExternal(trx, "customer", row.legacy_id, created.id);
  }
  return created.id;
}

async function upsertSupplier(
  trx: Transaction<Database>,
  row: SupplierRow,
): Promise<string> {
  const found = await trx
    .selectFrom("purchasing.supplier")
    .select("id")
    .where("code", "=", row.code)
    .executeTakeFirst();
  if (found) return found.id;

  const created = await trx
    .insertInto("purchasing.supplier")
    .values({
      code: row.code,
      name: row.name,
      mobile: row.mobile === "" ? null : row.mobile,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  if (row.legacy_id !== "") {
    await mapExternal(trx, "supplier", row.legacy_id, created.id);
  }
  return created.id;
}

/**
 * نگاشت شناسه سیستم قبلی → شناسه ما.
 *
 * ⚠️ هیچ شناسه خارجی کلید اصلی نیست (قاعده `external_id_map` از
 *    مهاجرت ۰۰۱). این جدول فقط برای **رهگیری** است: «این کالا در
 *    سیستم قبلی کدام بود» — سؤالی که ماه‌ها بعد، وسط یک مغایرت‌گیری،
 *    کسی می‌پرسد.
 */
async function mapExternal(
  trx: Transaction<Database>,
  entityType: string,
  externalId: string,
  entityId: string,
): Promise<void> {
  await sql`
    INSERT INTO platform.external_id_map (source, entity_type, external_id, entity_id, synced_at)
    VALUES (${SOURCE}, ${entityType}, ${externalId}, ${entityId}::uuid, now())
    ON CONFLICT (source, entity_type, external_id) DO NOTHING
  `.execute(trx);
}
