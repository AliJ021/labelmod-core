/**
 * پارچهٔ خردلی ورود و قفل (طرح ۱۰).
 *
 * سه ادعا که شکستنشان بی‌صداست: رنگ از توکن می‌آید نه از Shader، حرکت فقط
 * در ناحیهٔ ورود است (ADR-002: هیچ حرکت بی‌پایانی پشت عدد مالی نیست)، و
 * بودجه‌ها (نیم‌وضوح، ۳۰ فریم، توقف در تب پنهان، کاهش حرکت) سر جایشان‌اند.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenRgb } from "../src/lib/fabric.ts";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe("پارچهٔ ورود", () => {
  test("رنگ توکن به سه‌تایی ۰ تا ۱ تبدیل می‌شود و مقدار نامعتبر رد می‌شود", () => {
    assert.deepEqual(tokenRgb(" #ffffff "), [1, 1, 1]);
    const brand = tokenRgb("#f6c444");
    assert.ok(brand);
    assert.equal(Math.round(brand[0] * 255), 0xf6);
    assert.equal(Math.round(brand[2] * 255), 0x44);
    for (const bad of ["", "#fff", "rgb(1,2,3)", "#gggggg", "var(--brand)"]) {
      assert.equal(tokenRgb(bad), null, bad);
    }
  });

  test("Shader هیچ رنگ ثابتی ندارد — پایه و خردلی از توکن‌ها می‌آیند", () => {
    const src = read("components/shell/Fabric.tsx");
    const fs = /const FS = `([\s\S]*?)`;/.exec(src)?.[1] ?? "";
    assert.ok(fs.length > 0, "Shader پیدا نشد");
    assert.doesNotMatch(fs, /vec3\(\s*\.?\d/, "رنگ عددی در Shader");
    for (const name of ["--bg-deep", "--brand", "--brand-2"]) {
      assert.match(src, new RegExp(`getPropertyValue\\("${name}"\\)`), name);
    }
  });

  test("بودجه‌ها: نیم‌وضوح، سقف ۳۰ فریم، تب پنهان، کاهش حرکت و حالت عملکرد", () => {
    const src = read("components/shell/Fabric.tsx");
    assert.match(src, /const scale = 0\.5;/);
    assert.match(src, /now - last < 33/);
    assert.match(src, /document\.hidden/);
    assert.match(src, /prefers-reduced-motion: reduce/);
    assert.match(src, /prefers-reduced-transparency: reduce/);
    assert.match(src, /dataset\.perf === "on"/);
    assert.match(src, /loseContext\(\)/, "پاک‌سازی Context هنگام خروج");
  });

  test("فقط زمینهٔ ورود و قفل پارچه دارد", () => {
    const users = walk(SRC)
      .filter(f => /\.tsx?$/.test(f) && !f.endsWith("Fabric.tsx"))
      .filter(f => /<Fabric\b/.test(readFileSync(f, "utf8")));
    assert.deepEqual(users.map(f => f.slice(SRC.length)), ["components/shell/Backdrop.tsx"]);
    assert.match(read("components/shell/Backdrop.tsx"), /variant === "auth" \? <Fabric \/>/);
  });
});
