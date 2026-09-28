/**
 * اتصال صف به مسیر فروش (FND-002).
 *
 * ── چرا یک بند این پرونده روی **سورس** ادعا می‌کند ────────────────────
 *
 * خودِ یافته این بود: `OfflineQueue` درست نوشته شده بود، تست سبز داشت،
 * و **هیچ‌کس صدایش نمی‌زد**. یعنی همان کلاس FND-021. تستی که فقط کلاس را
 * بسنجد، دقیقاً همان سبزِ بی‌معنا را دوباره می‌سازد — پس یک بند صریح
 * می‌سنجد که مسیر `finalize` واقعاً صف می‌کند، و با **همان** کلید.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pendingLabel, replay, summarize } from "../src/lib/sale-queue.ts";
import type { QueuedRequest } from "../src/lib/offline-queue.ts";

const actor = "11111111-1111-4111-8111-111111111111";
const invoice = "22222222-2222-4222-8222-222222222222";
const branch = "33333333-3333-4333-8333-333333333333";
const shift = "44444444-4444-4444-8444-444444444444";
const row = (over: Partial<QueuedRequest> = {}): QueuedRequest => ({
  id: `finalize:${invoice}`, method: "POST", path: `/invoices/${invoice}/finalize`,
  saleContext: { actorId: actor, invoiceId: invoice, branchId: branch, shiftId: shift },
  body: {}, idempotencyKey: "key-1", label: "فروش",
  queuedAt: 1_700_000_000_000, attempts: 0, ...over,
});

test("بازفرست از همان مشتری API می‌گذرد و کلید را هدر می‌کند", async () => {
  const seen: { url?: string; init?: RequestInit } = {};
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (url === "/api/auth/me") return new Response(JSON.stringify({ id: actor }), { status: 200 });
    if (url === `/api/invoices/${invoice}`) return new Response(JSON.stringify({ id: invoice, createdBy: actor, branchId: branch, shiftId: shift, status: "draft" }), { status: 200 });
    if (url.startsWith("/api/shifts/current")) return new Response(JSON.stringify({ id: shift, userId: actor, status: "open" }), { status: 200 });
    seen.url = url;
    seen.init = init;
    return new Response(JSON.stringify({id:invoice,status:"finalized",number:"TEST-1"}), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    await replay(row());
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen.url, `/api/invoices/${invoice}/finalize`);
  assert.equal(seen.init?.method, "POST");
  // بی این هدر، بازفرست یک فاکتور **دوم** می‌ساخت.
  const headers = seen.init?.headers as Record<string, string>;
  assert.equal(headers["idempotency-key"], "key-1");
  // کوکی نشست در کوکی HttpOnly است؛ بی این، هر بازفرست ۴۰۱ می‌گرفت.
  assert.equal(seen.init?.credentials, "include");
});

test("متد ناشناخته حدس زده نمی‌شود", async () => {
  await assert.rejects(() => replay(row({ method: "PUT" })));
});

test("نشانگر معلق‌ها در صف خالی چیزی نشان نمی‌دهد", () => {
  assert.equal(pendingLabel(summarize([])), null);
});

test("نشانگر، ردیف پارک‌شده را جدا می‌شمارد", () => {
  const s = summarize([row(), row({ id: "b", pausedReason: "response_error" })]);
  assert.deepEqual(s, { total: 2, parked: 1 });
  const text = pendingLabel(s) ?? "";
  assert.match(text, /2 فروش در انتظار ارسال/);
  assert.match(text, /1 نیازمند رسیدگی/);
});

test("مسیر finalize صندوق واقعاً صف می‌کند — و با همان کلید", () => {
  const src = readFileSync(new URL("../src/screens/Pos.tsx", import.meta.url), "utf8");

  // همان بازتولیدی که یافته را ساخت: آیا مصرف‌کننده‌ای وجود دارد؟
  assert.match(src, /from "\.\.\/lib\/sale-queue\.ts"/, "صندوق صف را import نمی‌کند — همان FND-002.");

  const at = src.indexOf("const finalize = () =>");
  assert.ok(at > 0, "مسیر finalize پیدا نشد.");
  const body = src.slice(at, src.indexOf("const closeShift", at));

  assert.match(body, /saleQueue\(\)\.enqueue\(/, "مسیر finalize صف نمی‌کند.");
  // دروازه: خطای قاعده‌ای صف نمی‌شود، وگرنه «موجودی کافی نیست» تا ابد
  // تلاش می‌شد و صندوق‌دار هرگز جواب سرور را نمی‌دید.
  assert.match(body, /if \(!isNetworkFailure\(err\)\) throw err;/, "دروازهٔ isNetworkFailure در مسیر finalize نیست.");
  // کلید **همان** کلید تلاش ناموفق است، نه یک کلید تازه.
  assert.match(body, /const key = keys\.current\.keyFor\(action\);/, "کلید Idempotency از keyFor نمی‌آید.");
  assert.match(body, /idempotencyKey: key,/, "ردیف صف کلید تلاش ناموفق را نمی‌برد.");
  assert.ok(
    !/keys\.current\.run\(`finalize/.test(body),
    "`run()` در موفقیت کلید را پاک می‌کند و مسیر شکست را بی‌کلید می‌گذاشت.",
  );

  /*
   * ترتیب: `enqueue` باید **پیش از** پاک‌کردن سبد باشد. برعکسش یعنی
   * اگر صف خطا بدهد، فروش هم از صفحه رفته باشد و هم در صف نباشد.
   */
  assert.ok(
    body.indexOf("saleQueue().enqueue(") < body.indexOf("forgetCart()"),
    "سبد پیش از نشستنِ فروش در صف پاک می‌شود — فروش می‌تواند گم شود.",
  );
});

test("صف فقط به finalize وصل است، نه به اسکن و پرداخت", () => {
  /*
   * مرزِ «صف آفلاین ≠ حالت آفلاین کامل». صف‌شدن اسکن یا پرداخت یعنی
   * صفحه قیمت یا مانده‌ای نشان بدهد که سرور تأییدش نکرده — و همان
   * چیزی است که CLAUDE.md صریح ممنوع کرده.
   */
  const src = readFileSync(new URL("../src/screens/Pos.tsx", import.meta.url), "utf8");
  const calls = [...src.matchAll(/saleQueue\(\)\.enqueue\(/g)].length;
  assert.equal(calls, 1, `صف در ${calls} مسیر استفاده شده — دامنه از finalize بیرون رفته.`);
});


test("untrusted queued destinations, payloads and legacy records never reach the network", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unexpected network"); };
  try {
    for (const over of [{path:"/users/admin/password"}, {path:`/invoices/${invoice}/finalize?bypass=1`},
      {body:{actorId:actor}}, {body:[]}, {body:null}]) {
      await assert.rejects(replay(row(over)));
    }
    const legacy = row(); delete legacy.saleContext;
    await assert.rejects(replay(legacy));
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test("changed user cannot replay even manually; no POST is sent", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => { calls.push(url); return new Response(JSON.stringify({id:branch})); }) as typeof fetch;
  try { await assert.rejects(replay(row())); assert.deepEqual(calls, ["/api/auth/me"]); }
  finally { globalThis.fetch = original; }
});
