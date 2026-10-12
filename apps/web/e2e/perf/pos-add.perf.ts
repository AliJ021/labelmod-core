/**
 * اندازه‌گیری «افزودن قلم به سبد» در صندوق — بودجهٔ ADR-002: زیر ۱۰۰ms.
 *
 * مسیر سنجیده: Enter در کادر «افزودن کالا» ← جست‌وجوی دقیق ← قفل تب و ذخیرهٔ اسکن معلق
 * ← POST اسکن ← رندر ردیف تازه **و** جمع «قابل پرداخت» تازه. API ساختگی (mock) و فوری
 * است، پس عدد «کل» تأخیر واقعی سرور و شبکه را ندارد؛ برای همین سه بخش جدا گزارش می‌شود:
 *   total   از keydown تا دیده‌شدن ردیف و جمع تازه در DOM
 *   lookup  از keydown تا پاسخ جست‌وجوی دقیق (`GET /pos/products`؛ شامل رهگیری mock)
 *   prep    از پاسخ جست‌وجو تا شروع `POST …/scan` (قفل تب، ذخیرهٔ اسکن معلق — کار خالص کلاینت)
 *   scan    رفت‌وبرگشت `POST …/scan` (سرور ساختگی فوری؛ عمدتاً هزینهٔ رهگیری Playwright)
 *   render  از رسیدن پاسخ اسکن تا ردیف و جمع تازه (کار خالص کلاینت)
 * پس «کار کلاینت» = prep + render؛ lookup و scan در صندوق واقعی با شبکه و سرور جایگزین می‌شوند.
 *
 * ⚠️ این یک ابزار است، نه آزمون CI: هیچ ادعای زمانی ندارد (فقط درستی ردیف و جمع) و
 * زمان‌ها روی همین ماشین و Chromium اندازه‌گیری می‌شوند. کندکردن CPU با CDP
 * (`Emulation.setCPUThrottlingRate`) شبیه‌سازی است، نه تبلت واقعی صندوق.
 */
import { writeFileSync } from "node:fs";
import type { CDPSession, Page } from "@playwright/test";
import { test, expect, type MockApi } from "../fixtures";

const INVOICE = "33333333-3333-4333-8333-333333333333";
const SHIFT = "44444444-4444-4444-8444-444444444444";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const ROUNDS = Number(process.env.PERF_ROUNDS ?? 12);
const WARMUP = 2;
const PRICE = 1_250_000n;

const variation = (n: number) => `66666666-6666-4666-8666-${String(n).padStart(12, "0")}`;
type Line = Record<string, unknown>;
const line = (n: number): Line => ({ id: `l${n}`, lineNo: n, variationId: variation(n), productName: `کالای آزمایشی ${n}`,
  sku: `SKU-${n}`, qty: "1", unitPrice: PRICE.toString(), netAmount: PRICE.toString(), discountAmount: "0",
  listPrice: null, priceOverrideReason: null, discountReason: null });
function invoiceOf(lines: Line[]) {
  const total = (PRICE * BigInt(lines.length)).toString();
  return { id: INVOICE, number: null, branchId: "b1", warehouseId: "w1", shiftId: SHIFT, createdBy: ACTOR, customerId: null,
    status: "draft", channel: "pos", grossAmount: total, discountAmount: "0", netAmount: total, taxAmount: "0", shippingAmount: "0",
    payableAmount: total, paidAmount: "0", receivedAmount: "0", recipientId: null, gift: null, occurredAt: "2026-10-10T08:00:00Z", lines };
}

function mockPos(api: MockApi, size: number) {
  const lines = Array.from({ length: size }, (_, i) => line(i + 1));
  api.defaults["GET /payment-methods"] = { methods: [{ code: "cash", name: "نقد", kind: "cash", requiresRef: false }] };
  api.defaults["GET /shifts/current"] = { id: SHIFT, userId: ACTOR, branchId: "b1", status: "open", openingCash: "0", openedAt: "2026-10-10T08:00:00Z" };
  api.defaults["GET /gift-options"] = { wraps: [], colors: [], flowers: [] };
  api.defaults[`GET /invoices/${INVOICE}/customer`] = { customer: null };
  api.defaults[`GET /invoices/${INVOICE}/payments`] = { payments: [] };
  api.handlers.set(`GET /invoices/${INVOICE}`, async route => { await route.fulfill({ json: invoiceOf(lines) }); });
  api.handlers.set("GET /pos/products", async (route, url) => {
    const n = Number((url.searchParams.get("q") ?? "").replace("SKU-", ""));
    await route.fulfill({ json: { products: [], exactVariationId: variation(n) } });
  });
  api.handlers.set(`POST /invoices/${INVOICE}/scan`, async route => {
    const body = route.request().postDataJSON() as { variationId: string };
    lines.push(line(Number(body.variationId.slice(-12))));
    await route.fulfill({ json: { invoice: invoiceOf(lines), replayed: false } });
  });
}

