/**
 * جهت رابط — راست‌چین، و بدون شکاف Breakpoint.
 *
 * ── چرا این پرونده هست ──────────────────────────────────────────────
 *
 * گزارش شده بود که رابط «چپ‌چین» دیده می‌شود. با Build تولیدی و CSP
 * واقعی در **مرورگر واقعی** سنجیده شد و درست نبود: روی هر نه صفحه،
 * `document.documentElement.dir = "rtl"`، `direction: rtl` محاسبه‌شده،
 * `text-align: start`، و **صفر** بلوکِ بزرگی که جهتش با ریشه فرق کند.
 *
 * ولی همان اندازه‌گیری دو ایراد **واقعی** پیدا کرد که این تست قفلشان
 * می‌کند — چون هیچ‌کدام با چشمِ دسکتاپ دیده نمی‌شدند:
 *
 *   ۱. بازهٔ ۵۶۱ تا ۸۹۹ پیکسل هیچ قاعده‌ای برای `.zones` نداشت و
 *      **کل صفحه** ۱۰۵ پیکسل افقی اسکرول می‌خورد — روی هر نه صفحه، و
 *      دقیقاً روی ۷۶۸ که تبلت عمودی صندوق است.
 *   ۲. `.row` روی ۳۲۰ پیکسل نمی‌شکست و «کالا و قیمت» ۲۳ پیکسل بیرون
 *      می‌زد.
 *
 * ⚠️ این تست **جای مرورگر را نمی‌گیرد** و ادعا نمی‌کند که می‌گیرد.
 *    Playwright عمداً وابستگی این پروژه نیست. آنچه اینجا قفل می‌شود
 *    دو چیزِ **ایستا** است: نبودِ خاصیت فیزیکیِ جهت‌دار، و نبودِ شکاف
 *    میان Breakpointها. سنجش واقعیِ چیدمان کار مرورگر است.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(css|tsx|ts)$/.test(e)) out.push(p);
  }
  return out;
}

const FILES = walk(SRC);
const rel = (p: string) => path.relative(SRC, p);

describe("جهت رابط", () => {
  /**
   * خاصیت فیزیکیِ جهت‌دار در RTL می‌شکند؛ خاصیت منطقی نمی‌شکند.
   * `[dir="rtl"]` override هم پذیرفته نیست: دو نسخه از یک قاعده، و
   * همیشه یکی عقب می‌ماند.
   */
  test("هیچ خاصیت فیزیکیِ جهت‌دار در CSS نیست", () => {
    const PHYSICAL =
      /(^|[^-\w])(margin|padding|border|inset)-(left|right)\s*:|(^|[{;\s])(left|right)\s*:\s*[-\d.]|text-align\s*:\s*(left|right)|float\s*:\s*(left|right)/;
    const hits: string[] = [];
    for (const f of FILES.filter((f) => f.endsWith(".css"))) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (line.trim().startsWith("*") || line.trim().startsWith("/*")) return;
        if (PHYSICAL.test(line)) hits.push(`${rel(f)}:${i + 1}  ${line.trim().slice(0, 70)}`);
      });
    }
    assert.deepEqual(hits, [], `خاصیت فیزیکی جهت‌دار:\n${hits.join("\n")}`);
  });

  test("هیچ استایل درون‌خطیِ جهت‌دار در TSX نیست", () => {
    const INLINE = /\b(marginLeft|marginRight|paddingLeft|paddingRight|borderLeft|borderRight|textAlign:\s*"(left|right)"|float:)/;
    const hits: string[] = [];
    for (const f of FILES.filter((f) => f.endsWith(".tsx"))) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (INLINE.test(line)) hits.push(`${rel(f)}:${i + 1}  ${line.trim().slice(0, 70)}`);
      });
    }
    assert.deepEqual(hits, [], `استایل درون‌خطی جهت‌دار:\n${hits.join("\n")}`);
  });

  /**
   * `dir="ltr"` و `direction: ltr` **مجازند**، ولی فقط روی برگ: یک
   * عدد، یک شناسه، یک نشانی. اگر روی ظرف بنشینند، یک بلوک کامل
   * چپ‌چین می‌شود. این ادعا فهرست را قفل می‌کند تا افزودنش دیده شود.
   */
  test("دامنهٔ چپ‌چینی فقط برگ است و فهرستش قفل است", () => {
    const found: string[] = [];
    for (const f of FILES) {
      if (/dir="ltr"|direction:\s*ltr/.test(readFileSync(f, "utf8"))) found.push(rel(f));
    }
    // هر ورودی باید توجیه داشته باشد. عدد و شناسه و نشانی — نه ظرف.
    const allowed = new Set([
      "styles/base.css",      // .num — ستون عدد
      "styles/app.css",       // .set-key — کلید تنظیم
      "screens/TwoFactor.tsx", // کد بازیابی و راز TOTP
      "screens/Staff.tsx",     // نام کاربری
      "screens/Terminals.tsx", // نشانی و کد دستگاه
      "screens/Customers.tsx", // شماره موبایل
      // کد حساب، نام مؤلفه (`leg`) و کد رویداد — سه شناسهٔ لاتین، و هر
      // سه روی یک `<span>`، نه روی سطر یا ظرف.
      "screens/PostingRules.tsx",
      // کد زنگ و موضوع پیام (`topic`) — دو شناسهٔ لاتین، روی `<span>` و
      // `<strong>`، نه روی سطر.
      "screens/Health.tsx",
    ]);
    const unexpected = [...new Set(found)].filter((f) => !allowed.has(f));
    assert.deepEqual(unexpected, [],
      `چپ‌چینی در جای تازه — باید برگ باشد، نه ظرف:\n${unexpected.join("\n")}`);
  });

  /**
   * شکاف Breakpoint — همان چیزی که ۱۰۵ پیکسل اسکرول افقی ساخت.
   *
   * نوار بخش‌ها تا یک عرض، `overflow-x` خودش را دارد؛ از یک عرض به
   * بالا، چیدمان دسکتاپ جا می‌دهدش. اگر میان این دو **فاصله** بیفتد،
   * هیچ‌کدام اعمال نمی‌شود و کل صفحه افقی اسکرول می‌خورد.
   */
  test("میان Breakpoint موبایل و دسکتاپ شکافی نیست", () => {
    const css = readFileSync(path.join(SRC, "styles/app.css"), "utf8");
    const desktop = [...css.matchAll(/@media \(min-width:\s*(\d+)px\)/g)]
      .map((m) => Number(m[1]));
    const zoneCaps = [...css.matchAll(/@media \(max-width:\s*(\d+)px\)\s*\{([\s\S]*?)\n\}/g)]
      .filter((m) => /\.zones[\s,{]/.test(m[2] ?? "") && /overflow-x:\s*auto/.test(m[2] ?? ""))
      .map((m) => Number(m[1]));

    assert.ok(desktop.length > 0, "چیدمان دسکتاپ Breakpoint ندارد");
    assert.ok(zoneCaps.length > 0, "`.zones` هیچ‌جا `overflow-x: auto` ندارد");

    const widestZone = Math.max(...zoneCaps);
    const narrowestDesktop = Math.min(...desktop);
    assert.ok(
      widestZone >= narrowestDesktop - 1,
      `شکاف Breakpoint: \`.zones\` تا ${widestZone}px مهار می‌شود ولی ` +
        `چیدمان دسکتاپ از ${narrowestDesktop}px شروع می‌شود — ` +
        `بازهٔ ${widestZone + 1} تا ${narrowestDesktop - 1} بی‌قاعده می‌ماند ` +
        `و کل صفحه افقی اسکرول می‌خورد (۷۶۸ تبلت عمودی صندوق است).`,
    );
  });

  /** آیتم Flex با `min-width: auto` کوچک‌تر از محتوایش نمی‌شود، پس
   *  `overflow-x` رویش بی‌اثر است. قلب اصلاح همین بود. */
  test("مهار اسکرول نوار بخش‌ها `min-width: 0` دارد", () => {
    const css = readFileSync(path.join(SRC, "styles/app.css"), "utf8");
    const block = /@media \(max-width:\s*899px\)\s*\{([\s\S]*?)\n\}/.exec(css);
    assert.ok(block, "بلوک مهار ۸۹۹px پیدا نشد");
    assert.match(block[1] as string, /min-width:\s*0/,
      "بدون `min-width: 0` روی آیتم Flex، `overflow-x` بی‌اثر است");
  });
});
