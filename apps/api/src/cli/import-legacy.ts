/**
 * مهاجرت داده از سیستم فعلی.
 *
 *   node --experimental-strip-types apps/api/src/cli/import-legacy.ts \
 *        --dir ./migration --branch MAIN --warehouse STORE
 *
 * پیش‌فرض **آزمایشی** است: هیچ‌چیز نوشته نمی‌شود و فقط گزارش می‌آید.
 * برای نوشتن واقعی `--commit` لازم است.
 *
 * ── چرا پیش‌فرض آزمایشی ─────────────────────────────────────────────
 *
 * مهاجرت داده کاری است که یک بار انجام می‌شود و برگرداندنش سخت.
 * فایل‌هایی که از نرم‌افزار قبلی بیرون می‌آیند تقریباً همیشه بار اول
 * ایراد دارند — یک ستون جا افتاده، یک SKU تکراری، یک موجودی بدون بها.
 * اجرای آزمایشی همه‌شان را یک‌جا نشان می‌دهد.
 *
 * ── و چرا گزارش، نه فقط «موفق» ──────────────────────────────────────
 *
 * سرمایه یک **رقم متوازن‌کننده** است: دارایی منهای بدهی. کسی باید
 * پیش از ثبت ببیندش و بگوید «بله، سرمایه ما همین‌قدر است». عددی که
 * بی‌آنکه کسی ببیند در دفتر بنشیند، ماه‌ها بعد در ترازنامه پیدا
 * می‌شود.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../lib/config.ts";
import { createDb } from "../db/client.ts";
import { runImport, type ImportPlan } from "../import/run.ts";
import { FILES, type FileName } from "../import/schema.ts";

const SYSTEM_USER = "00000000-0000-7000-8000-0000000000f1";

export interface Args {
  dir: string;
  branch: string;
  warehouse: string;
  year: number | null;
  commit: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(`--${flag}`);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const dir = get("dir");
  const branch = get("branch");
  const warehouse = get("warehouse");
  if (!dir || !branch || !warehouse) {
    throw new Error(
      "استفاده: --dir <پوشه فایل‌ها> --branch <کد شعبه> --warehouse <کد انبار> " +
        "[--year <سال مالی>] [--commit]",
    );
  }
  const year = get("year");
  return {
    dir,
    branch,
    warehouse,
    year: year === null ? null : Number(year),
    commit: argv.includes("--commit"),
  };
}

/** ریال → تومان با جداکننده، برای خواندن آدم. */
function toman(rial: bigint): string {
  return (rial / 10n).toLocaleString("fa-IR");
}

