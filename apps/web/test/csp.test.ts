/**
 * نگهبان CSP و صفحه پایه.
 *
 * چرا تست: `wasm-unsafe-eval` تنها چیزی است که اسکنر بارکد را روی
 * آیفون زنده نگه می‌دارد، و **حذفش هیچ خطایی نمی‌دهد** — دوربین
 * باز می‌شود، تصویر می‌آید، و هیچ بارکدی خوانده نمی‌شود. نوع خرابی‌ای
 * که ماه‌ها کشف نشده می‌ماند و آخرش پای صندوق پیدا می‌شود.
 *
 * همین‌طور اسکریپت درون‌خطی: اگر روزی به index.html برگردد، CSP آن را
 * بی‌صدا اجرا نمی‌کند و صفحه با تم غلط بالا می‌آید.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, root)), "utf8");

const caddyfile = read("ops/deploy/Caddyfile");
const indexHtml = read("apps/web/index.html");

/** مقدار یک هدر از Caddyfile — همان که به مرورگر می‌رسد. */
function header(name: string): string {
  const m = caddyfile.match(new RegExp(`^\\s*${name}\\s+"([^"]*)"`, "m"));
  assert.ok(m, `هدر ${name} در Caddyfile نیست`);
  return m[1] ?? "";
}

/** یک دستور از CSP، مثلاً script-src. */
function directive(csp: string, name: string): string {
  const found = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));
  assert.ok(found, `دستور ${name} در CSP نیست`);
  return found;
}

test("CSP رابط کاربری", async (t) => {
  const csp = header("Content-Security-Policy");

  await t.test("اجرای WebAssembly مجاز است — بدون این، اسکنر آیفون کار نمی‌کند", () => {
    assert.match(directive(csp, "script-src"), /'wasm-unsafe-eval'/);
  });

  await t.test("اسکریپت درون‌خطی مجاز نیست", () => {
    const scriptSrc = directive(csp, "script-src");
    assert.doesNotMatch(scriptSrc, /'unsafe-inline'/);
    assert.doesNotMatch(scriptSrc, /'unsafe-eval'/);
    // `unsafe-eval` کامل هرگز: `wasm-unsafe-eval` عمداً باریک است.
    assert.match(scriptSrc, /'self'/);
  });

  await t.test("پایه بسته است", () => {
    assert.ok(csp.startsWith("default-src 'none'"));
    assert.match(directive(csp, "frame-ancestors"), /'none'/);
    assert.match(directive(csp, "base-uri"), /'none'/);
    assert.match(directive(csp, "object-src"), /'none'/);
  });

  await t.test("سبک: صفت باز، عنصر بسته", () => {
    // React سبک را روی صفت style می‌نشاند؛ آن یک شاخه جداست و
    // بازبودنش سطح حمله اسکریپت را باز نمی‌کند.
    assert.match(directive(csp, "style-src-attr"), /'unsafe-inline'/);
    assert.doesNotMatch(directive(csp, "style-src-elem"), /'unsafe-inline'/);
  });

  await t.test("درخواست شبکه فقط به مبدأ خودمان", () => {
    assert.equal(directive(csp, "connect-src"), "connect-src 'self'");
  });
});

test("Permissions-Policy دوربین را باز می‌گذارد و بقیه را می‌بندد", () => {
  const pp = header("Permissions-Policy");
  assert.match(pp, /camera=\(self\)/);
  assert.match(pp, /microphone=\(\)/);
  assert.match(pp, /geolocation=\(\)/);
});

test("HSTS طبق بند ۲ SECURITY.md", () => {
  assert.match(header("Strict-Transport-Security"), /max-age=31536000/);
  assert.match(header("Strict-Transport-Security"), /includeSubDomains/);
});

test("index.html هیچ اسکریپت درون‌خطی ندارد", () => {
  // هر <script> باید src داشته باشد. یکی بدون src یعنی CSP آن را
  // بی‌صدا رد می‌کند.
  for (const tag of indexHtml.match(/<script\b[^>]*>/g) ?? []) {
    assert.match(tag, /\ssrc=/, `اسکریپت درون‌خطی در index.html: ${tag}`);
  }
});

test("مبدأهای بیرونیِ index.html در CSP مجازند", () => {
  // اگر روزی دامنه‌ای به index.html اضافه شود و به CSP نه، فونت یا
  // دارایی بی‌صدا نمی‌آید.
  const csp = header("Content-Security-Policy");
  for (const match of indexHtml.matchAll(/href="(https?:\/\/[^"]+)"/g)) {
    const origin = new URL(match[1] ?? "").origin;
    assert.ok(csp.includes(origin), `مبدأ ${origin} در index.html هست ولی در CSP نیست`);
  }
});
