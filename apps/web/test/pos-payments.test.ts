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
import { allOptions, cartCounts, checkAmount, checkoutErrorMessage, checkoutTotals, DIGIPAY_NOT_IMPLEMENTED, LINK_NOT_IMPLEMENTED,
  maxAmount, NEEDS_CUSTOMER_REASON, SNAPPAY_NOT_CONFIGURED, usableChannel,
  finalAmounts, intentFromPending, intentToPending, paymentBody, paymentFailureKind, paymentLayout, paymentLocked,
  resolveIntentStatus, type PaymentIntent, type PaymentPhase } from "../src/lib/pos-payments.ts";
import { clearPendingPayment, readPendingPayment, writePendingPayment } from "../src/lib/pending-payment.ts";
import type { KeyValueStorage } from "../src/lib/queue-store.ts";
import { formatMoney } from "../src/lib/format.ts";
import type { PaymentMethod } from "../src/lib/pos.ts";

const m = (code: string, kind: string, requiresRef = false): PaymentMethod => ({ code, name: code, kind, requiresRef });
const SEED = [m("cash", "cash"), m("card", "card_reader", true), m("transfer", "transfer", true), m("gateway", "gateway", true),
  m("credit", "credit"), m("points", "points"), m("giftcard", "gift_card", true)];
const codes = (xs: { code: string }[]) => xs.map((x) => x.code);

