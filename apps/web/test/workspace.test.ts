import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSearch, routeUrl } from "../src/lib/navigation.ts";
import { readPendingScan, writePendingScan, clearPendingScan, type PendingScan } from "../src/lib/pending-scan.ts";

test("Persian product input normalizes Arabic letters, both numeral sets and spacing", () => {
  assert.equal(normalizeSearch("  شلوار\u200cكتان ي ۱۲٣  "), "شلوار کتان ی 123");
  assert.equal(normalizeSearch("BC-۱۲۳"), "BC-123");
  assert.equal(routeUrl("settings", "pin"), "/?page=settings&settings.tab=pin");
});

test("uncertain scan survives reload with its exact operation key; users stay separate", () => {
  const data = new Map<string, string>();
  const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
  const intent: PendingScan = { actorId: "11111111-1111-4111-8111-111111111111", invoiceId: "33333333-3333-4333-8333-333333333333", shiftId: "44444444-4444-4444-8444-444444444444", key: "55555555-5555-4555-8555-555555555555", body: { barcode: "bc", qty: "1" } };
  writePendingScan(intent, store);
  assert.deepEqual(readPendingScan("11111111-1111-4111-8111-111111111111", store), intent);
  assert.equal(readPendingScan("22222222-2222-4222-8222-222222222222", store), null);
  assert.deepEqual(readPendingScan("11111111-1111-4111-8111-111111111111", store), intent);
  assert.throws(() => writePendingScan({...intent,key:"66666666-6666-4666-8666-666666666666"},store));
  assert.throws(() => clearPendingScan(intent.actorId,"66666666-6666-4666-8666-666666666666",store));
  assert.deepEqual(readPendingScan(intent.actorId,store),intent);
  clearPendingScan("11111111-1111-4111-8111-111111111111", intent.key, store);
  assert.equal(readPendingScan("11111111-1111-4111-8111-111111111111", store), null);
});

test("storage failure prevents dispatch rather than silently losing the operation", () => {
  const store = { getItem: () => "{broken", setItem: () => { throw new Error("full"); }, removeItem: () => {} };
  assert.throws(() => readPendingScan("11111111-1111-4111-8111-111111111111", store));
  assert.throws(() => writePendingScan({ actorId: "11111111-1111-4111-8111-111111111111", invoiceId: "33333333-3333-4333-8333-333333333333", shiftId: "44444444-4444-4444-8444-444444444444", key: "k", body: { qty: "1", barcode: "22222222-2222-4222-8222-222222222222" } }, {...store,getItem:()=>null}), /full/);
});

test("tampered pending scan cannot turn a retry into another endpoint or body", () => {
  for (const invoiceId of ["../../auth/logout", "invoice?x=1", {}, 1]) {
    const record = {actorId:"11111111-1111-4111-8111-111111111111",invoiceId,shiftId:"44444444-4444-4444-8444-444444444444",key:"55555555-5555-4555-8555-555555555555",body:{qty:"1",barcode:"123"}};
    const store={getItem:()=>JSON.stringify(record),setItem:()=>{},removeItem:()=>{throw new Error("must preserve");}};
    assert.throws(()=>readPendingScan(record.actorId,store));
  }
});
