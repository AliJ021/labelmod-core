import { test } from "node:test";
import assert from "node:assert/strict";
import { operationStorageKey, parseReturnOperation } from "../src/lib/return-operation.ts";

test("شناسه مرجوعی و تعویض پس از reload حفظ و به همان کاربر محدود می‌شود", () => {
  const operation = { key: "00000000-0000-4000-8000-000000000001", userId: "user-a", kind: "exchanges" };
  assert.deepEqual(parseReturnOperation(JSON.stringify(operation), "user-a"), operation);
  assert.notEqual(operationStorageKey("user-a"), operationStorageKey("user-b"));
  assert.throws(() => parseReturnOperation(JSON.stringify(operation), "user-b"));
});
test("داده خراب به نبود عملیات تبدیل نمی‌شود", () => {
  assert.equal(parseReturnOperation(null, "user-a"), null);
  for (const raw of ["", "{", "{}", "null", '{"key":"x","userId":"user-a","kind":"exchanges"}'])
    assert.throws(() => parseReturnOperation(raw, "user-a"));
});

test("بدنه نسخه‌دار بدون تغییر برای ادامه با همان کلید نگه داشته می‌شود", () => {
  const op = { key: "00000000-0000-4000-8000-000000000001", userId: "user-a", kind: "returns", version: 1,
    body: { invoiceId: "i1", confirmed: true, reasonCode: "quality", refundAmount: "100000000000000001",
      lines: [{ invoiceLineId: "l1", qty: "1" }] } };
  assert.deepEqual(parseReturnOperation(JSON.stringify(op), "user-a"), op);
  assert.throws(() => parseReturnOperation(JSON.stringify({ ...op, version: 2 }), "user-a"));
  assert.throws(() => parseReturnOperation(JSON.stringify({ ...op, body: {} }), "user-a"));
});
