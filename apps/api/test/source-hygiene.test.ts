/**
 * بهداشت فایل منبع — نگهبانی که هوک محلی نمی‌تواند باشد.
 *
 * یک بایت کنترلی خام داخل یک فایل TypeScript کافی است تا گیت کل فایل را
 * باینری بداند. آن‌وقت سه دفاع هم‌زمان و **بی‌صدا** خاموش می‌شوند:
 *
 *   git diff    → «Binary files differ»، پس بازبینی کد ممکن نیست
 *   git grep -I → فایل را رد می‌کند، پس اسکن راز pre-push رویش اجرا نمی‌شود
 *   git log -p  → هیچ تغییری نشان نمی‌دهد
 *
 * دقیقاً همین اتفاق افتاد: `apps/api/src/http/purchasing-routes.ts` یک
 * NUL را به‌شکل بایت خام داخل یک Regex داشت و ۳۴ مسیر خرید و انبار
 * — همه پول‌خیز — ماه‌ها بدون Diff و بدون اسکن راز Merge شدند.
 *
 * ⚠️ چرا اینجا و نه فقط در هوک: هوک با `--no-verify` دور زده می‌شود و
 * روی هر کلون تازه باید دوباره نصب شود (بند ۹ SECURITY.md). CI نه.
 *
 * ⚠️ چرا در بسته `api` و نه جای دیگر: بررسی کل مخزن است، ولی تست باید
 * داخل یک بسته باشد تا `pnpm -r test` اجرایش کند.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

/** پسوندهایی که محتوایشان قطعاً متن است. */
const SOURCE_GLOBS = [
  "*.ts",
  "*.tsx",
  "*.js",
  "*.mjs",
  "*.sql",
  "*.sh",
  "*.php",
  "*.md",
  "*.json",
  "*.yml",
  "*.yaml",
  "*.css",
  "*.html",
  "*.txt",
];

