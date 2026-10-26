/**
 * پوشش ورودی پول (R07): هر کادری که متنش به یکی از مرزهای «تومانِ تایپ‌شده → ریال» می‌رود، `AmountInput` است.
 *
 * `AmountInput` جداکنندهٔ هزارگان را نمایش می‌دهد، مکان‌نما را پس از گروه‌بندی نگه می‌دارد و رقم فارسی و عربی
 * را به لاتین می‌برد؛ مقدار state و بدنهٔ API همان رشتهٔ بی‌جداکننده می‌ماند. یک `<input>` سادهٔ پولی همهٔ
 * این‌ها را بی‌صدا از دست می‌دهد و هیچ آزمون رفتاری قرمز نمی‌شود — سه کادر سفارش اینستاگرام همین بودند.
 *
 * این آزمون ایستا است: نام متغیری که به مرز پول داده می‌شود (`rialFromTomanInput(x)`، `rialFromToman(x)`،
 * `rialFromExactTomanInput(x)`) را از هر صفحه برمی‌دارد و هر `<input …>` که `value={x}` دارد رد می‌کند.
 * درصد و تعداد به این مرزها نمی‌روند، پس با پول قاطی نمی‌شوند.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const PARSERS = /\b(?:rialFromTomanInput|rialFromToman|rialFromExactTomanInput)\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\)/g;

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "dev" ? [] : tsxFiles(full);
    return name.endsWith(".tsx") ? [full] : [];
  });
}

/** متغیرهای پولیِ یک فایل و تگ‌های `<input …/>` آن. */
function scan(source: string) {
  const money = new Set([...source.matchAll(PARSERS)].map(m => m[1]!));
  const inputs = [...source.matchAll(/<input\b[\s\S]*?\/>/g)].map(m => m[0]);
  return { money, inputs };
}

function violations(source: string): string[] {
  const { money, inputs } = scan(source);
  return inputs.flatMap(tag => {
    const v = /\bvalue=\{\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\}/.exec(tag)?.[1];
    return v !== undefined && money.has(v) ? [v] : [];
  });
}

test("هر کادر پولیِ تایپی AmountInput است، نه <input> ساده", () => {
  const found = tsxFiles(SRC).flatMap(file =>
    violations(readFileSync(file, "utf8")).map(v => `${path.relative(SRC, file)}: value={${v}}`));
  assert.deepEqual(found, [], `کادر پولی بی AmountInput:\n${found.join("\n")}`);
});

test("نگهبان واقعاً می‌گیرد: کادر سادهٔ پولی رد و AmountInput و کادر تعداد پذیرفته می‌شوند", () => {
  const bad = `const r = rialFromToman(form.shipping);
    <input type="text" className="num" value={form.shipping} onChange={set("shipping")} />`;
  assert.deepEqual(violations(bad), ["form.shipping"]);
  const good = `const r = rialFromTomanInput(amount);
    <AmountInput inputMode="numeric" value={amount} onChange={e => setAmount(e.target.value)} />
    <input inputMode="numeric" value={qty} onChange={e => setQty(e.target.value)} />`;
  assert.deepEqual(violations(good), []);
});

test("پوشش واقعی است: همهٔ صفحه‌هایی که مرز پول دارند دست‌کم یک AmountInput دارند", () => {
  const missing = tsxFiles(SRC).filter(file => {
    const source = readFileSync(file, "utf8");
    return scan(source).money.size > 0 && !source.includes("<AmountInput") && !source.includes("? AmountInput");
  }).map(file => path.relative(SRC, file));
  assert.deepEqual(missing, []);
});
