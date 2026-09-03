/**
 * تست یکپارچه مهاجرت داده — روی پستگرس واقعی.
 *
 * پنج ادعا، و هر پنج‌تا درباره چیزی است که **یک بار** اتفاق می‌افتد و
 * برگرداندنش سخت است:
 *
 * ۱. **اجرای آزمایشی هیچ‌چیز نمی‌نویسد** — ولی دقیقاً همان گزارشی را
 *    می‌دهد که اجرای واقعی انجام می‌دهد. اگر این دو فرق می‌کردند،
 *    گزارش آزمایشی بی‌فایده بود.
 *
 * ۲. **همه یا هیچ.** یک خطا در فایل پنجم نباید چهار فایل اول را
 *    نوشته باشد.
 *
 * ۳. **سرمایه رقم متوازن‌کننده است**، نه یک ورودی — و سند افتتاحیه
 *    واقعاً متوازن می‌شود.
 *
 * ۴. **اجرای دوباره موجودی را دو برابر نمی‌کند.** این خطرناک‌ترین
 *    حالت است: کسی که مطمئن نیست اجرا موفق بوده، دوباره اجرا می‌کند.
 *
 * ۵. **موجودی از دروازه می‌گذرد.** پس از واردات، `balance_check`
 *    باید صفر باشد — یعنی Projection با حرکت‌ها می‌خواند.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "kysely";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";
import { runImport } from "../src/import/run.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : "DATABASE_URL تنظیم نشده — تست یکپارچه رد شد";

const BRANCH = "00000000-0000-7000-8000-000000000001";
const STORE_WH = "00000000-0000-7000-8000-000000000101";
const SYSTEM_USER = "00000000-0000-7000-8000-0000000000f1";

/** فایل‌های نمونه — همان چیزی که از اکسل بیرون می‌آید. */
const products = `sku,name,color,size,barcode,price,legacy_id
MIG-1,پیراهن مردانه,سفید,L,,۱٬۵۰۰٬۰۰۰,K-101
MIG-2,شلوار جین,آبی,32,6221234567890,۲٬۲۰۰٬۰۰۰,K-102
MIG-3,کت تک,مشکی,50,,۴٬۸۰۰٬۰۰۰,
`;

const customers = `mobile,name,credit_limit,legacy_id
۰۹۱۲۱۱۱۲۲۳۳,رضا محمدی,۵٬۰۰۰٬۰۰۰,C-1
09355556677,زهرا احمدی,,C-2
`;

const suppliers = `code,name,mobile,legacy_id
SUP-A,پوشاک الف,۰۹۱۲۳۳۳۴۴۵۵,S-1
SUP-B,بافت ب,,S-2
`;

const stock = `sku,qty,unit_cost
MIG-1,10,۹۰۰٬۰۰۰
MIG-2,5,۱٬۴۰۰٬۰۰۰
MIG-3,0,۳٬۰۰۰٬۰۰۰
`;

const balances = `leg,amount,party,note
cash,۱۲٬۰۰۰٬۰۰۰,,موجودی صندوق
bank,۸۵٬۰۰۰٬۰۰۰,,حساب ملت
receivable,۳٬۰۰۰٬۰۰۰,۰۹۱۲۱۱۱۲۲۳۳,نسیه رضا
payable,۲۰٬۰۰۰٬۰۰۰,SUP-A,فاکتور خرداد
`;

/** جمع موجودی: ۱۰×۹۰۰٬۰۰۰ + ۵×۱٬۴۰۰٬۰۰۰ = ۱۶٬۰۰۰٬۰۰۰ ریال. */
const INVENTORY = 16_000_000n;
const CASH = 12_000_000n;
const BANK = 85_000_000n;
const RECEIVABLE = 3_000_000n;
const PAYABLE = 20_000_000n;
const EQUITY = INVENTORY + CASH + BANK + RECEIVABLE - PAYABLE;

