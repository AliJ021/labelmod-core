import { test } from "node:test";
import assert from "node:assert/strict";
import { formatJalaliDay } from "../src/lib/format.ts";

// «مشتری از» یک لحظهٔ timestamptz است؛ فرمت روز نباید مثل formatJalali روی آن پرتاب کند
// (یک بار همین کل صفحهٔ مشتریان را از کار انداخت).
test("formatJalaliDay takes a timestamp and returns the Jalali day only", () => {
  const out = formatJalaliDay("2026-09-16T08:00:00.000Z");
  assert.match(out, /۱۴۰۵/);
  assert.doesNotMatch(out, /[:٫]|۰۸/);
});
test("formatJalaliDay never throws on bad input", () => {
  assert.equal(formatJalaliDay("not a date"), "—");
});
