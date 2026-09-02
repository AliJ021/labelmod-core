/**
 * کلید Idempotency.
 *
 * دو خطای متقارن که هیچ‌کدام خطا نمی‌دهند و هر دو پول را خراب
 * می‌کنند، اینجا قفل می‌شوند:
 *
 *   کلید تازه روی Retry   → یک اسکن، دو بار شمرده می‌شود
 *   کلید ثابت برای همیشه  → اسکن دوم عمدی، Replay اسکن اول می‌شود
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ActionKeys, ScanCounter, actionFor } from "../src/lib/action-key.ts";

/** مولد قابل پیش‌بینی، تا ادعاها درباره «همان کلید» معنا داشته باشند. */
function counterMint() {
  let n = 0;
  return () => `k${++n}`;
}

describe("پایداری کلید", () => {
  test("همان عمل، همان کلید — هر چند بار که پرسیده شود", () => {
    // این همان چیزی است که Retry شبکه را نجات می‌دهد.
    const keys = new ActionKeys(counterMint());
    const first = keys.keyFor("finalize:inv-1");
    assert.equal(keys.keyFor("finalize:inv-1"), first);
    assert.equal(keys.keyFor("finalize:inv-1"), first);
  });

  test("دو عمل متفاوت، دو کلید متفاوت", () => {
    const keys = new ActionKeys(counterMint());
    assert.notEqual(keys.keyFor("finalize:inv-1"), keys.keyFor("finalize:inv-2"));
  });

  test("بعد از پایان عمل، عمل بعدی کلید تازه می‌گیرد", () => {
    // بدون این، اسکن دوم عمدی Replay اسکن اول می‌شد.
    const keys = new ActionKeys(counterMint());
    const first = keys.keyFor("scan:inv-1:1");
    keys.clear("scan:inv-1:1");
    assert.notEqual(keys.keyFor("scan:inv-1:1"), first);
  });
});

describe("run", () => {
  test("در موفقیت کلید آزاد می‌شود", async () => {
    const keys = new ActionKeys(counterMint());
    const used: string[] = [];
    await keys.run("pay:inv-1", async (k) => void used.push(k));
    assert.equal(keys.size, 0, "کلیدی نمانده");
    assert.deepEqual(used, ["k1"]);
  });

  test("در شکست کلید می‌ماند و تلاش بعدی همان را می‌برد", async () => {
    // مهم‌ترین ادعای این فایل. اگر شکست فقط در شبکه بوده و سرور
    // پرداخت را ثبت کرده باشد، تلاش دوم با کلید تازه پول را دو بار
    // می‌گرفت.
    const keys = new ActionKeys(counterMint());
    const used: string[] = [];

    await assert.rejects(
      keys.run("pay:inv-1", async (k) => {
        used.push(k);
        throw new Error("قطع شبکه");
      }),
    );

    await keys.run("pay:inv-1", async (k) => void used.push(k));
    assert.deepEqual(used, ["k1", "k1"], "هر دو تلاش، یک کلید");
    assert.equal(keys.size, 0, "بعد از موفقیت آزاد شد");
  });

  test("چند شکست پشت سر هم هم کلید را عوض نمی‌کند", async () => {
    const keys = new ActionKeys(counterMint());
    const used: string[] = [];
    const boom = async (k: string) => {
      used.push(k);
      throw new Error("قطع شبکه");
    };
    for (let i = 0; i < 3; i++) {
      await assert.rejects(keys.run("pay:inv-1", boom));
    }
    assert.deepEqual(used, ["k1", "k1", "k1"]);
  });

  test("مقدار بازگشتی عبور داده می‌شود", async () => {
    const keys = new ActionKeys(counterMint());
    assert.equal(await keys.run("x", async () => 42), 42);
  });
});

describe("شمارنده اسکن", () => {
  test("هر کشیدن اسکنر یک عمل تازه است", () => {
    const c = new ScanCounter();
    const a = c.next("inv-1");
    const b = c.next("inv-1");
    assert.notEqual(a, b, "دو اسکن عمدی نباید یک عمل باشند");
  });

  test("با ActionKeys، دو اسکن دو کلید می‌گیرند", () => {
    // سناریوی واقعی: صندوق‌دار دو بار همان کالا را می‌کشد و انتظار
    // دارد تعداد دو شود.
    const keys = new ActionKeys(counterMint());
    const c = new ScanCounter();
    assert.notEqual(keys.keyFor(c.next("inv-1")), keys.keyFor(c.next("inv-1")));
  });

  test("reset شمارش را از نو شروع می‌کند", () => {
    const c = new ScanCounter();
    c.next("inv-1");
    c.reset();
    assert.equal(c.next("inv-1"), "scan:inv-1:1");
  });
});

describe("نام عمل از روی بدنه", () => {
  const body = (refund: string) => ({
    invoiceId: "inv-1",
    reasonCode: "defect",
    refundAmount: refund,
    lines: [{ invoiceLineId: "l-1", qty: "1" }],
  });

  test("همان فرم، همان کلید — پس Retry واقعاً Replay می‌شود", () => {
    // این نیمه‌ای است که نباید بشکند: اگر شبکه پاسخ را خورده باشد و
    // صندوق‌دار **بدون تغییر فرم** دوباره بفرستد، باید همان کلید برود
    // وگرنه برگ مرجوعی دوم ساخته می‌شود و پول دو بار برمی‌گردد.
    const keys = new ActionKeys(counterMint());
    const a = keys.keyFor(actionFor("return:inv-1", body("500000")));
    const b = keys.keyFor(actionFor("return:inv-1", body("500000")));
    assert.equal(a, b);
  });

  test("مبلغ عوض شود، کلید عوض می‌شود — وگرنه صفحه گیر می‌کرد", () => {
    // بن‌بستی که این را لازم کرد: ساخت روی شبکه می‌شکند، صندوق‌دار
    // مبلغ را اصلاح می‌کند، و با کلید ثابت سرور `idempotency_key_reused`
    // می‌داد. هر تلاش بعدی همان ۴۰۹ — تا Reload صفحه.
    const keys = new ActionKeys(counterMint());
    const a = keys.keyFor(actionFor("return:inv-1", body("500000")));
    const b = keys.keyFor(actionFor("return:inv-1", body("400000")));
    assert.notEqual(a, b);
  });

  test("اقلام انتخابی هم بخشی از هویت عمل‌اند", () => {
    const keys = new ActionKeys(counterMint());
    const one = { ...body("500000"), lines: [{ invoiceLineId: "l-1", qty: "1" }] };
    const two = { ...body("500000"), lines: [{ invoiceLineId: "l-1", qty: "2" }] };
    assert.notEqual(keys.keyFor(actionFor("return:inv-1", one)), keys.keyFor(actionFor("return:inv-1", two)));
  });

  test("پیشوند فاکتورهای متفاوت را جدا نگه می‌دارد", () => {
    const keys = new ActionKeys(counterMint());
    assert.notEqual(
      keys.keyFor(actionFor("return:inv-1", body("500000"))),
      keys.keyFor(actionFor("return:inv-2", body("500000"))),
    );
  });
});
