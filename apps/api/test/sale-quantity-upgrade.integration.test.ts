/** Real106 ->107 upgrade through ops/db.sh; only disposable synthetic databases. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

test("107 upgrades fractional history unchanged; transactional rollback restores106 schema", { skip: !process.env.DATABASE_URL }, async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const stage = mkdtempSync(path.join(tmpdir(), "labelmod-quantity-upgrade-"));
  const name = `labelmod_qty_upgrade_${randomBytes(5).toString("hex")}`;
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL! }); await admin.connect();
  const target = new URL(process.env.DATABASE_URL!); target.pathname = `/${name}`;
  let client: pg.Client | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    for (const folder of ["db/migrations", "db/seed", "ops"]) mkdirSync(path.join(stage, folder), { recursive: true });
    cpSync(path.join(root, "ops/db.sh"), path.join(stage, "ops/db.sh"));
    cpSync(path.join(root, "db/seed"), path.join(stage, "db/seed"), { recursive: true });
    for (const file of readdirSync(path.join(root, "db/migrations")).filter(f => f.endsWith(".sql") && f < "107")) {
      cpSync(path.join(root, "db/migrations", file), path.join(stage, "db/migrations", file));
    }
    const run = (step: string) => execFileSync("bash", [path.join(stage, "ops/db.sh"), step], {
      cwd: stage, stdio: "pipe", env: { ...process.env, DATABASE_URL: target.toString(), PGCLIENTENCODING: "UTF8" },
    });
    run("migrate"); run("seed");
    client = new pg.Client({ connectionString: target.toString() }); await client.connect();
    const id = async (q: string, values: string[] = []) => (await client!.query(q, values)).rows[0].id as string;
    const actor = await id("INSERT INTO identity.app_user(username,full_name) VALUES ('quantity_upgrade','quantity upgrade') RETURNING id");
    await client.query("SELECT platform.set_actor($1)", [actor]);
    const product = await id("INSERT INTO catalog.product(code,name_internal) VALUES ('QU','quantity history') RETURNING id");
    const variation = await id("INSERT INTO catalog.variation(product_id,sku,color,size) VALUES ($1,'QU','blue','M') RETURNING id", [product]);
    const invoice = await id("INSERT INTO sales.invoice(branch_id,warehouse_id,created_by) VALUES ('00000000-0000-7000-8000-000000000001','00000000-0000-7000-8000-000000000101',$1) RETURNING id", [actor]);
    const line = await id("INSERT INTO sales.invoice_line(invoice_id,line_no,variation_id,qty,unit_price,net_amount) VALUES ($1,1,$2,1.125,1000000,1125000) RETURNING id", [invoice, variation]);
    await client.query("SELECT inventory.apply_movement($1,'00000000-0000-7000-8000-000000000101',2.125,'opening',NULL,NULL,$2,400000)", [variation, actor]);
    const fingerprint = async () => (await client!.query(`SELECT
      (SELECT md5(coalesce(string_agg(row_to_json(x)::text,'' ORDER BY id),'')) FROM sales.invoice_line x) lines,
      (SELECT md5(coalesce(string_agg(row_to_json(x)::text,'' ORDER BY id),'')) FROM inventory.stock_movement x) movements,
      (SELECT md5(coalesce(string_agg(row_to_json(x)::text,'' ORDER BY id),'')) FROM platform.audit_log x) audit,
      (SELECT md5(coalesce(string_agg(row_to_json(x)::text,'' ORDER BY id),'')) FROM ledger.journal_entry x) journals`)).rows[0];
    const before = await fingerprint();
    const migrationFile = path.join(root, "db/migrations/107_sales_quantity_policy.sql");
    const migration = readFileSync(migrationFile, "utf8").trim().replace(/^BEGIN;/, "").replace(/COMMIT;$/, "");
    await client.query("BEGIN"); await client.query(migration); await client.query("ROLLBACK");
    assert.equal((await client.query("SELECT to_regprocedure('sales.sale_quantity_guard()') f")).rows[0].f, null);
    assert.deepEqual(await fingerprint(), before, "rolled-back migration never modifies old financial rows");
    cpSync(migrationFile, path.join(stage, "db/migrations/107_sales_quantity_policy.sql")); run("migrate");
    assert.deepEqual(await fingerprint(), before, "upgrade preserves invoice, movement, audit and journal data byte-for-byte");
    assert.equal((await client.query("SELECT platform.setting_bool('sales.allow_fractional_qty',true) v")).rows[0].v, false);
    await client.query("UPDATE sales.invoice_line SET qty=qty,returned_qty=0 WHERE id=$1", [line]);
    assert.equal((await client.query("SELECT qty::text FROM sales.invoice_line WHERE id=$1", [line])).rows[0].qty, "1.125");
    await assert.rejects(client.query("UPDATE sales.invoice_line SET qty=1.25 WHERE id=$1", [line]), /عدد صحیح/);
    assert.equal((await client.query("SELECT on_hand::text FROM inventory.stock_balance WHERE variation_id=$1", [variation])).rows[0].on_hand, "2.125");
  } finally {
    await client?.end(); await admin.query(`DROP DATABASE IF EXISTS "${name}"`); await admin.end();
    assert.equal(path.dirname(path.resolve(stage)), path.resolve(tmpdir()));
    assert.ok(path.basename(stage).startsWith("labelmod-quantity-upgrade-"));
    rmSync(stage, { recursive: true, force: true }); // verified mkdtemp directory, never a user checkout
  }
});
