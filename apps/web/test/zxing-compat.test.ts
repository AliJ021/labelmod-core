/**
 * نگهبان اتصال واقعی glue و WASM: هر دو از همان نصب دقیق zxing-wasm.
 * تطبیق هش باینری با هش صادرشده از reader، ناسازگاری ساخت را هم می‌گیرد.
 * نسخهٔ قدیمی wrapper چسب ۳.۱.۳ را در dist داشت؛ override آن را عوض نمی‌کرد.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ZXING_WASM_VERSION, ZXING_WASM_SHA256 } from "zxing-wasm/reader";

const web = fileURLToPath(new URL("../", import.meta.url));
function packageRoot(file: string): string {
  for (let dir = dirname(file); dirname(dir) !== dir; dir = dirname(dir)) {
    const p = join(dir,"package.json");
    if (existsSync(p) && JSON.parse(readFileSync(p,"utf8")).name === "zxing-wasm") return dir;
  }
  throw new Error(`بستهٔ zxing-wasm برای ${file} پیدا نشد`);
}

test("camera reader glue and local WASM share the exact package, version and binary hash", () => {
  const deps = JSON.parse(readFileSync(join(web,"package.json"),"utf8")).dependencies as Record<string,string>;
  const direct = deps["zxing-wasm"] ?? "";
  assert.match(direct,/^\d+\.\d+\.\d+$/,"نسخهٔ رمزگشا باید دقیقاً پین باشد");
  assert.equal(deps["barcode-detector"],undefined,"wrapper با glue مستقل دوباره وارد نشود");
  const source = readFileSync(join(web,"src/lib/camera-scan.ts"),"utf8");
  const imports = [...source.matchAll(/import\(["']([^"']+)["']\)/g)].map(m=>m[1]!);
  assert.deepEqual(imports,["zxing-wasm/reader","zxing-wasm/reader/zxing_reader.wasm?url"]);
  const reader = fileURLToPath(import.meta.resolve(imports[0]!));
  const wasm = fileURLToPath(import.meta.resolve(imports[1]!.replace(/\?url$/,"")));
  assert.equal(packageRoot(reader),packageRoot(wasm),"glue و باینری از دو نصب متفاوت‌اند");
  assert.equal(JSON.parse(readFileSync(join(packageRoot(reader),"package.json"),"utf8")).version,direct);
  assert.equal(ZXING_WASM_VERSION,direct,"نسخهٔ صادرشدهٔ glue با پین متفاوت است");
  assert.match(ZXING_WASM_SHA256,/^[a-f0-9]{64}$/);
  assert.equal(createHash("sha256").update(readFileSync(wasm)).digest("hex"),ZXING_WASM_SHA256,
    "باینری محلی با ساخت glue رمزگشا یکسان نیست");
});
