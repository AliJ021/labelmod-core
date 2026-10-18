import { test } from "node:test";
import assert from "node:assert/strict";
import {
  awardPayload, bonusStorageKey, checkBonusAmount, decisionPayload, parseBonusOperation, persistBonusOperation, requestPayload, selectable,
  type BonusBody,
} from "../src/lib/bonuses.ts";
import { checkAmount } from "../src/lib/withdrawals.ts";

const KEY = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";
const memory = () => {
  const values = new Map<string, string>();
  return { values, getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } };
};

test("درخواست و اعطا: مبلغ مثبت تومانی → ریال رشته‌ای، دلیل اجباری؛ صفر و اعشار رد", () => {
  assert.deepEqual(requestPayload("۱۲۵٬۰۰۰", "  فروش بالا "), { amount: "1250000", reason: "فروش بالا" });
  for (const [amount, reason] of [["0", "x"], ["", "x"], ["12.5", "x"], ["-3", "x"], ["10", "  "], ["10", "a‮b"]]) {
    assert.equal(requestPayload(amount!, reason!), null, `${amount}/${reason}`);
  }
  assert.equal(awardPayload(null, "10", "x"), null, "بی ذی‌نفع فرستادنی نیست");
  assert.deepEqual(checkBonusAmount("0"), { rial: null, error: "مبلغ پاداش باید بیشتر از صفر باشد." }, "پیام پاداش، نه برداشت");
  assert.deepEqual(checkAmount("0", false), { rial: null, error: "مبلغ برداشت باید بیشتر از صفر باشد." }, "برداشت دست‌نخورده");
  assert.deepEqual(awardPayload({ id: ID, name: "کارمند" }, "10", "x"), { ownerId: ID, ownerName: "کارمند", amount: "100", reason: "x" });
});

test("تصمیم: رد بی دلیل فرستادنی نیست؛ تأیید یادداشت اختیاری دارد", () => {
  assert.equal(decisionPayload("rejected", "  "), null);
  assert.deepEqual(decisionPayload("rejected", " خارج از سیاست "), { decision: "rejected", note: "خارج از سیاست" });
  assert.deepEqual(decisionPayload("approved", ""), { decision: "approved" });
  assert.deepEqual(decisionPayload("approved", "خوب"), { decision: "approved", note: "خوب" });
  assert.equal(decisionPayload("approved", "x".repeat(501)), null);
});

test("انتخاب تسویه همان شرط سرور است: فقط تأییدشده و نه پاداش خود", () => {
  const owner = { id: "u1", name: "x" };
  assert.equal(selectable({ status: "approved", owner }, "manager"), true);
  assert.equal(selectable({ status: "approved", owner }, "u1"), false, "پاداش خود");
  for (const status of ["pending", "rejected", "settled"] as const) assert.equal(selectable({ status, owner }, "manager"), false, status);
});

test("عملیات ماندگار: بدنه و کلید پس از بارگذاری دوباره همان است؛ بدنهٔ دیگر کلید تازه نمی‌سازد", () => {
  const cases: Array<[string, BonusBody]> = [
    ["request", { amount: "101", reason: "دقیق" }],
    ["award", { ownerId: ID, ownerName: "کارمند", amount: "101", reason: "دقیق" }],
    [`decide.${ID}`, { decision: "rejected", note: "دلیل" }],
    [`decide.${ID}`, { decision: "approved" }],
    ["settle", { items: [{ id: ID, amount: "999999999999999999", ownerName: "کارمند" }], note: "تسویه" }],
  ];
  for (const [target, body] of cases) {
    const storage = memory();
    const first = persistBonusOperation(storage, "manager", target, body, KEY);
    assert.deepEqual(parseBonusOperation(storage.getItem(bonusStorageKey("manager", target)), "manager", target), first);
    assert.deepEqual(persistBonusOperation(storage, "manager", target, body, "44444444-4444-4444-8444-444444444444"), first, "همان کلید");
    assert.throws(() => persistBonusOperation(storage, "manager", target, { ...body, note: "تغییر", amount: "5" } as never, KEY), /قبلی/);
    assert.throws(() => parseBonusOperation(storage.getItem(bonusStorageKey("manager", target)), "other", target), "کاربر دیگر");
    assert.equal(parseBonusOperation(storage.getItem(bonusStorageKey("other", target)), "other", target), null);
  }
});

test("دادهٔ خراب یا ناقص ثبت تازه را می‌بندد و پر بودن حافظه پیش از ارسال شکست می‌خورد", () => {
  assert.throws(() => parseBonusOperation("{}", "u", "request"));
  assert.throws(() => parseBonusOperation("broken", "u", "request"));
  const bad = (target: string, body: unknown) => JSON.stringify({ version: 1, userId: "u", target, key: KEY, body });
  assert.throws(() => parseBonusOperation(bad("request", { amount: "0", reason: "x" }), "u", "request"), "صفر");
  assert.throws(() => parseBonusOperation(bad(`decide.${ID}`, { decision: "rejected" }), "u", `decide.${ID}`), "رد بی دلیل");
  assert.throws(() => parseBonusOperation(bad("settle", { items: [{ id: ID, amount: "1", ownerName: "a" }, { id: ID, amount: "1", ownerName: "a" }], note: "x" }), "u", "settle"), "تکراری");
  assert.throws(() => parseBonusOperation(bad("award", { ownerId: "nope", ownerName: "a", amount: "1", reason: "x" }), "u", "award"));
  assert.throws(() => parseBonusOperation(bad("unknown", { amount: "1", reason: "x" }), "u", "unknown"));
  assert.throws(() => persistBonusOperation({ getItem: () => "broken", setItem: () => assert.fail("نباید بازنویسی شود") }, "u", "request", { amount: "1", reason: "x" }, KEY));
  assert.throws(() => persistBonusOperation({ getItem: () => null, setItem: () => { throw new Error("quota"); } }, "u", "request", { amount: "1", reason: "x" }, KEY), /quota/);
});
