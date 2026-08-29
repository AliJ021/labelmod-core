/**
 * پالت قفل‌شده — ادعاهای ADR-002، این بار سنجیده در CI.
 *
 * هر عدد اینجا مستقیماً از سند می‌آید. اگر کسی یک Hex را در
 * `tokens.css` عوض کند و ادعا بشکند، همین‌جا قرمز می‌شود.
 *
 * توکن‌ها از **خودِ فایل CSS** خوانده می‌شوند، نه از یک کپی در تست —
 * وگرنه تست فقط خودش را می‌سنجد.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  contrast,
  deltaE,
  deuteranopia,
  hexToRgb,
  over,
  type Rgb,
} from "../src/lib/contrast.ts";

const CSS = readFileSync(
  fileURLToPath(new URL("../src/styles/tokens.css", import.meta.url)),
  "utf8",
);

/**
 * مقدار یک توکن را از بلوک تم مورد نظر بیرون می‌کشد.
 *
 * تم روشن در `:root {` است و تم تیره در `:root[data-theme="dark"] {`.
 * عمداً بلوک `@media` را نمی‌خوانیم: همان مقادیر است و دوباره‌خوانی
 * فقط ابهام می‌سازد.
 */
function token(name: string, theme: "light" | "dark"): string {
  const start =
    theme === "light"
      ? CSS.indexOf(":root {")
      : CSS.indexOf(':root[data-theme="dark"] {');
  assert.ok(start >= 0, `بلوک تم ${theme} پیدا نشد`);
  const end = CSS.indexOf("\n}", start);
  const block = CSS.slice(start, end);
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(block);
  assert.ok(m, `توکن --${name} در تم ${theme} نیست`);
  return (m[1] as string).trim();
}

function hex(name: string, theme: "light" | "dark"): Rgb {
  return hexToRgb(token(name, theme));
}

/** سطح شیشه‌ای روی مِش — بدترین حالتی که متن رویش می‌نشیند. */
function glassOverMesh(theme: "light" | "dark"): Rgb {
  const raw = token("surface-glass", theme);
  const m = /rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/.exec(raw);
  assert.ok(m, `surface-glass در تم ${theme} rgba نیست: ${raw}`);
  const tint: Rgb = {
    r: Number(m[1]),
    g: Number(m[2]),
    b: Number(m[3]),
  };
  // بدترین‌حالت پشت شیشه، تیره‌ترین/روشن‌ترین لکه مِش است، نه زمینه.
  const worst = theme === "light" ? hex("mesh-1", "light") : hex("mesh-2", "dark");
  return over(tint, Number(m[4]), worst);
}

