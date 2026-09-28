/**
 * نگهبان سازگاری چسب ZXing با WASM محلی.
 *
 * چرا تست: اسکنر از دو تکه ساخته می‌شود که از دو بستهٔ جدا می‌آیند —
 * کد چسب Emscripten از `barcode-detector/pure`، و فایل WASM از وابستگی
 * **مستقیم** `zxing-wasm` (`camera-scan.ts`، `zxing_reader.wasm?url`).
 * این دو باید از یک ساختِ zxing-wasm باشند.
 *
 * ⚠️ `barcode-detector` چسب را از `zxing-wasm` نصب‌شده import **نمی‌کند**؛
 * آن را در dist خودش کپی کرده است. پس هم‌ترازی Lockfile یا Override در pnpm
 * چسب را عوض نمی‌کند و فقط هم‌ترازی **کاذب** نشان می‌دهد. PR #103 همین را
 * نشان داد: WASM 3.1.4 با چسب 3.1.3 → `RuntimeError: memory access out of
 * bounds`، و EAN13 در آزمون مرورگر خوانده نشد — بی‌آنکه Build یا تایپ‌چک
 * خطا بدهند.
 *
 * پس این تست چیزی را می‌سنجد که واقعاً باندل می‌شود: نسخه‌ای که درون کد
 * توزیع‌شدهٔ `barcode-detector/pure` نشسته، در برابر نسخهٔ WASM‌ای که
 * apps/web سرو می‌کند. راهنمای ارتقا در `e2e/README.md`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("../", import.meta.url));

/** همان Resolve که Vite برای `camera-scan.ts` انجام می‌دهد: ESM با شرط import. */
const resolved = (specifier: string) => fileURLToPath(import.meta.resolve(specifier));

/** نزدیک‌ترین package.json بالای یک فایل حل‌شده، با نام بسته. */
function owningPackage(file: string, name: string): { version: string; dependencies?: Record<string, string> } {
  for (let dir = dirname(file); dirname(dir) !== dir; dir = dirname(dir)) {
    const p = join(dir, "package.json");
    if (!existsSync(p)) continue;
    const pkg = JSON.parse(readFileSync(p, "utf8")) as { name?: string; version: string };
    if (pkg.name === name) return pkg;
  }
  throw new Error(`package.json بستهٔ ${name} بالای ${file} پیدا نشد`);
}

/** فایل ورودی و هر ماژول نسبی‌ای که از آن import می‌شود — همان چیزی که باندل می‌شود. */
function moduleGraph(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      visit(resolve(dirname(file), m[1]!));
    }
  };
  visit(entry);
  return [...seen];
}

test("barcode-detector's embedded ZXing glue matches the local zxing_reader.wasm apps/web ships", () => {
  const direct = (JSON.parse(readFileSync(join(web, "package.json"), "utf8")) as { dependencies: Record<string, string> })
    .dependencies["zxing-wasm"] ?? "";
  assert.match(direct, /^\d+\.\d+\.\d+$/, "apps/web must pin zxing-wasm exactly: camera-scan.ts locates the local WASM from it");

  const wasm = owningPackage(resolved("zxing-wasm/reader/zxing_reader.wasm"), "zxing-wasm");
  assert.equal(wasm.version, direct,
    `installed zxing-wasm ${wasm.version} ≠ apps/web/package.json ${direct}; run pnpm install --frozen-lockfile`);

  const entry = resolved("barcode-detector/pure");
  const embedded = new Set(moduleGraph(entry).flatMap(f =>
    [...readFileSync(f, "utf8").matchAll(/zxing-wasm@(\d+\.\d+\.\d+)/g)].map(m => m[1]!)));
  // بسته‌شدن در شکست: بی نشانه نمی‌دانیم چسب کدام ساخت است، و «نمی‌دانم» سبز نیست.
  assert.ok(embedded.size > 0,
    `no zxing-wasm@x.y.z marker in barcode-detector/pure (${entry}); its dist layout changed — ` +
    "re-establish how to read the embedded glue version before trusting this scanner build (see e2e/README.md)");
  assert.deepEqual([...embedded], [direct],
    `barcode-detector embeds zxing-wasm glue ${[...embedded].join(", ")} but apps/web ships the zxing-wasm ${direct} WASM ` +
    "(3.1.3 glue + 3.1.4 WASM = RuntimeError: memory access out of bounds). A pnpm override cannot change embedded glue: " +
    "keep apps/web zxing-wasm equal to the embedded version, or upgrade barcode-detector to a release that embeds the new one");

  const declared = owningPackage(entry, "barcode-detector").dependencies?.["zxing-wasm"];
  assert.equal(declared, direct, `barcode-detector declares zxing-wasm ${declared ?? "(none)"}; apps/web pins ${direct}`);
});
