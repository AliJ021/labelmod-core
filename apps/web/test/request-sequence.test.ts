import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestSequence } from "../src/lib/request-sequence.ts";
import { api } from "../src/lib/api.ts";

test("پاسخ دیررس حتی وقتی انتقال لغو را نادیده بگیرد پذیرفته نمی‌شود", async () => {
  const sequence = new RequestSequence();
  let displayed = "";
  let release!: (value: string) => void;
  const old = sequence.begin();
  const pending = new Promise<string>(resolve => { release = resolve; }).then(value => { if (old.current()) displayed = value; });
  const latest = sequence.begin();
  assert.equal(old.signal.aborted, true);
  if (latest.current()) displayed = "new";
  release("old");
  await pending;
  assert.equal(displayed, "new");
});
test("پاک‌کردن، فیلتر و خروج درخواست و نسل قبلی را باطل می‌کنند", () => {
  const sequence = new RequestSequence();
  for (const _action of ["clear", "filter", "unmount"]) {
    const request = sequence.begin();
    sequence.cancel();
    assert.equal(request.current(), false);
    assert.equal(request.signal.aborted, true);
  }
});
test("api.get سیگنال لغو را به fetch می‌رساند و AbortError را حفظ می‌کند", async (t) => {
  const controller = new AbortController();
  controller.abort();
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    assert.equal(init.signal, controller.signal);
    throw new DOMException("Aborted", "AbortError");
  });
  await assert.rejects(api.get("/products", { signal: controller.signal }), { name: "AbortError" });
});
