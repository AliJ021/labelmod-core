import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { DbHandle } from "../src/db/client.ts";
import { drainDbOnClose } from "./helpers/drained-db.ts";

test("پایان pool به‌تنهایی کافی نیست؛ همهٔ اتصال‌ها باید واقعاً پایان یابند", async () => {
  const pool = new EventEmitter();
  let poolClosed = false;
  const handle = drainDbOnClose({ pool, close: async () => { poolClosed = true; } } as unknown as DbHandle);
  const clients = [new EventEmitter(), new EventEmitter()];
  for (const client of clients) pool.emit("connect", client);
  // اتصال اول پیش از teardown بسته شده؛ شنونده از زمان connect حاضر است.
  clients[0]!.emit("end");
  let drained = false;
  const closing = handle.close().then(() => { drained = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(poolClosed, true);
  assert.equal(drained, false, "بستن pool نباید اجازهٔ DROP زودهنگام بدهد");
  clients[1]!.emit("end");
  await closing;
  assert.equal(drained, true);
});

test("اتصال پایان‌نیافته مهلت محدود دارد و خطای close پنهان نمی‌شود", async () => {
  const pool = new EventEmitter();
  const handle = drainDbOnClose({ pool, close: async () => {} } as unknown as DbHandle, 20);
  pool.emit("connect", new EventEmitter());
  await assert.rejects(handle.close(), /در مهلت مقرر/);
  const failure = new Error("close failed");
  const broken = drainDbOnClose({ pool: new EventEmitter(), close: async () => { throw failure; } } as unknown as DbHandle);
  await assert.rejects(broken.close(), (error) => error === failure);
});
