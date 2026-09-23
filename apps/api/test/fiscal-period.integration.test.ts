import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { Client } from "pg";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";

const BR = "00000000-0000-7000-8000-000000000001";
let disposable: DisposableDb;
let owner: Client;
let actor: string;
before(async () => {
  assert.ok(process.env.DATABASE_URL, "آزمون سال مالی به PostgreSQL مستقل نیاز دارد");
  const db = createDisposableDb(process.env.DATABASE_URL!);
  assert.ok(db); disposable = db;
  owner = new Client({ connectionString: db.ownerUrl }); await owner.connect();
  actor = (await owner.query("INSERT INTO identity.app_user(username,full_name) VALUES('fiscal_guard_test','آزمون مستقل سال مالی') RETURNING id")).rows[0].id;
});
after(async () => { await owner?.end(); disposable?.drop(); });

async function clients() {
  const writer = new Client({ connectionString: disposable.url });
  const closer = new Client({ connectionString: disposable.ownerUrl });
  await Promise.all([writer.connect(), closer.connect()]);
  await writer.query("SELECT platform.set_actor($1::uuid)", [actor]);
  const writerPid = (await writer.query("SELECT pg_backend_pid() pid")).rows[0].pid as number;
  const closerPid = (await closer.query("SELECT pg_backend_pid() pid")).rows[0].pid as number;
  return { writer, closer, writerPid, closerPid };
}
async function post(writer: Client) {
  return writer.query(`SELECT ledger.post_entry('opening',$1::uuid,'2026-04-01','آزمون قفل سال مالی',
    '[{"leg":"cash","amount":"1000"},{"leg":"equity","amount":"1000"}]'::jsonb,NULL,NULL,$2::uuid) AS id`, [BR, actor]);
}
async function waitsFor(pid: number, blocker: number, finished: () => boolean) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !finished()) {
    const result = await owner.query("SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked", [pid, blocker]);
    if (result.rows[0].blocked) return true;
    await pause(20);
  }
  return false;
}

test("بستن سال که زودتر قفل گرفته است، ثبت هم‌زمان سند را رد می‌کند", async () => {
  const { writer, closer, writerPid, closerPid } = await clients();
  let pending: Promise<{ ok: boolean; code?: string }> | undefined;
  try {
    await closer.query("BEGIN");
    await closer.query("UPDATE ledger.fiscal_year SET status='closed' WHERE id=1405");
    let finished = false;
    pending = post(writer).then(() => ({ ok: true }), (e: { code: string }) => ({ ok: false, code: e.code }))
      .finally(() => { finished = true; });
    const blocked = await waitsFor(writerPid, closerPid, () => finished);
    await closer.query("COMMIT");
    const result = await pending;
    assert.equal(blocked, true, "ثبت سند باید منتظر قفل بستن سال بماند");
    assert.deepEqual(result, { ok: false, code: "P0001" });
    assert.equal((await owner.query("SELECT count(*)::int n FROM ledger.journal_entry")).rows[0].n, 0);
  } finally {
    await closer.query("ROLLBACK"); await pending;
    await Promise.all([writer.end(), closer.end()]);
    await owner.query("UPDATE ledger.fiscal_year SET status='open' WHERE id=1405");
  }
});

test("ثبت سند که زودتر قفل گرفته است، پیش از بسته‌شدن سال تمام می‌شود", async () => {
  const { writer, closer, writerPid, closerPid } = await clients();
  let pending: Promise<unknown> | undefined;
  try {
    await writer.query("BEGIN"); await writer.query("SELECT platform.set_actor($1::uuid)", [actor]);
    await post(writer);
    let finished = false;
    pending = closer.query("UPDATE ledger.fiscal_year SET status='closed' WHERE id=1405")
      .finally(() => { finished = true; });
    const blocked = await waitsFor(closerPid, writerPid, () => finished);
    // این آزمون شاهد مالی را به دفتر آزمون اضافه نمی‌کند؛ فقط ترتیب قفل سنجیده می‌شود.
    await writer.query("ROLLBACK"); await pending;
    assert.equal(blocked, true, "بستن سال باید تا پایان تراکنش سند منتظر بماند");
  } finally {
    await writer.query("ROLLBACK"); await pending;
    await Promise.all([writer.end(), closer.end()]);
    await owner.query("UPDATE ledger.fiscal_year SET status='open' WHERE id=1405");
  }
});
