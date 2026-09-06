/**
 * ESLint — قاعده‌هایی که تایپ‌چکر نمی‌گیرد.
 *
 * ── چرا این فایل تا امروز نبود، و چرا حالا هست ─────────────────────
 *
 * `pnpm lint` ماه‌ها یک no-op بود: `pnpm -r --if-present lint` روی
 * پکیجی که اسکریپت `lint` ندارد بی‌صدا رد می‌شود و **صفر برمی‌گرداند**.
 * یعنی `pnpm check` سبز می‌شد بی‌آنکه هیچ Lintی اجرا شده باشد — همان
 * الگوی «دفاعی که خاموش است ولی سبز گزارش می‌دهد» که در این مخزن چند
 * بار گرفته شده.
 *
 * ── چه چیزی سنجیده می‌شود و چه چیزی نه ────────────────────────────
 *
 * ⚠️ **قاعده‌های تایپ‌آگاه (type-aware) روشن نیستند.** هیچ نسخه‌ای از
 *    `typescript-eslint` هنوز TypeScript 7 را پشتیبانی نمی‌کند
 *    (`peerDependencies` تا `<6.1.0`). قاعده‌هایی مثل
 *    `no-floating-promises` که به تایپ‌چکر نیاز دارند، اینجا **در
 *    دسترس نیستند** — و وانمود کردن به اینکه هستند بدتر از نبودشان
 *    بود. هرگاه پشتیبانی آمد، `projectService` روشن می‌شود.
 *
 * پس این پیکربندی روی چیزهایی تمرکز دارد که بدون تایپ هم قطعی‌اند:
 * متغیر استفاده‌نشده، `==` در برابر `===`، `console` جامانده، و
 * قاعده‌های Hook در React که تایپ‌چکر اصلاً نمی‌بیندشان.
 *
 * ── قاعده‌های خاص همین پروژه ──────────────────────────────────────
 *
 * زیرمجموعه **strip-only** یک الزام اجرایی است، نه سلیقه: `enum`،
 * `namespace` و parameter property در سازنده، همه از `tsc` رد
 * می‌شوند ولی Node با `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` می‌ایستد —
 * یعنی خطایی که فقط در **زمان اجرا** دیده می‌شود. اینجا در زمان Lint
 * گرفته می‌شود.
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    // خروجی Build، وابستگی‌ها و فایل‌های تولیدشده Lint نمی‌شوند.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.d.ts",
      "apps/web/public/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // ── زیرمجموعه strip-only ────────────────────────────────────
      //
      // این سه، `tsc` را رد می‌کنند ولی Node اجرایشان نمی‌کند. بدون
      // این قاعده‌ها، خطا فقط وقتی دیده می‌شود که سرور بالا نیاید.
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSEnumDeclaration",
          message:
            "enum در حالت strip-only اجرا نمی‌شود (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX). به‌جایش یک اتحاد رشته‌ای بنویس.",
        },
        {
          selector: "TSModuleDeclaration[kind='namespace']",
          message: "namespace در حالت strip-only اجرا نمی‌شود. از ماژول استفاده کن.",
        },
        {
          selector: "TSParameterProperty",
          message:
            "parameter property در سازنده، در حالت strip-only اجرا نمی‌شود. میدان را صریح بنویس.",
        },
      ],

      // ── چیزهایی که بی‌صدا اشتباه می‌شوند ────────────────────────
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
      // `console` در سرور یعنی لاگ بدون Correlation ID و بدون سطح —
      // بند ۶ SECURITY.md می‌گوید لاگ ساختاریافته. `warn` و `error`
      // برای CLI و اسکریپت‌ها باز می‌مانند.
      "no-console": ["warn", { allow: ["warn", "error"] }],

      // متغیر استفاده‌نشده اغلب یعنی یک بازنویسی نیمه‌کاره.
      // `_` پیشوندِ عمدی است.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },

  // ── React: قاعده‌هایی که تایپ‌چکر اصلاً نمی‌بیند ─────────────────
  {
    files: ["apps/web/src/**/*.tsx", "apps/web/src/**/*.ts"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      // وابستگی جامانده در `useEffect` یعنی صفحه‌ای که با داده کهنه
      // می‌ماند — و آن در یک صندوق فروشگاهی یعنی قیمت کهنه.
      "react-hooks/exhaustive-deps": "warn",
    },
  },

  // ── تست‌ها ──────────────────────────────────────────────────────
  {
    files: ["**/test/**/*.ts", "**/*.test.ts"],
    rules: {
      // تست عمداً به شکل‌های غلط ورودی می‌دهد تا رد شدنشان را بسنجد.
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },

  // ── CLI و اسکریپت‌ها ────────────────────────────────────────────
  {
    files: ["apps/api/src/cli/**/*.ts", "scripts/**/*.js", "**/*.config.js"],
    rules: {
      // خروجی CLI **باید** روی stdout برود؛ آن رابط کاربری‌اش است.
      "no-console": "off",
    },
  },
);