/** یک افزودن: keydown → پاسخ اسکن → ردیف و جمع تازه. هر سه زمان از performance.now خودِ صفحه. */
async function addOne(page: Page, n: number, expectedRows: number) {
  const entry = page.getByRole("region", { name: "افزودن کالا" }).getByRole("searchbox");
  await expect(entry).toBeEnabled();
  await entry.fill(`SKU-${n}`);
  const done = page.evaluate((rows) => new Promise<{ t0: number; lookupEnd: number; scanStart: number; response: number; t1: number }>((resolve) => {
    const payable = () => [...document.querySelectorAll("dt")].find(dt => dt.textContent === "قابل پرداخت")?.nextElementSibling?.textContent ?? "";
    const before = payable();
    let t0 = 0;
    // در هر پنجرهٔ اندازه‌گیری فقط یک Enter زده می‌شود؛ شنوندهٔ capture روی سند، پیش از هر کار برنامه.
    document.addEventListener("keydown", e => { if (e.key === "Enter" && t0 === 0) t0 = performance.now(); }, { capture: true });
    const check = () => {
      if (t0 === 0 || document.querySelectorAll(".lines li").length !== rows || payable() === before) return;
      observer.disconnect();
      const t1 = performance.now();
      const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
      const scan = entries.filter(r => r.name.includes("/scan")).at(-1);
      const lookup = entries.filter(r => r.name.includes("/pos/products")).at(-1);
      resolve({ t0, lookupEnd: lookup?.responseEnd ?? t0, scanStart: scan?.startTime ?? t0, response: scan?.responseEnd ?? t1, t1 });
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  }), expectedRows);
  await entry.press("Enter");
  const r = await done;
  return { total: r.t1 - r.t0, lookup: r.lookupEnd - r.t0, prep: r.scanStart - r.lookupEnd, scan: r.response - r.scanStart, render: r.t1 - r.response };
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b), q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return { median: +q(0.5).toFixed(1), p90: +q(0.9).toFixed(1), max: +s.at(-1)!.toFixed(1) };
};
const results: Array<Record<string, unknown>> = [];

for (const size of [1, 60, 150]) for (const perf of ["off", "on"] as const) for (const cpu of [1, 4, 6]) {
  test(`سبد ${size} قلمی، حالت عملکرد ${perf}، CPU ×${cpu}`, async ({ page, api }) => {
    mockPos(api, size);
    await page.addInitScript(([inv, shift, mode]) => {
      localStorage.setItem("labelmod_open_cart", JSON.stringify({ invoiceId: inv, shiftId: shift }));
      localStorage.setItem("lm.perf", mode!);
    }, [INVOICE, SHIFT, perf]);
    await page.goto("/?page=pos&pos.branch=b1&pos.warehouse=w1");
    await expect(page.locator(".lines li")).toHaveCount(size);
    expect(await page.evaluate(() => document.documentElement.dataset.perf)).toBe(perf);
    let cdp: CDPSession | null = null;
    if (cpu > 1) { cdp = await page.context().newCDPSession(page); await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu }); }
    const samples: Array<Record<"total" | "lookup" | "prep" | "scan" | "render", number>> = [];
    for (let i = 0; i < WARMUP + ROUNDS; i++) {
      const n = 10_000 + i;
      const s = await addOne(page, n, size + i + 1);
      // درستی، نه زمان: ردیف تازه و جمع تازه واقعاً روی صفحه‌اند.
      await expect(page.locator(".lines li").last()).toContainText(`کالای آزمایشی ${n}`);
      if (i >= WARMUP) samples.push(s);
    }
    if (cdp) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    const row = { cart: size, perf, cpu, rounds: samples.length,
      ...Object.fromEntries((["total", "lookup", "prep", "scan", "render"] as const).map(k => [k, stats(samples.map(s => s[k]))])) };
    results.push(row);
    process.stdout.write(JSON.stringify(row) + "\n");
  });
}

test.afterAll(() => {
  if (process.env.PERF_OUT) writeFileSync(process.env.PERF_OUT, JSON.stringify({ measuredAt: new Date().toISOString(), rounds: ROUNDS, results }, null, 2));
});