for (const theme of ["light", "dark"] as const) {
  describe(`پالت — تم ${theme === "light" ? "روشن" : "تیره"}`, () => {
    test("متن اصلی روی سطح مات ≥ ۴٫۵:۱", () => {
      const ratio = contrast(hex("ink", theme), hex("surface-solid", theme));
      assert.ok(ratio >= 4.5, `تضاد ${ratio.toFixed(2)} کمتر از ۴٫۵ است`);
    });

    test("متن فرعی روی سطح مات ≥ ۴٫۵:۱", () => {
      const ratio = contrast(hex("ink-2", theme), hex("surface-solid", theme));
      assert.ok(ratio >= 4.5, `تضاد ${ratio.toFixed(2)} کمتر از ۴٫۵ است`);
    });

    test("متن اصلی روی شیشه — با بدترین محتوای پشتش — ≥ ۴٫۵:۱", () => {
      // ADR-002 صریح گفته با بدترین‌حالت پشت سنجیده شود، نه با یک
      // پس‌زمینه دلخواه.
      const ratio = contrast(hex("ink", theme), glassOverMesh(theme));
      assert.ok(ratio >= 4.5, `تضاد روی شیشه ${ratio.toFixed(2)} است`);
    });

    /**
     * رنگ نمودار فقط روی سطح **مات** سنجیده می‌شود، و این خودش یک
     * تصمیم است نه یک تخفیف.
     *
     * سنجش نشان داد در تم روشن، همین رنگ روی شیشه‌ی روی مِش فقط
     * ۲٫۷۷:۱ می‌دهد — زیر حداقل ۳:۱. پس قاعده این شد که **نمودار
     * روی شیشه نمی‌نشیند**، و `Dashboard` نمودارش را داخل یک پنل مات
     * می‌گذارد حتی وقتی کارت دربرگیرنده شیشه‌ای است.
     *
     * اگر روزی کسی نمودار را روی شیشه ببرد، این تست نمی‌گیردش — ولی
     * همان کسی که ببردش، این کامنت را در همان فایل می‌بیند.
     */
    test("رنگ نمودار روی سطح مات ≥ ۳:۱", () => {
      const onSolid = contrast(hex("chart-1", theme), hex("surface-solid", theme));
      assert.ok(onSolid >= 3, `روی سطح مات ${onSolid.toFixed(2)}`);
    });

    test("متن روی دکمه اصلی ≥ ۴٫۵:۱", () => {
      const ratio = contrast(hex("accent-ink", theme), hex("accent", theme));
      assert.ok(ratio >= 4.5, `تضاد ${ratio.toFixed(2)} کمتر از ۴٫۵ است`);
    });

    test("هشدار و خطا از هم جدا دیده می‌شوند — دید عادی ΔE ≥ ۱۵", () => {
      // پالت اول ADR-002 دقیقاً همین‌جا رد شد: ΔE ۸٫۴ بود و هشدار
      // موجودی با خطای پرداخت اشتباه گرفته می‌شد.
      const d = deltaE(hex("warn", theme), hex("crit", theme));
      assert.ok(d >= 15, `ΔE برابر ${d.toFixed(1)} است`);
    });

    test("هشدار و خطا در کوررنگی قرمز-سبز ΔE ≥ ۱۰", () => {
      // اندازه‌گیری فعلی ≈۱۴. ADR-002 عدد ۱۰٫۷ را ثبت کرده؛ تفاوت از
      // ماتریس شبیه‌سازی می‌آید، نه از پالت. هر دو بالای آستانه‌اند.
      const d = deltaE(
        deuteranopia(hex("warn", theme)),
        deuteranopia(hex("crit", theme)),
      );
      assert.ok(d >= 10, `ΔE کوررنگی برابر ${d.toFixed(1)} است`);
    });

    test("سه وضعیت خوب/هشدار/خطا هر سه روی سطح مات خوانا هستند", () => {
      for (const name of ["good", "warn", "crit"] as const) {
        const ratio = contrast(hex(name, theme), hex("surface-solid", theme));
        assert.ok(ratio >= 3, `${name}: ${ratio.toFixed(2)}`);
      }
    });
  });
}

describe("قواعد ساختاری توکن‌ها", () => {
  test("دو سطح از هم جدا مانده‌اند", () => {
    // اگر این دو یکی شوند، کل ناحیه‌بندی ADR-002 بی‌معنا می‌شود.
    for (const theme of ["light", "dark"] as const) {
      assert.notEqual(
        token("surface-solid", theme),
        token("surface-glass", theme),
        `در تم ${theme} دو سطح یکی شده‌اند`,
      );
    }
  });

  test("حالت عملکرد، بلور را صفر و شیشه را مات می‌کند", () => {
    const block = CSS.slice(CSS.indexOf(':root[data-perf="on"]'));
    assert.match(block, /--glass-blur:\s*0px/, "بلور باید صفر شود");
    assert.match(
      block,
      /--surface-glass:\s*var\(--surface-solid\)/,
      "شیشه باید به سطح مات برگردد",
    );
  });

  test("ترجیح‌های دسترس‌پذیری رعایت شده‌اند", () => {
    assert.match(CSS, /prefers-reduced-transparency/);
    assert.match(CSS, /prefers-reduced-motion/);
    assert.match(CSS, /@supports not \(backdrop-filter/);
  });
});