function trackedSources(): string[] {
  return execFileSync("git", ["ls-files", "--", ...SOURCE_GLOBS], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
    .split("\n")
    .filter((f) => f !== "");
}

/**
 * بایت‌های مجاز: هر چیزی جز نویسه کنترلی C0 — به‌استثنای Tab، LF و CR
 * که در متن معنا دارند. `\x7f` (DEL) هم مجاز نیست.
 */
function controlBytes(buf: Buffer): number[] {
  const found = new Set<number>();
  for (const b of buf) {
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue;
    if (b < 0x20 || b === 0x7f) found.add(b);
  }
  return [...found].sort((a, b) => a - b);
}

test("هیچ فایل منبعی بایت کنترلی خام ندارد", () => {
  const files = trackedSources();
  assert.ok(files.length > 100, `فهرست فایل‌ها مشکوک است: ${files.length} فایل`);

  const dirty: string[] = [];
  for (const rel of files) {
    let buf: Buffer;
    try {
      buf = readFileSync(join(ROOT, rel));
    } catch {
      continue; // فایل ردیابی‌شده ولی حذف‌شده در کپی کاری
    }
    const bad = controlBytes(buf);
    if (bad.length > 0) {
      const where = buf.indexOf(bad[0]!);
      const line = buf.subarray(0, where).toString("utf8").split("\n").length;
      dirty.push(
        `${rel}:${line} — بایت‌های ${bad.map((b) => "0x" + b.toString(16).padStart(2, "0")).join(", ")}`,
      );
    }
  }

  assert.deepEqual(
    dirty,
    [],
    "این فایل‌ها بایت کنترلی خام دارند. گیت آن‌ها را باینری می‌بیند، پس\n" +
      "نه Diff دارند و نه اسکن راز. به‌جای بایت خام Escape بنویسید:\n  " +
      dirty.join("\n  "),
  );
});

test("گیت هیچ فایل منبعی را باینری نمی‌بیند", () => {
  // همان چیزی که `git grep -I` می‌سنجد، ولی از بیرون: فایلی که با -a
  // پیدا شود و با -I نه، یعنی گیت باینری‌اش می‌داند. این تست مکمل تست
  // بالاست، نه تکرارش — گیت معیار خودش را دارد (بایت NUL در ۸ کیلوبایت
  // اول) و ممکن است روزی عوض شود.
  const files = trackedSources();
  const opaque = files.filter((f) => {
    const seen = (flag: string) => {
      try {
        execFileSync("git", ["grep", "-q", flag, "-e", "", "--", f], {
          cwd: ROOT,
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    };
    return seen("-a") && !seen("-I");
  });

  assert.deepEqual(
    opaque,
    [],
    `گیت این فایل‌ها را باینری می‌بیند: ${opaque.join(", ")}`,
  );
});

/**
 * رگرسیون نقطه‌ای — دو جایی که واقعاً شکسته بودند.
 *
 * تست بالا کلاسِ باگ را می‌گیرد؛ این یکی مطمئن می‌شود همان دو خط
 * دوباره با بایت خام نوشته نشوند، حتی اگر روزی معیار تست بالا شل شود.
 */
test("دو رگرسیون تأییدشده: Regex نویسه کنترلی و جداکننده کلید مجوز", () => {
  // ⚠️ خانه این الگو **یک** پرونده است، نه چهار تا. تا پیش از این،
  //    همین تعریف در چهار مسیر کپی شده بود — و یک فیلتر امنیتی با
  //    چهار نسخه، چهار برابر شانس عقب‌ماندن دارد.
  const text = readFileSync(join(ROOT, "apps/api/src/lib/text.ts"), "utf8");
  const m = text.match(/export const CONTROL_CHARS = (\/\[[^\n]*?\]\/);/);
  assert.ok(m, "تعریف CONTROL_CHARS پیدا نشد");

  // و هیچ‌جای دیگری تعریفش نمی‌کند.
  for (const f of [
    "apps/api/src/http/catalog-routes.ts",
    "apps/api/src/http/product-routes.ts",
    "apps/api/src/http/purchasing-routes.ts",
    "apps/api/src/http/treasury-routes.ts",
  ]) {
    const src = readFileSync(join(ROOT, f), "utf8");
    assert.ok(
      !src.includes("const CONTROL_CHARS ="),
      `${f} نباید نسخه دوم CONTROL_CHARS داشته باشد`,
    );
    assert.ok(src.includes('from "../lib/text.ts"'), `${f} باید از تعریف مشترک بخواند`);
  }
  assert.ok(
    m[1]!.includes("\\u0000"),
    "CONTROL_CHARS باید Escape باشد، نه بایت خام",
  );

  // و باید همان کاری را بکند که قرار بود: نویسه کنترلی و جهت‌دهی را رد کند
  const re = new RegExp(m[1]!.slice(1, -1));
  assert.equal(re.test("تأمین‌کننده الف"), false, "نام سالم نباید رد شود");
  assert.equal(re.test(`x${String.fromCodePoint(0x0000)}y`), true, "NUL");
  assert.equal(re.test(`x${String.fromCodePoint(0x001f)}y`), true, "C0");
  assert.equal(re.test(`x${String.fromCodePoint(0x007f)}y`), true, "DEL");
  assert.equal(re.test(`x${String.fromCodePoint(0x009f)}y`), true, "C1");
  assert.equal(re.test(`x${String.fromCodePoint(0x200e)}y`), true, "LRM");
  assert.equal(re.test(`x${String.fromCodePoint(0x202e)}y`), true, "RLO");
  assert.equal(re.test(`x${String.fromCodePoint(0x2069)}y`), true, "PDI");
  assert.equal(re.test("قیمت ۱۲۳٬۴۵۶ ریال"), false, "رقم فارسی نباید رد شود");

  const perms = readFileSync(
    join(ROOT, "apps/web/src/screens/Permissions.tsx"),
    "utf8",
  );
  assert.match(
    perms,
    /`\$\{r\.roleCode\}\\u0000\$\{r\.operation\}`/,
    "جداکننده کلید مجوز باید \\u0000 نوشته شود، نه بایت خام NUL",
  );
});


/**
 * ردیف تکراری در Seed مجوزها — یک شکست کاملاً بی‌صدا.
 *
 * `INSERT ... ON CONFLICT (role_code, operation) DO NOTHING` دو ردیف
 * یکسان در **همان** VALUES را بی‌هیچ خطایی رد می‌کند. یعنی می‌شود یک
 * قاعده مجوز را دوباره نوشت — با مقدار **متفاوت** — و هیچ‌کس نفهمد
 * کدام‌یک واقعاً نشسته است. آنکه می‌نشیند اولی است، نه آنکه نویسنده
 * فکر می‌کند.
 *
 * یک بار همین اتفاق افتاد: `stock.transfer` برای انباردار و مدیر از
 * قبل در Seed بود و یک ویرایش بعدی دوباره اضافه‌اش کرد.
 */
test("Seed مجوزها ردیف تکراری ندارد", () => {
  const seed = readFileSync(join(ROOT, "db/seed/040_reference.sql"), "utf8");

  // فقط ردیف‌های ('نقش','عملیات', ... — کامنت و بقیه جدول‌ها را نمی‌گیرد.
  const rows = [...seed.matchAll(/^\('([a-z_]+)','([a-z_]+\.[a-z_]+)',/gm)].map(
    (m) => `${m[1]} ${m[2]}`,
  );
  assert.ok(rows.length > 50, `ردیف مجوز پیدا نشد (${rows.length})`);

  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const r of rows) {
    if (seen.has(r)) dupes.push(r);
    seen.add(r);
  }
  assert.deepEqual(dupes, [], `ردیف مجوز تکراری: ${dupes.join("، ")}`);
});

/**
 * `pnpm lint` واقعاً چیزی را Lint می‌کند.
 *
 * ── چرا این ادعا لازم است ──────────────────────────────────────────
 *
 * ماه‌ها اسکریپت ریشه `pnpm -r --if-present lint` بود. `--if-present`
 * روی پکیجی که اسکریپت `lint` ندارد **بی‌صدا رد می‌شود و صفر
 * برمی‌گرداند** — پس `pnpm check` و CI هر دو سبز می‌شدند بی‌آنکه یک
 * خط Lint شده باشد.
 *
 * این دقیقاً همان الگویی است که در این مخزن چند بار گرفته شده: دفاعی
 * که خاموش است ولی سبز گزارش می‌دهد. برگشتنش هم آسان است — کافی است
 * کسی اسکریپت را «ساده» کند.
 *
 * پس ادعا روی **خودِ پیکربندی** است، نه روی رفتار: فایل پیکربندی
 * وجود دارد، اسکریپت ریشه واقعاً ESLint را صدا می‌زند، و CI اجرایش
 * می‌کند.
 */
test("Lint یک no-op نیست", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  const lint = pkg.scripts["lint"] ?? "";
  assert.ok(lint.includes("eslint"), `اسکریپت lint باید ESLint را صدا بزند، نه «${lint}»`);
  assert.ok(
    !lint.includes("--if-present"),
    "`--if-present` روی پکیج بدون اسکریپت، بی‌صدا صفر برمی‌گرداند",
  );

  // پیکربندی باید باشد، وگرنه ESLint هیچ فایلی را نمی‌سنجد.
  assert.ok(
    existsSync(join(ROOT, "eslint.config.js")),
    "eslint.config.js نیست — ESLint بدون آن چیزی را Lint نمی‌کند",
  );

  // و CI باید اجرایش کند، وگرنه فقط روی دستگاه توسعه‌دهنده معنا دارد.
  const ci = readFileSync(join(ROOT, ".github/workflows/db-tests.yml"), "utf8");
  assert.ok(ci.includes("pnpm lint"), "CI باید `pnpm lint` را اجرا کند");
});

/**
 * قاعده‌های زیرمجموعه strip-only در پیکربندی هستند.
 *
 * `enum`، `namespace` و parameter property هر سه از `tsc` رد می‌شوند
 * ولی Node با `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` می‌ایستد — یعنی
 * خطایی که فقط در **زمان اجرا** دیده می‌شود، و روی سرور تولید.
 *
 * اگر روزی کسی این قاعده‌ها را از پیکربندی بردارد، این ادعا قرمز
 * می‌شود.
 */
test("قاعده‌های strip-only در پیکربندی Lint هستند", () => {
  const cfg = readFileSync(join(ROOT, "eslint.config.js"), "utf8");
  for (const selector of ["TSEnumDeclaration", "TSModuleDeclaration", "TSParameterProperty"]) {
    assert.ok(cfg.includes(selector), `قاعده ${selector} از پیکربندی افتاده است`);
  }
});
