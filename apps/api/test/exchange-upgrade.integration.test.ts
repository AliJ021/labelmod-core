import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import { createDb } from "../src/db/client.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const adminUrl = process.env.DATABASE_URL;

/** Reconstruct the exact 047a65e (083) seed without relying on Git history in shallow CI. */
function baselineSeed(name: string): string {
  let text = readFileSync(path.join(root, "db/seed", name), "utf8").replace(/\r\n/g, "\n");
  const expected: Record<string, string> = {
    "020_posting_rules.sql": "1164727ea5ec569d6cdf24c3e21c2f2de0a5f808",
    "030_settings.sql": "2ebae821952865c49aeaec30e0129efd9577f000",
    "040_reference.sql": "fe36c35115a9aea9ed5fab31ecead62cc97705b8",
  };
  if (name === "020_posting_rules.sql") {
    const at = text.indexOf("\nINSERT INTO ledger.posting_rule(event_type,leg,side,account_code,description)\nSELECT 'sale_return','exchange_clearing'");
    assert.ok(at > 0);
    text = text.slice(0, at) + "\nCOMMIT;\n";
  } else if (name === "030_settings.sql") {
    text = text.replace(',"exchange.policy"', "").replace(/^ {3}\{"value":"exchange.policy"[^\n]+\n/m, "");
  } else if (name === "040_reference.sql") {
    text = text.replace("INSERT INTO identity.permission_rule(role_code,operation,allowed)\nSELECT code,'exchange.policy',code='admin' FROM identity.role ON CONFLICT(role_code,operation) DO NOTHING;\n", "");
  }
  if (expected[name]) {
    const bytes = Buffer.from(text);
    const hash = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    assert.equal(hash, expected[name], `baseline seed must remain identical to main047: ${name}`);
  }
  return text;
}

test("existing 083 seeded database upgrades through 084/085/086 without bypassing setting guards", { skip: !adminUrl }, async () => {
  const name = `labelmod_upgrade_${randomBytes(6).toString("hex")}`;
  const role = `lmc_upgrade_${randomBytes(6).toString("hex")}`;
  const stage = mkdtempSync(path.join(tmpdir(), "labelmod-upgrade-"));
  const url = new URL(adminUrl!); url.pathname = `/${name}`;
  const env = { ...process.env, DATABASE_URL: url.toString(), PGCLIENTENCODING: "UTF8" };
  const psql = (connection: string, command: string) => execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-q", "-d", connection, "-c", command], { stdio: "pipe", env });
  const run = (directory: string, step: string) => execFileSync("bash", [path.join(directory, "ops/db.sh"), step], { cwd: directory, env, stdio: "pipe" });
  let owner: ReturnType<typeof createDb> | null = null;
  let restricted: ReturnType<typeof createDb> | null = null;
  try {
    mkdirSync(path.join(stage, "ops"));
    mkdirSync(path.join(stage, "db/migrations"), { recursive: true });
    mkdirSync(path.join(stage, "db/seed"));
    copyFileSync(path.join(root, "ops/db.sh"), path.join(stage, "ops/db.sh"));
    for (const file of readdirSync(path.join(root, "db/migrations"))) {
      if (parseInt(file, 10) <= 83) copyFileSync(path.join(root, "db/migrations", file), path.join(stage, "db/migrations", file));
    }
    for (const file of readdirSync(path.join(root, "db/seed"))) {
      if (parseInt(file, 10) < 84) writeFileSync(path.join(stage, "db/seed", file), baselineSeed(file));
    }
    psql(adminUrl!, `CREATE DATABASE "${name}"`);
    run(stage, "migrate"); run(stage, "seed");
    owner = createDb(url.toString(), 1);
    const before = (await sql<{ value: string[] }>`SELECT value FROM platform.setting WHERE key='auth.pin_forbidden_operations'`.execute(owner.db)).rows[0]!.value;
    assert.ok(!before.includes("exchange.policy"), "must exercise an existing old setting");
    // This is the exact failed production write, not an empty-table assertion.
    await assert.rejects(sql`UPDATE platform.setting SET value=value || '["exchange.policy"]'::jsonb WHERE key='auth.pin_forbidden_operations'`.execute(owner.db), /platform.set_setting/);
    const sentinel = (await sql<{ id: string }>`INSERT INTO identity.app_user(username,full_name) VALUES('upgrade_sentinel','دادهٔ موجود') RETURNING id`.execute(owner.db)).rows[0]!.id;
    const footprint = async () => (await sql<{ rows: string }>`SELECT concat_ws('|',
      (SELECT count(*) FROM ledger.journal_entry),(SELECT count(*) FROM ledger.journal_line),
      (SELECT count(*) FROM inventory.stock_movement),(SELECT count(*) FROM treasury.payment)) AS rows`.execute(owner!.db)).rows[0]!.rows;
    const oldFootprint = await footprint();
    // Simulate the interrupted deployment: 084 is already applied before retry.
    copyFileSync(path.join(root, "db/migrations/084_staff_withdrawal_register.sql"), path.join(stage, "db/migrations/084_staff_withdrawal_register.sql"));
    run(stage, "migrate");
    const applied084 = (await sql<{ checksum: string }>`SELECT checksum FROM public.schema_migration WHERE filename='084_staff_withdrawal_register.sql'`.execute(owner.db)).rows[0]!.checksum;
    run(root, "migrate");
    const result = (await sql<{ value: string[]; options: { value: string }[] }>`SELECT value,options FROM platform.setting WHERE key='auth.pin_forbidden_operations'`.execute(owner.db)).rows[0]!;
    assert.deepEqual(result.value, [...before, "exchange.policy"]);
    assert.equal(result.options.filter(o => o.value === "exchange.policy").length, 1);
    assert.equal((await sql<{ value: string }>`SELECT value FROM platform.setting WHERE key='exchange.debt_policy'`.execute(owner.db)).rows[0]!.value, "unset");
    assert.equal((await sql<{ n: number }>`SELECT count(*)::int n FROM identity.app_user WHERE id=${sentinel}::uuid AND full_name='دادهٔ موجود'`.execute(owner.db)).rows[0]!.n, 1);
    assert.equal(await footprint(), oldFootprint);
    assert.equal((await sql<{ checksum: string }>`SELECT checksum FROM public.schema_migration WHERE filename='084_staff_withdrawal_register.sql'`.execute(owner.db)).rows[0]!.checksum, applied084);
    const auditCount = async () => (await sql<{ n: number }>`SELECT count(*)::int n FROM platform.audit_log WHERE action='setting.change' AND entity_id='auth.pin_forbidden_operations'`.execute(owner!.db)).rows[0]!.n;
    const audited = await auditCount();
    assert.ok(audited > 0);
    run(root, "migrate");
    assert.equal(await auditCount(), audited, "rerunning migrations must not add another setting change");
    assert.equal((await sql<{ n: number }>`SELECT count(*)::int n FROM platform.audit_check`.execute(owner.db)).rows[0]!.n, 0);
    if (process.env.LMC_TEST_DB_ROLE === "app") {
      execFileSync("bash", [path.join(root, "ops/db-roles.sh")], { cwd: root, env: { ...env, APP_ROLE: role, APP_PASSWORD: "upgrade-fixture-only" }, stdio: "pipe" });
      const appUrl = new URL(url); appUrl.username = role; appUrl.password = "upgrade-fixture-only";
      restricted = createDb(appUrl.toString(), 1);
    }
    const db = restricted?.db ?? owner.db;
    await assert.rejects(sql`UPDATE platform.setting SET value='[]'::jsonb WHERE key='auth.pin_forbidden_operations'`.execute(db), /platform.set_setting/);
    const allocation = (await sql<{ collect_amount: string }>`SELECT collect_amount::text FROM sales.exchange_allocation(100,120,0,100,'debt_first')`.execute(db)).rows[0]!;
    assert.equal(allocation.collect_amount, "20");
  } finally {
    await restricted?.close(); await owner?.close();
    psql(adminUrl!, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    psql(adminUrl!, `DROP ROLE IF EXISTS "${role}"`);
    assert.equal(path.dirname(stage), path.resolve(tmpdir()));
    assert.ok(path.basename(stage).startsWith("labelmod-upgrade-"));
    rmSync(stage, { recursive: true, force: true });
  }
});
