import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { Client } from "pg";
import { sql } from "kysely";
import { createDb } from "../src/db/client.ts";
import { createDisposableDb } from "./helpers/disposable-db.ts";
import { runImport, type ImportResult } from "../src/import/run.ts";

const url = process.env.DATABASE_URL;
const BR = "00000000-0000-7000-8000-000000000001";
const WH = "00000000-0000-7000-8000-000000000101";
const ACTOR = "00000000-0000-7000-8000-0000000000f1";

test("دو واردات هم‌زمان موجودی افتتاحیه را فقط یک بار اعمال می‌کنند", {
  skip: url ? false : "DATABASE_URL موجود نیست؛ آزمون اجرا نشده است",
  timeout: 90000,
}, async () => {
  const disposable = createDisposableDb(url!);
  assert.ok(disposable, "دیتابیس یک‌بارمصرف لازم است");
  const handle = createDb(disposable.url, 6);
  // ⚠️ دروازهٔ تصادم با نقش **مالک** وصل می‌شود، نه با نقش برنامه.
  // این اتصال یک بازیگر بیرونی است که عمداً قفل نگه می‌دارد تا واردات
  // دوم پشتش بماند؛ کدِ تحت آزمون نیست. و `SELECT … FOR UPDATE` در
  // پستگرس حق UPDATE می‌خواهد، که نقش برنامه روی `stock_balance`
  // ندارد (ops/db-roles.sh) — پس با آن نقش، خودِ **داربست** می‌شکست،
  // نه چیزی که سنجیده می‌شود.
  const gate = new Client({ connectionString: disposable.ownerUrl });
  let pending: Promise<PromiseSettledResult<ImportResult>[]> | undefined;
  try {
    const db = handle.db;
    const p = await sql<{id: string}>`INSERT INTO catalog.product(code,name_internal)
      VALUES('IMPORT-RACE','کالای مصنوعی') RETURNING id`.execute(db);
    const v = await sql<{id: string}>`INSERT INTO catalog.variation(product_id,sku,color,size)
      VALUES(${p.rows[0]!.id},'IMPORT-RACE','آبی','M') RETURNING id`.execute(db);
    const id = v.rows[0]!.id;
    await sql`SELECT inventory.apply_movement(${id}::uuid,${WH}::uuid,1,
      'purchase_receipt',NULL,NULL,${ACTOR}::uuid,1000)`.execute(db);
    await gate.connect();
    await gate.query("BEGIN");
    await gate.query("SELECT 1 FROM inventory.stock_balance WHERE variation_id=$1 AND warehouse_id=$2 FOR UPDATE", [id, WH]);
    const input = {
      files: { "products.csv": "sku,name\nIMPORT-RACE,کالای مصنوعی\n",
        "opening-stock.csv": "sku,qty,unit_cost\nIMPORT-RACE,5,1000\n" },
      branchId: BR, warehouseId: WH, fiscalYear: 1405, actorId: ACTOR, commit: true,
    };
    pending = Promise.allSettled([runImport(db, input), runImport(db, input)]);

    // دو تراکنش واقعاً شروع شده‌اند و روی قفل موجودی یا قفل واردات منتظرند.
    // توقف کوتاه فقط برای مشاهده آمار است؛ شاهد هم‌زمانی، وضعیت خود PostgreSQL است.
    let waiters = 0;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await gate.query("SELECT pg_stat_clear_snapshot()");
      const r = await gate.query<{n: number}>(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'
          AND (query LIKE '%SELECT inventory.apply_movement(%'
            OR query LIKE '%SELECT pg_advisory_xact_lock(%')`);
      waiters = r.rows[0]!.n;
      if (waiters === 2) break;
      await pause(25);
    }
    assert.equal(waiters, 2, "هر دو واردات باید به مانع واقعی رسیده باشند");
    await gate.query("COMMIT");
    const results = await pending;
    for (const result of results) {
      assert.equal(result.status, "fulfilled");
      if (result.status === "fulfilled") {
        assert.deepEqual(result.value.errors, []);
        assert.equal(result.value.committed, true);
      }
    }
    const movements = await sql<{n: number; qty: string}>`SELECT count(*)::int AS n,
      sum(qty)::text AS qty FROM inventory.stock_movement
      WHERE variation_id=${id}::uuid AND kind='opening'`.execute(db);
    assert.deepEqual(movements.rows, [{ n: 1, qty: "5.000" }]);
    const balance = await sql<{qty: string; value: string}>`SELECT on_hand::text AS qty,
      total_value::text AS value FROM inventory.stock_balance
      WHERE variation_id=${id}::uuid AND warehouse_id=${WH}::uuid`.execute(db);
    assert.deepEqual(balance.rows, [{ qty: "6.000", value: "6000" }]);
    const equity = await sql<{amount: string}>`SELECT sum(credit-debit)::text AS amount
      FROM ledger.journal_line WHERE account_code='3102'`.execute(db);
    assert.equal(equity.rows[0]!.amount, "5000", "افتتاحیه نباید در دفتر دو برابر شود");
  } finally {
    await gate.query("ROLLBACK").catch(() => {});
    await pending;
    await gate.end();
    await handle.close();
    disposable.drop();
  }
});