function printPlan(plan: ImportPlan, commit: boolean): void {
  const w = (s: string) => process.stdout.write(`${s}\n`);

  w("");
  w(commit ? "── انجام شد ───────────────────────────────" : "── اجرای آزمایشی ──────────────────────────");
  w("");
  w(`  کالا           ${plan.products.create} تازه، ${plan.products.existing} از قبل موجود`);
  w(`  مشتری          ${plan.customers.create} تازه، ${plan.customers.existing} از قبل موجود`);
  w(`  تأمین‌کننده     ${plan.suppliers.create} تازه، ${plan.suppliers.existing} از قبل موجود`);
  w(`  موجودی         ${plan.stock.lines} سطر`);
  w("");
  w("  ── سند افتتاحیه (تومان) ──");
  w(`  موجودی کالا    ${toman(plan.opening.inventory).padStart(18)}`);
  w(`  نقد            ${toman(plan.opening.cash).padStart(18)}`);
  w(`  بانک           ${toman(plan.opening.bank).padStart(18)}`);
  w(`  دریافتنی       ${toman(plan.opening.receivable).padStart(18)}`);
  w(`  پرداختنی       ${toman(plan.opening.payable).padStart(18)}  (بستانکار)`);
  w("  ─────────────────────────────────────────");
  w(`  سرمایه         ${toman(plan.opening.equity).padStart(18)}  ← رقم متوازن‌کننده`);
  w("");

  if (plan.warnings.length > 0) {
    w("  ⚠️  هشدارها:");
    for (const x of plan.warnings) w(`      • ${x}`);
    w("");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const handle = createDb(config.DATABASE_URL, 3);
  const w = (s: string) => process.stdout.write(`${s}\n`);

  try {
    const branch = await handle.db
      .selectFrom("platform.branch")
      .select(["id", "name"])
      .where("code", "=", args.branch)
      .executeTakeFirst();
    if (!branch) throw new Error(`شعبه «${args.branch}» وجود ندارد`);

    const warehouse = await handle.db
      .selectFrom("inventory.warehouse")
      .select(["id", "name", "branch_id"])
      .where("code", "=", args.warehouse)
      .executeTakeFirst();
    if (!warehouse) throw new Error(`انبار «${args.warehouse}» وجود ندارد`);
    if (warehouse.branch_id !== branch.id) {
      throw new Error(`انبار «${args.warehouse}» متعلق به شعبه «${args.branch}» نیست`);
    }

    // سال مالی باز — بدون آن سند افتتاحیه ثبت نمی‌شود و پیام
    // دیتابیس همین را می‌گوید. زودتر می‌گیریمش تا کسی فایل‌ها را
    // بی‌خود درست نکند.
    const year = await handle.db
      .selectFrom("ledger.fiscal_year")
      .select(["id", "status"])
      .where((eb) =>
        args.year === null ? eb("status", "=", "open") : eb("id", "=", args.year),
      )
      .executeTakeFirst();
    if (!year) throw new Error("سال مالی بازی پیدا نشد. اول سال مالی را تعریف کنید.");
    if (year.status !== "open") {
      throw new Error(`سال مالی ${year.id} باز نیست (وضعیت: ${year.status})`);
    }

    // فایل‌های موجود را می‌خوانیم؛ نبودنشان خطا نیست. کسی که فقط
    // کاتالوگ را می‌خواهد وارد کند، نباید فایل خالی بسازد.
    const files: Partial<Record<FileName, string>> = {};
    for (const name of Object.keys(FILES) as FileName[]) {
      try {
        files[name] = await readFile(join(args.dir, name), "utf8");
      } catch (err) {
        // ⚠️ فقط «فایل نیست» رد می‌شود. نسخه اول هر خطایی را «نیست»
        //    تعبیر می‌کرد — یعنی فایلی که به‌خاطر دسترسی (EACCES) یا
        //    خرابی خوانده نمی‌شد، بی‌صدا از واردات جا می‌ماند و
        //    مهاجرت **ناقص** ادامه پیدا می‌کرد. دقیقاً همان چیزی که
        //    قاعده «همه یا هیچ» قرار بود جلویش را بگیرد.
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          throw new Error(`خواندن «${name}» ناموفق بود (${code}): ${String(err)}`);
        }
        w(`  — ${name} نیست، رد شد`);
      }
    }
    if (Object.keys(files).length === 0) {
      throw new Error(`هیچ فایلی در «${args.dir}» پیدا نشد`);
    }

    const result = await runImport(handle.db, {
      files,
      branchId: branch.id,
      warehouseId: warehouse.id,
      fiscalYear: year.id,
      actorId: SYSTEM_USER,
      commit: args.commit,
    });

    if (result.errors.length > 0) {
      w("");
      w(`✗ ${result.errors.length} خطا — هیچ‌چیز نوشته نشد.`);
      w("");
      // ⚠️ **همه** خطاها، نه اولی: کسی که فایل هزار سطری دارد نباید
      //    هزار بار اجرا کند تا همه را پیدا کند.
      for (const e of result.errors.slice(0, 100)) {
        w(`  ${e.file}:${e.line} [${e.column}] ${e.message}`);
      }
      if (result.errors.length > 100) {
        w(`  … و ${result.errors.length - 100} خطای دیگر`);
      }
      w("");
      process.exitCode = 1;
      return;
    }

    printPlan(result.plan, result.committed);

    if (!args.commit) {
      w("  هیچ‌چیز نوشته نشد. برای ثبت واقعی `--commit` را اضافه کنید.");
      w("");
      w("  ⚠️ پیش از آن، **سرمایه** بالا را با حسابدار تأیید کنید:");
      w("     رقم متوازن‌کننده است، نه چیزی که کسی وارد کرده باشد.");
      w("");
      return;
    }

    if (result.openingEntryId === null) {
      // واردات فقط کاتالوگ — سندی لازم نبود. این یک حالت
      // پشتیبانی‌شده است، نه یک نیمه‌کاره.
      w("  ✓ کالاها و اشخاص نوشته شدند. سند افتتاحیه لازم نبود");
      w("    (نه موجودی اول دوره‌ای بود و نه مانده‌ای).");
    } else {
      w(`  ✓ سند افتتاحیه ثبت شد: ${result.openingEntryId}`);
    }
    w("");
    w("  گام بعد — این دو باید خالی باشند:");
    w("    SELECT * FROM inventory.balance_check WHERE qty_diff <> 0 OR value_diff <> 0;");
    w("    SELECT * FROM sales.unposted_revenue;");
    w("");
  } finally {
    await handle.close();
  }
}

if (process.argv[1]?.endsWith("import-legacy.ts")) {
  // ⚠️ خطا باید پیام فارسی بدهد، نه Stack Trace: کسی که این را اجرا
  //    می‌کند انباردار یا مالک است، نه توسعه‌دهنده.
  try {
    await main();
  } catch (err) {
    process.stderr.write(`\n✗ ${err instanceof Error ? err.message : String(err)}\n\n`);
    process.exit(1);
  }
}
