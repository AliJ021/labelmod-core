import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWithdrawalOperation, persistWithdrawalOperation, withdrawalStorageKey } from "../src/lib/withdrawal-operation.ts";

test("reload keeps exact frozen create/correction body and key; user storage is isolated", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const key = "22222222-2222-4222-8222-222222222222";
  for (const [target, body] of [
    ["create", { amount: "101", reason: "exact" }],
    ["withdrawal-id", { expectedVersion: 1, amount: "1", reason: "exact", note: "correction" }],
  ] as const) {
    const initial = persistWithdrawalOperation(storage, "user-a", target, body, key);
    const reloaded = parseWithdrawalOperation(storage.getItem(withdrawalStorageKey("user-a", target)), "user-a", target);
    assert.deepEqual(reloaded, initial);
    assert.deepEqual(persistWithdrawalOperation(storage, "user-a", target, body, "33333333-3333-4333-8333-333333333333"), initial);
    assert.throws(() => persistWithdrawalOperation(storage, "user-a", target, { ...body, amount: "20" }, key));
    assert.equal(parseWithdrawalOperation(storage.getItem(withdrawalStorageKey("user-b", target)), "user-b", target), null);
    assert.throws(() => parseWithdrawalOperation(JSON.stringify(initial), "user-b", target));
  }
});

test("corrupt storage and quota failure block preparation instead of minting an untracked request", () => {
  assert.throws(() => parseWithdrawalOperation("{}", "user-a", "create"));
  assert.throws(() => persistWithdrawalOperation({ getItem: () => "broken", setItem: () => assert.fail("must not overwrite") },
    "user-a", "create", { amount: "10", reason: "x" }, "22222222-2222-4222-8222-222222222222"));
  assert.throws(() => persistWithdrawalOperation({ getItem: () => null, setItem: () => { throw new Error("quota"); } },
    "user-a", "create", { amount: "10", reason: "x" }, "22222222-2222-4222-8222-222222222222"), /quota/);
});

test("bulk settlement preserves selected versions and exact amounts across reload without minting another key", () => {
  let raw: string | null = null;
  const storage = { getItem: () => raw, setItem: (_: string,value:string) => { raw=value; } };
  const key="22222222-2222-4222-8222-222222222222";
  const body={items:[{id:"33333333-3333-4333-8333-333333333333",expectedVersion:2,amount:"999999999999999999",ownerName:"کارمند"}],note:"تسویه"};
  const first=persistWithdrawalOperation(storage,"manager","settle",body,key);
  assert.deepEqual(parseWithdrawalOperation(raw,"manager","settle"),first);
  assert.deepEqual(persistWithdrawalOperation(storage,"manager","settle",body,"44444444-4444-4444-8444-444444444444"),first);
  assert.throws(()=>persistWithdrawalOperation(storage,"manager","settle",{...body,note:"تغییر"},key));
  assert.throws(()=>parseWithdrawalOperation(raw,"other-manager","settle"));
  assert.throws(()=>parseWithdrawalOperation(JSON.stringify({...first,body:{...body,items:[...body.items,...body.items]}}),"manager","settle"));
});
