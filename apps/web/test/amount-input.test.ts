import { test } from "node:test";
import assert from "node:assert/strict";
import { groupAmount, ungroupAmount, amountCaret } from "../src/lib/amount-input.ts";
import { rialFromTomanInput, rialFromExactTomanInput } from "../src/lib/money.ts";

test("grouping never changes a monetary value, including beyond Number precision", () => {
  for (const raw of ["0", "5000000", "۰۰۱۲۳۴۵۶۷", "99999999999999999"]) {
    assert.equal(rialFromTomanInput(groupAmount(raw)), rialFromTomanInput(raw));
  }
  assert.equal(groupAmount("5000000"), "5,000,000");
  assert.equal(groupAmount("۵۰۰۰۰۰۰"), "5,000,000");
  assert.equal(groupAmount(""), "");
  assert.equal(groupAmount("1234.5"), "1,234.5");
  assert.equal(groupAmount(".1234"), ".1234");
  assert.equal(groupAmount("1234.5678"), "1,234.5678");
  assert.equal(rialFromExactTomanInput(groupAmount("1234.5")), 12345n);
  assert.equal(groupAmount("1e6"), "1e6");
  assert.equal(rialFromTomanInput(groupAmount("1e6")), null);
});
test("caret tracks digits rather than comma positions", () => {
  assert.equal(amountCaret("5,000,000", 2), 3);
  assert.equal(amountCaret("5,000,000", 0), 0);
  assert.equal(ungroupAmount("۵٬۰۰۰,۰۰۰"), "5000000");
});
