import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { Client } from "pg";
import { sql } from "kysely";
import { createDb } from "../src/db/client.ts";
import { createDisposableDb } from "./helpers/disposable-db.ts";

const url = process.env.DATABASE_URL;
test("credit, prepaid funds and settlement serialize competing financial writes", {
  skip: url ? false : "DATABASE_URL is required", timeout: 180000,
}, async () => {
  const disposable = createDisposableDb(url!);
  assert.ok(disposable);
  const handle = createDb(disposable.url, 8);
  const gate = new Client({ connectionString: disposable.ownerUrl });
  const db = handle.db;
  const br = "00000000-0000-7000-8000-000000000001";
  const wh = "00000000-0000-7000-8000-000000000101";
  const actor = "00000000-0000-7000-8000-0000000000f1";
  let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await gate.connect();
    const customer = (await sql<{ id: string }>`INSERT INTO sales.customer(full_name,credit_limit)
      VALUES('Financial race',200000) RETURNING id`.execute(db)).rows[0]!.id;
    const product = (await sql<{ id: string }>`INSERT INTO catalog.product(code,name_internal)
      VALUES('RACE-FIN','Financial race') RETURNING id`.execute(db)).rows[0]!.id;
    const variation = (await sql<{ id: string }>`INSERT INTO catalog.variation(product_id,sku,color,size)
      VALUES(${product}::uuid,'RACE-FIN','black','M') RETURNING id`.execute(db)).rows[0]!.id;
    await sql`SELECT inventory.apply_movement(${variation}::uuid,${wh}::uuid,20,'opening',NULL,NULL,${actor}::uuid,100000)`.execute(db);
    async function invoice() {
      const id = (await sql<{ id: string }>`INSERT INTO sales.invoice(branch_id,warehouse_id,channel,customer_id,created_by)
        VALUES(${br}::uuid,${wh}::uuid,'web',${customer}::uuid,${actor}::uuid) RETURNING id`.execute(db)).rows[0]!.id;
      await sql`INSERT INTO sales.invoice_line(invoice_id,line_no,variation_id,qty,unit_price,net_amount)
        VALUES(${id}::uuid,1,${variation}::uuid,1,200000,200000)`.execute(db);
      return id;
    }
    async function collide(lock: string, id: string, actions: Array<() => Promise<unknown>>) {
      await gate.query("BEGIN");
      await gate.query(lock, [id]);
      pending = Promise.allSettled(actions.map(run => run()));
      let waiters = 0;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        await gate.query("SELECT pg_stat_clear_snapshot()");
        const result = await gate.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'`);
        waiters = result.rows[0]!.n;
        if (waiters >= 2) break;
        await pause(25);
      }
      await gate.query("COMMIT");
      const results = await pending;
      pending = undefined;
      assert.ok(waiters >= 2, "both operations must really reach the database lock barrier");
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
      assert.equal(results.filter(r => r.status === "rejected").length, 1);
      return results.find(r => r.status === "rejected") as PromiseRejectedResult;
    }
    const credits = [await invoice(), await invoice()];
    const creditFailure = await collide("SELECT id FROM sales.customer WHERE id=$1 FOR UPDATE", customer,
      credits.map(id => () => sql`SELECT sales.finalize_invoice(${id}::uuid,${actor}::uuid)`.execute(db)));
    assert.match(String(creditFailure.reason), /سقف اعتبار/);
    assert.equal((await sql<{ n: number }>`SELECT count(*)::int n FROM sales.invoice
      WHERE customer_id=${customer}::uuid AND status='finalized'`.execute(db)).rows[0]!.n, 1);

    await sql`SELECT ledger.post_entry('loyalty_grant',${br}::uuid,platform.business_date(),'Funded wallet',
      jsonb_build_array(jsonb_build_object('leg','expense','amount',200000),
      jsonb_build_object('leg','liability','amount',200000,'party_type','customer','party_id',${customer}::text)),
      'test',${customer}::uuid,${actor}::uuid)`.execute(db);
    const wallets = [await invoice(), await invoice()];
    const walletFailure = await collide("SELECT id FROM sales.customer WHERE id=$1 FOR UPDATE", customer,
      wallets.map(id => () => sql`INSERT INTO treasury.payment(invoice_id,method_code,amount)
        VALUES(${id}::uuid,'points',200000)`.execute(db)));
    assert.match(String(walletFailure.reason), /پشتوانه/);
    const spent = (await sql<{ amount: string }>`SELECT sum(p.amount)::text amount FROM treasury.payment p
      JOIN sales.invoice i ON i.id=p.invoice_id WHERE i.customer_id=${customer}::uuid AND p.method_code='points'`.execute(db)).rows[0]!;
    assert.equal(spent.amount, "200000");

    const account = (await sql<{ id: string }>`INSERT INTO treasury.account(code,name,kind,branch_id,ledger_account_code)
      VALUES('RACE-GW','Race gateway','gateway',${br}::uuid,'1104') RETURNING id`.execute(db)).rows[0]!.id;
    const settledInvoice = await invoice();
    await sql`INSERT INTO treasury.payment(invoice_id,method_code,account_id,amount)
      VALUES(${settledInvoice}::uuid,'gateway',${account}::uuid,200000)`.execute(db);
    await sql`SELECT sales.finalize_invoice(${settledInvoice}::uuid,${actor}::uuid)`.execute(db);
    const settlements: string[] = [];
    for (let n = 0; n < 2; n++) {
      settlements.push((await sql<{ id: string }>`INSERT INTO treasury.settlement(branch_id,source_account_id,bank_account_id,period_from,period_to)
        VALUES(${br}::uuid,${account}::uuid,'00000000-0000-7000-8000-000000000202',platform.business_date(),platform.business_date()) RETURNING id`.execute(db)).rows[0]!.id);
    }
    const settlementFailure = await collide("SELECT id FROM treasury.account WHERE id=$1 FOR UPDATE", account,
      settlements.map(id => () => sql`SELECT treasury.post_settlement(${id}::uuid,${actor}::uuid)`.execute(db)));
    assert.match(String(settlementFailure.reason), /هیچ پرداخت تسویه/);
    assert.equal((await sql<{ amount: string }>`SELECT sum(gross_amount)::text amount FROM treasury.settlement
      WHERE source_account_id=${account}::uuid AND status='posted'`.execute(db)).rows[0]!.amount, "200000");
  } finally {
    await gate.query("ROLLBACK").catch(() => {});
    await pending;
    await gate.end();
    await handle.close();
    disposable.drop();
  }
});
