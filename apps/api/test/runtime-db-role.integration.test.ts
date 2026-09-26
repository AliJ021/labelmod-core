import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { createServer } from "node:net";
import { sql } from "kysely";
import { createDb, type DbHandle } from "../src/db/client.ts";
import { createDisposableDb, type DisposableDb } from "./helpers/disposable-db.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const APP_PASSWORD = "runtime-role-fixture-only";

describe("نقش واقعی دیتابیس در startup تولید", { skip: DATABASE_URL ? false : "DATABASE_URL لازم است" }, () => {
  let disposable: DisposableDb;
  let owner: DbHandle;
  let appUrl: string;
  const role = `runtime_t_${randomBytes(6).toString("hex")}`;
  const group = `${role}_group`;
  const bridge = `${role}_bridge`;

  before(async () => {
    const made = createDisposableDb(DATABASE_URL!); assert.ok(made); disposable = made;
    owner = createDb(disposable.ownerUrl, 2);
    execFileSync("bash", [fileURLToPath(new URL("../../../ops/db-roles.sh", import.meta.url))], {
      cwd: ROOT, stdio: "pipe", env: { ...process.env, DATABASE_URL: disposable.ownerUrl, APP_ROLE: role, APP_PASSWORD },
    });
    const url = new URL(disposable.ownerUrl); url.username = role; url.password = APP_PASSWORD; appUrl = url.toString();
    await sql`CREATE ROLE ${sql.id(group)} NOLOGIN`.execute(owner.db);
    await sql`CREATE ROLE ${sql.id(bridge)} NOLOGIN`.execute(owner.db);
  });
  after(async () => {
    if (owner) {
      await sql`DROP OWNED BY ${sql.id(role)},${sql.id(group)},${sql.id(bridge)}`.execute(owner.db);
      await sql`DROP ROLE ${sql.id(role)},${sql.id(group)},${sql.id(bridge)}`.execute(owner.db);
      await owner.close();
    }
    disposable?.drop();
  });

  async function entrypoint(entry: "server" | "worker", url: string, shouldStart: boolean) {
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const address = reservation.address(); assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>((resolve, reject) => reservation.close(err => err ? reject(err) : resolve()));
    const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL(`../src/${entry}.ts`, import.meta.url))], {
      cwd: ROOT, env: { ...process.env, NODE_ENV: "production", DATABASE_URL: url,
        HOST: "127.0.0.1", PORT: String(port), LOG_LEVEL: "info", WORKER_INTERVAL_MS: "500", SMS_API_KEY: "", SMS_CREDENTIAL_KEY: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = ""; let closed = false; let exitCode: number | null = null;
    child.stdout.on("data", b => { output += String(b); }); child.stderr.on("data", b => { output += String(b); });
    const completion = new Promise<void>((resolve, reject) => {
      child.once("error", reject); child.once("close", code => { closed = true; exitCode = code; resolve(); });
    });
    try {
      let started = false;
      const deadline = Date.now() + 12000;
      while (!closed && Date.now() < deadline) {
        started = entry === "worker" ? output.includes("Worker لیبل مد بالا آمد")
          : await fetch(`http://127.0.0.1:${port}/health`).then(r => r.ok).catch(() => false);
        if (started) break;
        await pause(40);
      }
      assert.equal(started, shouldStart, "وضعیت startup باید با مجوز واقعی نقش منطبق باشد");
      if (shouldStart) {
        child.kill("SIGTERM");
        await Promise.race([completion, pause(6000)]);
        assert.ok(closed, "خاموشی باید کامل شود"); assert.equal(exitCode, 0);
      } else {
        assert.ok(closed, "نقش نامعتبر باید پیش از listen یا پردازش صف با خروج ناموفق رد شود");
        assert.notEqual(exitCode, 0);
        assert.match(output, /runtime_database_role_forbidden/);
        assert.ok(!output.includes(APP_PASSWORD));
        assert.ok(!output.includes(url));
      }
    } finally {
      if (!closed) child.kill("SIGKILL");
      await completion;
    }
  }

  for (const entry of ["server", "worker"] as const) {
    test(`${entry}: مالک رد می‌شود؛ نقش محدود ساخته‌شده با ابزار تولید مجاز است`, async () => {
      await entrypoint(entry, disposable.ownerUrl, false);
      await entrypoint(entry, appUrl, true);
    });
  }

  for (const capability of ["CREATEDB", "CREATEROLE", "BYPASSRLS", "REPLICATION"] as const) {
    test(`نقش غیرمالک با ${capability} هم برای runtime رد می‌شود`, async () => {
      await sql`ALTER ROLE ${sql.id(role)} ${sql.raw(capability)}`.execute(owner.db);
      try { await entrypoint("server", appUrl, false); }
      finally { await sql`ALTER ROLE ${sql.id(role)} ${sql.raw(`NO${capability}`)}`.execute(owner.db); }
    });
  }

  test("نقش اتصال اولیه، مالک session را پشت current_user محدود پنهان نمی‌کند", async () => {
    const url = new URL(disposable.ownerUrl); url.searchParams.set("options", `-c role=${role}`);
    for (const entry of ["server", "worker"] as const) await entrypoint(entry, url.toString(), false);
  });

  test("ترکیب SET سپس INHERIT نیز اختیار مالک محسوب می‌شود", async () => {
    await sql`CREATE SCHEMA runtime_bridge_owned AUTHORIZATION ${sql.id(group)}`.execute(owner.db);
    await sql`GRANT ${sql.id(group)} TO ${sql.id(bridge)} WITH INHERIT TRUE, SET FALSE`.execute(owner.db);
    await sql`GRANT ${sql.id(bridge)} TO ${sql.id(role)} WITH INHERIT FALSE, SET TRUE`.execute(owner.db);
    try {
      for (const entry of ["server", "worker"] as const) await entrypoint(entry, appUrl, false);
    } finally {
      await sql`REVOKE ${sql.id(bridge)} FROM ${sql.id(role)}`.execute(owner.db);
      await sql`REVOKE ${sql.id(group)} FROM ${sql.id(bridge)}`.execute(owner.db);
      await sql`DROP SCHEMA runtime_bridge_owned`.execute(owner.db);
    }
  });

  for (const object of ["TABLE", "FUNCTION"] as const) {
    test(`ابزار نقش، مالک ${object} را بدون تغییر رمز یا اختیارات رد می‌کند`, async () => {
      const target = object === "TABLE" ? "platform.runtime_provision_owned" : "platform.runtime_provision_owned()";
      await sql.raw(object === "TABLE" ? `CREATE TABLE ${target}(id int)`
        : `CREATE FUNCTION ${target} RETURNS int LANGUAGE sql AS 'SELECT 1'`).execute(owner.db);
      await sql.raw(`ALTER ${object} ${target} OWNER TO ${group}`).execute(owner.db);
      await sql`ALTER ROLE ${sql.id(group)} CREATEDB`.execute(owner.db);
      try {
        const snapshot = () => sql<{ rolpassword: string | null; rolcreatedb: boolean; rolcanlogin: boolean }>`
          SELECT rolpassword,rolcreatedb,rolcanlogin FROM pg_authid WHERE rolname=${group}`.execute(owner.db);
        const before = (await snapshot()).rows[0]!;
        const out = spawnSync("bash", [fileURLToPath(new URL("../../../ops/db-roles.sh", import.meta.url))], {
          cwd: ROOT, encoding: "utf8", env: { ...process.env, DATABASE_URL: disposable.ownerUrl, APP_ROLE: group, APP_PASSWORD },
        });
        const after = (await snapshot()).rows[0]!;
        assert.equal(out.status, 1); assert.match(out.stderr, /نقش مالک تغییر نکرد/);
        // رمز یا هش آن حتی هنگام شکست assertion نباید در گزارش چاپ شود.
        assert.ok(after.rolpassword === before.rolpassword, "رمز نقش مالک باید حفظ شود");
        assert.equal(after.rolcreatedb, before.rolcreatedb); assert.equal(after.rolcanlogin, before.rolcanlogin);
      } finally {
        await sql.raw(`DROP ${object} ${target}`).execute(owner.db);
        await sql`ALTER ROLE ${sql.id(group)} NOCREATEDB PASSWORD NULL`.execute(owner.db);
      }
    });
  }

  test("مالکیت اسکیما از طریق نقش گروهی هم قابل استفاده برای runtime نیست", async () => {
    await sql`CREATE SCHEMA pgx_runtime_owned AUTHORIZATION ${sql.id(group)}`.execute(owner.db);
    await sql`GRANT ${sql.id(group)} TO ${sql.id(role)}`.execute(owner.db);
    try { await entrypoint("worker", appUrl, false); }
    finally {
      await sql`REVOKE ${sql.id(group)} FROM ${sql.id(role)}`.execute(owner.db);
      await sql`DROP SCHEMA pgx_runtime_owned`.execute(owner.db);
    }
  });

  test("مالکیت جدول برنامه بدون مالکیت اسکیما نیز رد می‌شود", async () => {
    await sql`CREATE TABLE platform.runtime_owned_test(id int)`.execute(owner.db);
    await sql`ALTER TABLE platform.runtime_owned_test OWNER TO ${sql.id(role)}`.execute(owner.db);
    try { await entrypoint("server", appUrl, false); }
    finally { await sql`DROP TABLE platform.runtime_owned_test`.execute(owner.db); }
  });

  test("ابزار ساخت نقش، نام نقش مالک اسکیما را بدون تغییر اختیارات رد می‌کند", async () => {
    await sql`CREATE SCHEMA runtime_owner_guard AUTHORIZATION ${sql.id(group)}`.execute(owner.db);
    await sql`ALTER ROLE ${sql.id(group)} CREATEDB`.execute(owner.db);
    try {
      const out = spawnSync("bash", [fileURLToPath(new URL("../../../ops/db-roles.sh", import.meta.url))], {
        cwd: ROOT, encoding: "utf8", env: { ...process.env, DATABASE_URL: disposable.ownerUrl, APP_ROLE: group, APP_PASSWORD },
      });
      assert.equal(out.status, 1); assert.match(out.stderr, /نقش مالک تغییر نکرد/);
      const attributes = (await sql<{ rolcreatedb: boolean; rolcanlogin: boolean }>`
        SELECT rolcreatedb,rolcanlogin FROM pg_roles WHERE rolname=${group}`.execute(owner.db)).rows[0]!;
      assert.equal(attributes.rolcreatedb, true); assert.equal(attributes.rolcanlogin, false);
    } finally {
      await sql`DROP SCHEMA runtime_owner_guard`.execute(owner.db);
      await sql`ALTER ROLE ${sql.id(group)} NOCREATEDB`.execute(owner.db);
    }
  });

  test("مالکیت تابع برنامه نیز اختیار DDL است و رد می‌شود", async () => {
    await sql`CREATE FUNCTION platform.runtime_owned_test() RETURNS int LANGUAGE sql AS 'SELECT 1'`.execute(owner.db);
    await sql`ALTER FUNCTION platform.runtime_owned_test() OWNER TO ${sql.id(role)}`.execute(owner.db);
    try { await entrypoint("worker", appUrl, false); }
    finally { await sql`DROP FUNCTION platform.runtime_owned_test()`.execute(owner.db); }
  });

  test("مالک دیتابیس بدون SUPERUSER نیز رد می‌شود", async () => {
    const original = (await sql<{ name: string; owner: string }>`SELECT datname name,pg_get_userbyid(datdba) owner
      FROM pg_database WHERE datname=current_database()`.execute(owner.db)).rows[0]!;
    await sql`ALTER DATABASE ${sql.id(original.name)} OWNER TO ${sql.id(role)}`.execute(owner.db);
    try { await entrypoint("server", appUrl, false); }
    finally { await sql`ALTER DATABASE ${sql.id(original.name)} OWNER TO ${sql.id(original.owner)}`.execute(owner.db); }
  });

  test("عضویت بدون INHERIT ولی با SET ROLE اختیار مالک را پنهان نمی‌کند", async () => {
    await sql`CREATE SCHEMA runtime_set_owned AUTHORIZATION ${sql.id(group)}`.execute(owner.db);
    await sql`GRANT ${sql.id(group)} TO ${sql.id(role)} WITH INHERIT FALSE, SET TRUE`.execute(owner.db);
    try { await entrypoint("worker", appUrl, false); }
    finally {
      await sql`REVOKE ${sql.id(group)} FROM ${sql.id(role)}`.execute(owner.db);
      await sql`DROP SCHEMA runtime_set_owned`.execute(owner.db);
    }
  });

  test("عضویت کاملاً غیرفعال در نقش مالک، نقش محدود را بی‌دلیل رد نمی‌کند", async () => {
    await sql`CREATE SCHEMA runtime_disabled_owned AUTHORIZATION ${sql.id(group)}`.execute(owner.db);
    await sql`GRANT ${sql.id(group)} TO ${sql.id(role)} WITH INHERIT FALSE, SET FALSE, ADMIN FALSE`.execute(owner.db);
    try { await entrypoint("worker", appUrl, true); }
    finally {
      await sql`REVOKE ${sql.id(group)} FROM ${sql.id(role)}`.execute(owner.db);
      await sql`DROP SCHEMA runtime_disabled_owned`.execute(owner.db);
    }
  });
});