describe("مهاجرت داده از سیستم فعلی", { skip }, () => {
  let disposable: DisposableDb | null = null;
  let handle: DbHandle;

  const input = (files: Record<string, string>, commit: boolean) => ({
    files,
    branchId: BRANCH,
    warehouseId: STORE_WH,
    fiscalYear: 1405,
    actorId: SYSTEM_USER,
    commit,
  });

  const allFiles = {
    "products.csv": products,
    "customers.csv": customers,
    "suppliers.csv": suppliers,
    "opening-stock.csv": stock,
    "opening-balances.csv": balances,
  };

  before(async () => {
    disposable = createDisposableDb(DATABASE_URL as string);
    if (!disposable) throw new Error("ساخت دیتابیس یک‌بارمصرف ممکن نشد");
    handle = createDb(disposable.url, 5);
  });

  after(async () => {
    await handle?.close();
    disposable?.drop();
  });

  // ── اجرای آزمایشی ───────────────────────────────────────────────

  test("اجرای آزمایشی هیچ‌چیز نمی‌نویسد", async () => {
    const r = await runImport(handle.db, input(allFiles, false));
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    assert.equal(r.committed, false);
    assert.equal(r.openingEntryId, null);

    // ⚠️ هسته این ادعا: «آزمایشی» یعنی واقعاً هیچ.
    const n = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM catalog.variation WHERE sku LIKE 'MIG-%'`
      .execute(handle.db);
    assert.equal(n.rows[0]!.n, "0");
  });

  test("گزارش آزمایشی، اعداد واقعی را می‌دهد", async () => {
    const r = await runImport(handle.db, input(allFiles, false));
    assert.equal(r.plan.products.create, 3);
    assert.equal(r.plan.customers.create, 2);
    assert.equal(r.plan.suppliers.create, 2);
    // کالای با تعداد صفر شمرده نمی‌شود.
    assert.equal(r.plan.stock.lines, 2);
    assert.equal(r.plan.stock.totalValue, INVENTORY);
    assert.equal(r.plan.opening.equity, EQUITY);
    assert.ok(
      r.plan.warnings.some((w) => w.includes("MIG-3")),
      "موجودی صفر باید هشدار بدهد، نه خطا",
    );
  });

  // ── اعتبارسنجی میان‌فایلی ───────────────────────────────────────

  test("موجودی کالایی که در فایل کالاها نیست، رد می‌شود", async () => {
    const r = await runImport(
      handle.db,
      input({ ...allFiles, "opening-stock.csv": "sku,qty,unit_cost\nGHOST,1,1000\n" }, true),
    );
    assert.ok(r.errors.some((e) => e.message.includes("GHOST")));
    assert.equal(r.committed, false);

    // ⚠️ «همه یا هیچ»: خطا در فایل پنجم نباید چهار فایل اول را
    //    نوشته باشد.
    const n = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM catalog.variation WHERE sku LIKE 'MIG-%'`
      .execute(handle.db);
    assert.equal(n.rows[0]!.n, "0", "هیچ کالایی نباید نوشته شده باشد");
  });

  test("دریافتنی بدون شخص رد می‌شود", async () => {
    // بدون `party_id` گردش حساب اشخاص از دفتر ساختنی نیست.
    const r = await runImport(
      handle.db,
      input(
        { ...allFiles, "opening-balances.csv": "leg,amount,party\nreceivable,1000,\n" },
        true,
      ),
    );
    assert.ok(r.errors.some((e) => e.column === "party"));
    assert.equal(r.committed, false);
  });

  test("مشتری ناشناخته در مانده افتتاحیه رد می‌شود", async () => {
    const r = await runImport(
      handle.db,
      input(
        {
          ...allFiles,
          "opening-balances.csv": "leg,amount,party\nreceivable,1000,09190000000\n",
        },
        true,
      ),
    );
    assert.ok(r.errors.some((e) => e.message.includes("09190000000")));
  });

  test("مانده منفی رد می‌شود — جهت از مؤلفه می‌آید، نه از علامت", async () => {
    const r = await runImport(
      handle.db,
      input({ ...allFiles, "opening-balances.csv": "leg,amount,party\ncash,-500,\n" }, true),
    );
    assert.ok(r.errors.some((e) => e.column === "amount"));
  });

  // ── نوشتن ───────────────────────────────────────────────────────

  test("اجرای واقعی همه‌چیز را می‌نویسد و سند متوازن می‌سازد", async () => {
    const r = await runImport(handle.db, input(allFiles, true));
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    assert.equal(r.committed, true);
    assert.ok(r.openingEntryId);

    const v = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM catalog.variation WHERE sku LIKE 'MIG-%'`
      .execute(handle.db);
    assert.equal(v.rows[0]!.n, "3");

    // قیمت با رقم فارسی و جداکننده خوانده شده باشد.
    const price = await sql<{ amount: string }>`
      SELECT p.amount::text FROM catalog.price p
        JOIN catalog.variation v ON v.id = p.variation_id
       WHERE v.sku = 'MIG-1'`.execute(handle.db);
    assert.equal(price.rows[0]!.amount, "1500000");

    // موبایل با رقم فارسی، همان مشتری را می‌سازد که «09121112233».
    const cust = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM sales.customer
       WHERE mobile_normalized = sales.normalize_mobile('09121112233')`.execute(handle.db);
    assert.equal(cust.rows[0]!.n, "1");

    // ── سند افتتاحیه ──
    const legs = await sql<{ account_code: string; debit: string; credit: string }>`
      SELECT account_code, debit::text, credit::text
        FROM ledger.journal_line WHERE entry_id = ${r.openingEntryId}::uuid
       ORDER BY account_code`.execute(handle.db);

    const debit = legs.rows.reduce((a, x) => a + BigInt(x.debit), 0n);
    const credit = legs.rows.reduce((a, x) => a + BigInt(x.credit), 0n);
    assert.equal(debit, credit, "سند افتتاحیه باید متوازن باشد");

    const equityLeg = legs.rows.find((x) => x.account_code === "3102");
    assert.ok(equityLeg, "سطر سرمایه باید باشد");
    assert.equal(BigInt(equityLeg.credit), EQUITY, "سرمایه = دارایی − بدهی");

    const inventoryLeg = legs.rows.find((x) => x.account_code === "1301");
    assert.equal(BigInt(inventoryLeg!.debit), INVENTORY);
  });

  test("سطر دریافتنی و پرداختنی شناسه شخص دارند", async () => {
    // ⚠️ ادعای پایدار CI هم همین را می‌سنجد، ولی اینجا **مسیر
    //    مهاجرت** سنجیده می‌شود: جایی که آدم فایل می‌سازد و
    //    راحت‌ترین کار جا انداختن شخص است.
    const n = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM ledger.journal_line
       WHERE party_type IN ('customer','supplier') AND party_id IS NULL`
      .execute(handle.db);
    assert.equal(n.rows[0]!.n, "0");
  });

  test("موجودی از دروازه گذشته — Projection با حرکت‌ها می‌خواند", async () => {
    const n = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM inventory.balance_check
       WHERE qty_diff <> 0 OR value_diff <> 0`.execute(handle.db);
    assert.equal(n.rows[0]!.n, "0");

    const bal = await sql<{ on_hand: string; value: string }>`
      SELECT b.on_hand::text, b.total_value::text AS value
        FROM inventory.stock_balance b
        JOIN catalog.variation v ON v.id = b.variation_id
       WHERE v.sku = 'MIG-1'`.execute(handle.db);
    assert.equal(Number(bal.rows[0]!.on_hand), 10);
    assert.equal(bal.rows[0]!.value, "9000000");
  });

  test("شناسه سیستم قبلی برای رهگیری نگه داشته می‌شود", async () => {
    const n = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM platform.external_id_map
       WHERE source = 'legacy_acc'`.execute(handle.db);
    // سه کالا منهای یکی بدون legacy_id، دو مشتری، دو تأمین‌کننده.
    assert.equal(n.rows[0]!.n, "6");
  });

  // ── اجرای دوباره ────────────────────────────────────────────────

  test("اجرای دوباره موجودی را دو برابر نمی‌کند", async () => {
    // ⚠️ خطرناک‌ترین حالت: کسی که مطمئن نیست اجرا موفق بوده، دوباره
    //    اجرا می‌کند. بدون Idempotency، موجودی دو برابر می‌شد و سند
    //    افتتاحیه دوم هم می‌خورد.
    const before = await sql<{ on_hand: string }>`
      SELECT b.on_hand::text FROM inventory.stock_balance b
        JOIN catalog.variation v ON v.id = b.variation_id WHERE v.sku = 'MIG-1'`
      .execute(handle.db);

    const r = await runImport(handle.db, input(allFiles, true));
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    assert.equal(r.plan.products.create, 0, "کالای تازه‌ای نباید ساخته شود");
    assert.equal(r.plan.products.existing, 3);

    const after_ = await sql<{ on_hand: string }>`
      SELECT b.on_hand::text FROM inventory.stock_balance b
        JOIN catalog.variation v ON v.id = b.variation_id WHERE v.sku = 'MIG-1'`
      .execute(handle.db);
    assert.equal(after_.rows[0]!.on_hand, before.rows[0]!.on_hand, "موجودی نباید عوض شود");

    const movements = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM inventory.stock_movement WHERE kind = 'opening'`
      .execute(handle.db);
    assert.equal(movements.rows[0]!.n, "2", "حرکت افتتاحیه نباید تکرار شود");
  });

  test("سند افتتاحیه دوم، اولی را جایگزین می‌کند نه اینکه رویش بنشیند", async () => {
    // `post_opening_balance` خودش سند قبلی را معکوس می‌کند. نتیجه:
    // مانده نهایی همان است، نه دو برابر.
    const eq = await sql<{ balance: string }>`
      SELECT (sum(credit) - sum(debit))::text AS balance
        FROM ledger.journal_line WHERE account_code = '3102'`.execute(handle.db);
    assert.equal(BigInt(eq.rows[0]!.balance), EQUITY, "سرمایه نباید دو برابر شده باشد");
  });

  test("کالای موجود به‌روز نمی‌شود", async () => {
    // مهاجرت یک بار انجام می‌شود؛ اجرای دوم نباید نامی را که کسی در
    // سیستم اصلاح کرده، به مقدار فایل قدیمی برگرداند.
    await sql`UPDATE catalog.product SET name_internal = 'نام اصلاح‌شده'
               WHERE code = 'MIG-1'`.execute(handle.db);
    await runImport(handle.db, input(allFiles, true));
    const n = await sql<{ name: string }>`
      SELECT name_internal AS name FROM catalog.product WHERE code = 'MIG-1'`
      .execute(handle.db);
    assert.equal(n.rows[0]!.name, "نام اصلاح‌شده");
  });
});
