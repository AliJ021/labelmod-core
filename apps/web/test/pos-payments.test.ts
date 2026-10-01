/**
 * انتخاب‌گر پرداخت صندوق (Batch 2.1) — منطق خالص.
 *
 * قواعد مالی خودِ سرور در `apps/api/test/pos-readiness.integration.test.ts` و
 * SQL سنجیده می‌شوند؛ اینجا فقط اینکه صفحه چه چیزی را چگونه نشان می‌دهد و چه
 * چیزی را هرگز نشان نمی‌دهد، و اینکه «نامعلوم» به «ثبت شد» یا «ثبت نشد» حدس
 * زده نمی‌شود.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ApiError } from "../src/lib/api.ts";
import { allOptions, cartCounts, checkAmount, checkoutErrorMessage, checkoutTotals, maxAmount, NEEDS_CUSTOMER_REASON,
  paymentFailureKind, paymentLayout, paymentLocked, resolveByReceived, type PaymentPhase } from "../src/lib/pos-payments.ts";
import { formatMoney } from "../src/lib/format.ts";
import type { PaymentMethod } from "../src/lib/pos.ts";

const m = (code: string, kind: string, requiresRef = false): PaymentMethod => ({ code, name: code, kind, requiresRef });
const SEED = [m("cash", "cash"), m("card", "card_reader", true), m("transfer", "transfer", true), m("gateway", "gateway", true),
  m("credit", "credit"), m("points", "points"), m("giftcard", "gift_card", true)];
const codes = (xs: { code: string }[]) => xs.map((x) => x.code);

describe("گروه‌بندی روش‌ها", () => {
  test("کارت‌خوان اصلی؛ نقدی ردیف دوم؛ بقیه زیر «بیشتر» با ترتیب ثابت", () => {
    const l = paymentLayout(SEED, { hasCustomer: true });
    assert.deepEqual(codes(l.primary), ["card"]);
    assert.deepEqual(codes(l.secondary), ["cash"]);
    assert.deepEqual(codes(l.more), ["transfer", "gateway", "points", "giftcard"]);
  });

  test("ترتیب از kind می‌آید، نه از ترتیب پاسخ سرور", () => {
    const l = paymentLayout([...SEED].reverse(), { hasCustomer: true });
    assert.deepEqual(codes(allOptions(l)), ["card", "cash", "transfer", "gateway", "points", "giftcard"]);
  });

  test("نسیه هرگز روش پرداخت نیست؛ دیجی‌پی و kind ناشناخته هرگز نمایش داده نمی‌شوند", () => {
    const l = paymentLayout([...SEED, m("digipay", "gateway", true), m("DigiPay", "gateway"), m("crypto", "crypto")], { hasCustomer: true });
    const all = codes(allOptions(l));
    assert.ok(!all.includes("credit"));
    assert.ok(!all.some((c) => c.toLowerCase() === "digipay"));
    assert.ok(!all.includes("crypto"));
  });

  test("اسنپ‌پی فقط وقتی سرور فرستاده، و آن‌وقت کنار نقدی", () => {
    assert.ok(!codes(allOptions(paymentLayout(SEED, { hasCustomer: false }))).includes("snappay"));
    const l = paymentLayout([...SEED, m("snappay", "gateway", true)], { hasCustomer: false });
    assert.deepEqual(codes(l.secondary), ["cash", "snappay"]);
    assert.ok(!codes(l.more).includes("snappay"), "اسنپ‌پی درگاه دستی معمولی نیست");
  });

  test("روش فعال فقط از پاسخ سرور: روشی که نیامده، نیست", () => {
    const l = paymentLayout([m("cash", "cash")], { hasCustomer: false });
    assert.deepEqual(l, { primary: [], secondary: l.secondary, more: [] });
    assert.deepEqual(codes(l.secondary), ["cash"]);
  });

  test("امتیاز و کارت هدیه بی مشتری قابل انتخاب نیستند و دلیلشان دیده می‌شود", () => {
    const without = allOptions(paymentLayout(SEED, { hasCustomer: false }));
    for (const o of without) {
      if (o.kind === "points" || o.kind === "gift_card") assert.equal(o.unavailableReason, NEEDS_CUSTOMER_REASON, o.code);
      else assert.equal(o.unavailableReason, null, o.code);
    }
    assert.ok(allOptions(paymentLayout(SEED, { hasCustomer: true })).every((o) => o.unavailableReason === null));
  });
});

describe("سقف مبلغ", () => {
  const cash = { allowsChange: true }, card = { allowsChange: false };
  test("غیرنقدی حداکثر تا مانده؛ نقد بی‌سقف (باقی پول)", () => {
    assert.equal(maxAmount(card, 150_000n), 150_000n);
    assert.equal(maxAmount(card, 0n), 0n);
    assert.equal(maxAmount(cash, 150_000n), null);
  });
  test("دقیق و کمتر مجاز، بیشتر نه — مرز دقیق bigint", () => {
    assert.deepEqual(checkAmount(card, 150_000n, 150_000n), { ok: true, amount: 150_000n });
    assert.deepEqual(checkAmount(card, 149_990n, 150_000n), { ok: true, amount: 149_990n });
    assert.deepEqual(checkAmount(card, 150_010n, 150_000n), { ok: false, reason: "over_max", max: 150_000n });
    assert.deepEqual(checkAmount(cash, 250_000n, 150_000n), { ok: true, amount: 250_000n }, "نقد اضافه = باقی پول");
  });
  test("خالی یعنی همهٔ مانده؛ مانده صفر برای غیرنقدی چیزی برای گرفتن نیست", () => {
    assert.deepEqual(checkAmount(card, null, 70_000n), { ok: true, amount: 70_000n });
    assert.deepEqual(checkAmount(card, null, 0n), { ok: false, reason: "nothing_due" });
    assert.deepEqual(checkAmount(cash, null, 0n), { ok: false, reason: "zero" });
    assert.deepEqual(checkAmount(cash, 0n, 10n), { ok: false, reason: "zero" });
    assert.deepEqual(checkAmount(cash, "invalid", 10n), { ok: false, reason: "invalid" });
  });
});

describe("پرداخت با نتیجهٔ نامعلوم", () => {
  test("رد قطعی در برابر نامعلوم", () => {
    const e = (status: number, code = "x") => new ApiError(status, code, "m", null);
    assert.equal(paymentFailureKind(e(422, "non_cash_overpayment")), "rejected");
    assert.equal(paymentFailureKind(e(403, "forbidden")), "rejected");
    assert.equal(paymentFailureKind(e(409, "rule_violation")), "rejected");
    for (const err of [e(500), e(502), e(503), e(504), e(408), e(409, "idempotency_in_flight"), e(409, "idempotency_key_reused"), new TypeError("Failed to fetch")])
      assert.equal(paymentFailureKind(err), "unknown", String(err));
  });

  test("بررسی وضعیت فقط با تغییر دقیقاً برابر مبلغ «ثبت شد» است؛ تغییر دیگر حدس زده نمی‌شود", () => {
    const intent = { amount: 50_000n, receivedBefore: 100_000n };
    assert.equal(resolveByReceived(intent, 150_000n), "recorded");
    assert.equal(resolveByReceived(intent, 100_000n), "not_recorded");
    assert.equal(resolveByReceived(intent, 130_000n), "unknown");
    assert.equal(resolveByReceived(intent, 200_000n), "unknown", "دو برابر یعنی پرداخت دیگری هم هست");
  });

  test("هر حالتی جز آرام، روش و مبلغ را قفل می‌کند", () => {
    const intent = { action: "pay:i:0", methodCode: "card", methodName: "کارت‌خوان", amount: 1n, refNo: "", receivedBefore: 0n };
    const phases: PaymentPhase[] = [{ kind: "submitting", intent }, { kind: "unknown", intent }, { kind: "checking", intent }, { kind: "not_recorded", intent }];
    for (const p of phases) assert.equal(paymentLocked(p), true, p.kind);
    assert.equal(paymentLocked({ kind: "idle" }), false);
  });

  test("ارسال دوباره با همان قصد همان نام عمل (و پس همان کلید) را می‌برد", () => {
    const src = readFileSync(new URL("../src/screens/Pos.tsx", import.meta.url), "utf8");
    const retry = src.slice(src.indexOf("const retryPayment = () =>"), src.indexOf("const discardPayment"));
    assert.match(retry, /submitPayment\(payPhase\.intent\)/, "ثبت دوباره باید همان قصد را بفرستد");
    const submit = src.slice(src.indexOf("const submitPayment = (intent: PaymentIntent) =>"), src.indexOf("const takePayment"));
    assert.match(submit, /keys\.current\.run\(intent\.action,/, "کلید از نام عمل قصد می‌آید");
    const unknown = submit.slice(submit.indexOf('=== "unknown"'));
    assert.ok(unknown.indexOf("return;") < unknown.indexOf("keys.current.clear"), "در نامعلوم کلید آزاد نمی‌شود");
  });
});

describe("جمع‌ها و نمایش پول", () => {
  const inv = { grossAmount: "220000", discountAmount: "20000", taxAmount: "0", shippingAmount: "0", payableAmount: "200000" };
  test("مانده و باقی پول با bigint؛ هرگز هر دو مثبت", () => {
    assert.deepEqual(checkoutTotals(inv, 50_000n), { gross: 220_000n, discount: 20_000n, tax: 0n, shipping: 0n, payable: 200_000n, received: 50_000n, remaining: 150_000n, change: 0n });
    const over = checkoutTotals(inv, 250_000n);
    assert.equal(over.remaining, 0n); assert.equal(over.change, 50_000n);
    const exact = checkoutTotals(inv, 200_000n);
    assert.equal(exact.remaining, 0n); assert.equal(exact.change, 0n);
    assert.equal(checkoutTotals(null, 0n).payable, 0n);
  });
  test("ریال به تومان یک بار، رقم لاتین با «٬»، منفی با «−»", () => {
    assert.equal(formatMoney(150_000n), "15٬000");
    assert.equal(formatMoney(-20_000n), "−2٬000");
    assert.equal(formatMoney(0n), "0");
  });
  test("ردیف و عدد دو شمارش جدایند", () => {
    assert.deepEqual(cartCounts([{ qty: "2" }, { qty: "1" }]), { lines: 2, units: 3 });
    assert.deepEqual(cartCounts([]), { lines: 0, units: 0 });
  });
  test("خطاهای مهم پیام قابل اقدام فارسی دارند؛ ناشناخته همان پیام سرور", () => {
    const e = (code: string, msg = "سرور") => new ApiError(422, code, msg, null);
    assert.equal(checkoutErrorMessage(e("credit_needs_customer")), "برای فروش نسیه ابتدا مشتری را انتخاب کنید.");
    assert.match(checkoutErrorMessage(e("non_cash_overpayment")), /حداکثر/);
    assert.match(checkoutErrorMessage(e("snappay_not_configured")), /این شعبه/);
    assert.match(checkoutErrorMessage(e("idempotency_key_reused")), /بررسی وضعیت/);
    assert.match(checkoutErrorMessage(e("insufficient_stock", "موجودی قابل‌فروش X: 0")), /موجودی تغییر کرده/);
    assert.equal(checkoutErrorMessage(e("something_else", "پیام سرور")), "پیام سرور");
    assert.equal(checkoutErrorMessage(new ApiError(500, "internal", "خطای داخلی", null)), "خطای داخلی", "۵۰۰ به‌شکل قاعدهٔ کسب‌وکار پنهان نمی‌شود");
  });
});

describe("صندوق — ساختار", () => {
  const src = readFileSync(new URL("../src/screens/Pos.tsx", import.meta.url), "utf8");
  test("هیچ نویسهٔ «﷼» کنار مبلغ؛ سطر بی aria-live", () => {
    assert.ok(!src.includes("﷼"));
    const row = src.slice(src.indexOf("const CartLine = memo("), src.indexOf("}, sameLine);"));
    assert.ok(!/aria-live/.test(row.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")), "اعلام زندهٔ هر سطر برگشته");
    assert.equal(src.match(/aria-live="polite"/g)?.length, 1, "یک ناحیهٔ زندهٔ عمدی برای کل صندوق");
  });
  test("نهایی‌سازی و نسیه از عمل ایمن می‌گذرند و هر دو همان finalize را می‌رانند", () => {
    assert.match(src, /<SafeAction trigger="نهایی‌کردن فاکتور"[\s\S]*?run=\{finalize\} verify=\{verifyFinalize\}/);
    assert.match(src, /<CreditCheckout[\s\S]*?run=\{finalize\} verify=\{verifyFinalize\}/);
    assert.ok(!/methodCode: "credit"/.test(src), "صندوق هرگز ردیف پرداخت نسیه نمی‌فرستد");
  });
});