describe("گروه‌بندی روش‌ها — نیاز مالک محصول (POS-05 تا POS-09)", () => {
  test("ردیف ۱ کارت‌خوان؛ ردیف ۲ همیشه اسنپ‌پی و دیجی‌پی به همین ترتیب؛ بقیه زیر «بیشتر» با ترتیب ثابت", () => {
    const l = paymentLayout(SEED, { hasCustomer: true });
    assert.deepEqual(codes(l.primary), ["card"]);
    assert.deepEqual(l.providers.map((p) => [p.key, p.label]), [["snappay", "اسنپ‌پی"], ["digipay", "دیجی‌پی"]]);
    assert.deepEqual(codes(l.more), ["cash", "transfer", "gateway", "points", "giftcard"]);
  });

  test("نقدی هرگز در ردیف اصلی نیست — فقط زیر «روش‌های بیشتر»", () => {
    const l = paymentLayout([...SEED, m("snappay", "gateway", true)], { hasCustomer: true });
    assert.ok(!codes(l.primary).includes("cash"));
    assert.ok(!l.providers.some((p) => p.option?.code === "cash"));
    assert.ok(codes(l.more).includes("cash"));
  });

  test("ترتیب از kind می‌آید، نه از ترتیب پاسخ سرور", () => {
    const l = paymentLayout([...SEED, m("snappay", "gateway", true)].reverse(), { hasCustomer: true });
    assert.deepEqual(codes(allOptions(l)), ["card", "snappay", "cash", "transfer", "gateway", "points", "giftcard"]);
  });

  test("نسیه و kind ناشناخته هرگز روش پرداخت نیستند", () => {
    const all = codes(allOptions(paymentLayout([...SEED, m("crypto", "crypto")], { hasCustomer: true })));
    assert.ok(!all.includes("credit"));
    assert.ok(!all.includes("crypto"));
  });

  test("دیجی‌پی همیشه دیده می‌شود و هرگز قابل ثبت نیست — حتی اگر سرور ردیفی با این کد بفرستد", () => {
    for (const methods of [SEED, [...SEED, m("digipay", "gateway", true), m("DigiPay", "gateway")]]) {
      const l = paymentLayout(methods, { hasCustomer: true });
      const digi = l.providers.find((p) => p.key === "digipay")!;
      assert.equal(digi.option, null, "هیچ مسیر ثبتی از خانهٔ دیجی‌پی نیست");
      assert.equal(digi.unavailableReason, DIGIPAY_NOT_IMPLEMENTED);
      assert.ok(digi.channels.every((c) => c.unavailableReason !== null));
      assert.ok(!codes(allOptions(l)).some((c) => c.toLowerCase() === "digipay"));
      assert.equal(usableChannel(digi, "in_person"), false);
      assert.equal(usableChannel(digi, "link"), false);
    }
  });

  test("اسنپ‌پی: بی ردیف سرور برای این شعبه دیده می‌شود ولی ناموجود است؛ با ردیف، قابل انتخاب کنار دیجی‌پی", () => {
    const off = paymentLayout(SEED, { hasCustomer: false }).providers.find((p) => p.key === "snappay")!;
    assert.equal(off.option, null);
    assert.equal(off.unavailableReason, SNAPPAY_NOT_CONFIGURED);
    assert.ok(!codes(allOptions(paymentLayout(SEED, { hasCustomer: false }))).includes("snappay"));
    const l = paymentLayout([...SEED, m("snappay", "gateway", true)], { hasCustomer: false });
    const on = l.providers.find((p) => p.key === "snappay")!;
    assert.equal(on.option?.code, "snappay");
    assert.equal(on.option?.group, "provider");
    assert.equal(on.unavailableReason, null);
    assert.ok(!codes(l.more).includes("snappay"), "اسنپ‌پی درگاه دستی معمولی نیست");
  });

  test("کانال: «حضوری» و «لینک پرداخت» هر دو دیده می‌شوند؛ لینک هرگز قابل استفاده نیست چون سرور پشتوانه ندارد", () => {
    const snap = paymentLayout([...SEED, m("snappay", "gateway", true)], { hasCustomer: true }).providers[0]!;
    assert.deepEqual(snap.channels.map((c) => [c.key, c.label]), [["in_person", "حضوری"], ["link", "لینک پرداخت"]]);
    assert.equal(usableChannel(snap, "in_person"), true);
    assert.equal(usableChannel(snap, "link"), false);
    assert.equal(snap.channels.find((c) => c.key === "link")!.unavailableReason, LINK_NOT_IMPLEMENTED);
    const snapOff = paymentLayout(SEED, { hasCustomer: true }).providers[0]!;
    assert.equal(usableChannel(snapOff, "in_person"), false, "بی ردیف سرور، حضوری هم نیست");
  });

  test("روش فعال فقط از پاسخ سرور: روشی که نیامده، نیست", () => {
    const l = paymentLayout([m("cash", "cash")], { hasCustomer: false });
    assert.deepEqual(l.primary, []);
    assert.deepEqual(codes(l.more), ["cash"]);
    assert.ok(l.providers.every((p) => p.option === null));
    assert.deepEqual(codes(allOptions(l)), ["cash"]);
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

  const A: PaymentIntent = { key: "11111111-1111-4111-8111-111111111111", invoiceId: "22222222-2222-4222-8222-222222222222",
    methodCode: "card", methodName: "کارت‌خوان", amount: 100_000n, refNo: "REF-A" };
  const recorded = (over: Partial<{ methodCode: string; amount: string; refNo: string | null; status: string }> = {}) => ({
    state: "recorded" as const, terminal: true as const,
    payment: { id: "p", methodCode: "card", amount: "100000", refNo: "REF-A", status: "succeeded", ...over } });

  test("وضعیت فقط از هویت همین قصد؛ «پیدا نشد» هرگز «ثبت نشد» نیست", () => {
    assert.equal(resolveIntentStatus(A, recorded()), "recorded");
    assert.equal(resolveIntentStatus(A, { state: "not_found", terminal: false }), "unresolved");
    assert.equal(resolveIntentStatus(A, { state: "abandoned", terminal: true }), "not_recorded_final");
    assert.equal(resolveIntentStatus(A, { state: "key_conflict", terminal: true }), "not_recorded_final");
    assert.equal(resolveIntentStatus(A, { state: "invoice_closed", terminal: true, invoiceStatus: "finalized" }), "not_recorded_final");
    // ردیفِ همین شناسه ولی بدنهٔ دیگر حدس زده نمی‌شود.
    for (const over of [{ amount: "100001" }, { methodCode: "transfer" }, { refNo: "REF-B" }, { refNo: null }, { status: "reversed" }])
      assert.equal(resolveIntentStatus(A, recorded(over)), "mismatch", JSON.stringify(over));
  });

  test("جمع دریافتی هیچ نقشی در حکم ندارد — منطق تجمیعی بازنشسته است", () => {
    const lib = readFileSync(new URL("../src/lib/pos-payments.ts", import.meta.url), "utf8");
    const pos = readFileSync(new URL("../src/screens/Pos.tsx", import.meta.url), "utf8");
    for (const src of [lib, pos]) {
      assert.ok(!/resolveByReceived|receivedBefore/.test(src), "مقایسهٔ «دریافتی قبل/بعد» برگشته است");
    }
    // تابع حکم اصلاً ورودیِ «دریافتی» ندارد.
    assert.equal(resolveIntentStatus.length, 2);
    const check = pos.slice(pos.indexOf("const checkPayment = () =>"), pos.indexOf("const retryPayment"));
    assert.match(check, /pos\.paymentIntent\(intent\.invoiceId, intent\.key\)/, "بررسی وضعیت همان شناسه را می‌پرسد");
    assert.ok(!/receivedAmount|pos\.invoice\(/.test(check), "بررسی وضعیت از جمع فاکتور حکم نمی‌دهد");
  });

  test("هر حالتی جز آرام، روش و مبلغ را قفل می‌کند", () => {
    const phases: PaymentPhase[] = [{ kind: "submitting", intent: A }, { kind: "unknown", intent: A, reason: "ambiguous" },
      { kind: "unknown", intent: A, reason: "not_found_yet" }, { kind: "checking", intent: A }];
    for (const p of phases) assert.equal(paymentLocked(p), true, p.kind);
    assert.equal(paymentLocked({ kind: "idle" }), false);
  });

  test("ارسال دوباره همان قصد را با همان کلید و همان بدنه می‌برد؛ کلید تازه فقط برای قصد تازه", () => {
    const src = readFileSync(new URL("../src/screens/Pos.tsx", import.meta.url), "utf8");
    const retry = src.slice(src.indexOf("const retryPayment = () =>"), src.indexOf("const abandonPayment"));
    assert.match(retry, /submitPayment\(payPhase\.intent, true\)/, "ثبت دوباره باید همان قصد را بفرستد");
    const submit = src.slice(src.indexOf("const submitPayment = (intent: PaymentIntent, retry: boolean) =>"), src.indexOf("function holdIntent"));
    assert.match(submit, /pos\.pay\(intent\.invoiceId, paymentBody\(intent\), \{ idempotencyKey: intent\.key \}\)/);
    assert.ok(submit.indexOf("writePendingPayment") < submit.indexOf("pos.pay("), "ذخیرهٔ پایدار پیش از ارسال");
    const unknown = submit.slice(submit.indexOf('=== "unknown"'));
    assert.ok(unknown.indexOf("return;") < unknown.indexOf("clearPendingPayment"), "در نامعلوم قصد پاک نمی‌شود");
    const rejectedRetry = submit.slice(submit.indexOf("if (retry) { holdIntent"));
    assert.ok(rejectedRetry.indexOf("return;") < rejectedRetry.indexOf("clearPendingPayment"), "ردِ ارسال دوباره قصد را نمی‌بندد");
    assert.equal((src.match(/crypto\.randomUUID\(\), invoiceId: invoice\.id, methodCode/g) ?? []).length, 1, "کلید تازه فقط در takePayment");
    assert.deepEqual(paymentBody(A), { methodCode: "card", amount: "100000", refNo: "REF-A" });
    assert.deepEqual(paymentBody({ ...A, refNo: "" }), { methodCode: "card", amount: "100000" });
  });
});

/** ذخیرهٔ ساختگی با همان قرارداد `localStorage`. */
function memStore(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: (k) => { data.delete(k); } };
}

describe("پرداخت معلق پایدار", () => {
  const actor = "33333333-3333-4333-8333-333333333333";
  const shiftId = "44444444-4444-4444-8444-444444444444";
  const A: PaymentIntent = { key: "11111111-1111-4111-8111-111111111111", invoiceId: "22222222-2222-4222-8222-222222222222",
    methodCode: "card", methodName: "کارت‌خوان", amount: 100_000n, refNo: "REF-A" };

  test("قصد پس از Reload با همان کلید، مبلغ و بدنه برمی‌گردد — کلید تازه ساخته نمی‌شود", () => {
    const st = memStore();
    writePendingPayment(intentToPending(A, { actorId: actor, shiftId }, "sending"), st);
    writePendingPayment(intentToPending(A, { actorId: actor, shiftId }, "unresolved"), st);
    const back = readPendingPayment(actor, st);
    assert.ok(back);
    assert.equal(back.state, "unresolved");
    assert.equal(back.amount, "100000", "پول رشتهٔ ریالی است، نه number");
    assert.deepEqual(intentFromPending(back), A);
    assert.deepEqual(paymentBody(intentFromPending(back)), paymentBody(A), "بدنهٔ ارسال دوباره همان است");
    assert.equal(readPendingPayment("55555555-5555-4555-8555-555555555555", st), null, "به کاربر دیگر نمی‌رسد");
  });

  test("قصد دیگر یا بدنهٔ دیگر بازنویسی نمی‌شود؛ پاک‌کردن فقط با همان کلید", () => {
    const st = memStore();
    const pend = intentToPending(A, { actorId: actor, shiftId }, "sending");
    writePendingPayment(pend, st);
    assert.throws(() => writePendingPayment({ ...pend, key: "66666666-6666-4666-8666-666666666666" }, st), /تعیین تکلیف نشده/);
    assert.throws(() => writePendingPayment({ ...pend, amount: "100001" }, st), /عوض نمی‌شود/);
    assert.throws(() => clearPendingPayment(actor, "66666666-6666-4666-8666-666666666666", st), /پاک نشد/);
    assert.ok(readPendingPayment(actor, st));
    clearPendingPayment(actor, A.key, st);
    assert.equal(readPendingPayment(actor, st), null, "پاک‌سازی پس از حالت نهایی");
  });

  test("دادهٔ خراب پاک نمی‌شود و «پرداخت معلقی نیست» هم گفته نمی‌شود", () => {
    for (const raw of ["{", JSON.stringify({ ...intentToPending(A, { actorId: actor, shiftId }, "sending"), amount: "1.5" }),
      JSON.stringify({ ...intentToPending(A, { actorId: actor, shiftId }, "sending"), amount: 100000 }),
      JSON.stringify({ ...intentToPending(A, { actorId: actor, shiftId }, "sending"), key: "x" }),
      JSON.stringify({ ...intentToPending(A, { actorId: actor, shiftId }, "sending"), extra: 1 })]) {
      const st = memStore();
      st.setItem(`labelmod_pending_payment_v1:${actor}`, raw);
      assert.throws(() => readPendingPayment(actor, st), /حفظ شد/, raw);
      assert.equal(st.getItem(`labelmod_pending_payment_v1:${actor}`), raw);
    }
  });

  test("قصد بازیابی‌شده قفل است و فقط با حالت نهایی سرور پاک می‌شود", () => {
    const src = readFileSync(new URL("../src/screens/Pos.tsx", import.meta.url), "utf8");
    const recovery = src.slice(src.indexOf("let held: PendingPayment | null"), src.indexOf("const openDraft ="));
    assert.match(recovery, /setPayPhase\(\{ kind: "unknown", intent: intentFromPending\(held\)/);
    assert.ok(!/randomUUID/.test(recovery), "بازیابی کلید تازه نمی‌سازد");
    const settle = src.slice(src.indexOf("async function settleIntent"), src.indexOf("const takePayment"));
    assert.ok(settle.indexOf('verdict === "unresolved"') < settle.indexOf("clearPendingPayment"), "«هنوز پیدا نشد» پاک نمی‌کند");
  });
});

describe("«ثبت شد» از تسویهٔ قطعی", () => {
  test("مبلغ‌ها از settlement سرور؛ نبودنش null است نه صفر", () => {
    assert.deepEqual(finalAmounts({ payableAmount: "1000001", paidAmount: "300000", receivedAmount: "300000", changeAmount: "0", dueAmount: "700001" }),
      { payable: 1_000_001n, paid: 300_000n, received: 300_000n, change: 0n, credit: 700_001n });
    assert.equal(finalAmounts({ payableAmount: "1000001", paidAmount: "1000001", receivedAmount: "1050001", changeAmount: "50000", dueAmount: "0" })?.change, 50_000n);
    assert.equal(finalAmounts(null), null);
    assert.equal(finalAmounts(undefined), null);
  });

  test("نهایی‌سازی و بررسی آن تصویر پیش از نهایی‌سازی را منبع مبلغ نمی‌کنند", () => {
    const src = readFileSync(new URL("../src/screens/Pos.tsx", import.meta.url), "utf8");
    const fin = src.slice(src.indexOf("const finalize = () =>"), src.indexOf("function completeSale"));
    assert.match(fin, /completeSale\(invoice\.id, done\.number, finalAmounts\(done\.settlement\), null\)/);
    assert.match(fin, /completeSale\(invoice\.id, fresh\.number, finalAmounts\(fresh\.settlement\), null\)/);
    assert.ok(!/snapshot/.test(fin), "تصویر کلاینت برگشته است");
    const sc = readFileSync(new URL("../src/components/pos/SaleComplete.tsx", import.meta.url), "utf8");
    assert.ok(!/sale\.(received|payable|change|credit)\b/.test(sc), "SaleComplete فقط از amounts یا estimate می‌خواند");
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
