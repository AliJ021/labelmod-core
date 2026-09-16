import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import { createDb } from "../src/db/client.ts";
import { hashSecret } from "../src/auth/password.ts";
import { createDisposableDb } from "./helpers/disposable-db.ts";

test("production request logs omit bearer URLs and queries while retaining correlation and outcome", {
  skip: process.env["DATABASE_URL"] ? false : "DATABASE_URL is required",
  timeout: 90_000,
}, async () => {
  const disposable = createDisposableDb(process.env["DATABASE_URL"]!);
  assert.ok(disposable, "a real disposable PostgreSQL database is required");
  const handle = createDb(disposable.url, 3);
  const branch = "00000000-0000-7000-8000-000000000001";
  const warehouse = "00000000-0000-7000-8000-000000000101";
  const actor = "00000000-0000-7000-8000-0000000000f1";
  const loginValue = randomBytes(24).toString("base64url");
  const privateQuery = randomBytes(24).toString("base64url");
  // مقدارِ ستونی که خطای پستگرس در `detail` خودش می‌گذارد.
  const errorValue = `audit-${randomBytes(12).toString("hex")}`;
  try {
    const passwordHash = await hashSecret(loginValue);
    await sql`INSERT INTO identity.app_user(username,full_name,password_hash)
      VALUES ('request_log_admin','کاربر آزمون لاگ',${passwordHash})`.execute(handle.db);
    const p = await sql<{ id: string }>`INSERT INTO catalog.product(code,name_internal)
      VALUES ('REQUEST-LOG','کالای آزمون لاگ') RETURNING id`.execute(handle.db);
    const v = await sql<{ id: string }>`INSERT INTO catalog.variation(product_id,sku,color,size)
      VALUES (${p.rows[0]!.id}::uuid,'REQUEST-LOG-M','آبی','M') RETURNING id`.execute(handle.db);
    await sql`SELECT inventory.apply_movement(${v.rows[0]!.id}::uuid,${warehouse}::uuid,5,'purchase_receipt','test_receipt', '00000000-0000-7000-8000-00000000fa11'::uuid,${actor}::uuid,1000)`.execute(handle.db);
    const inv = await sql<{ id: string }>`INSERT INTO sales.invoice(branch_id,warehouse_id,channel,created_by)
      VALUES (${branch}::uuid,${warehouse}::uuid,'web',${actor}::uuid) RETURNING id`.execute(handle.db);
    const id = inv.rows[0]!.id;
    await sql`INSERT INTO sales.invoice_line(invoice_id,line_no,variation_id,qty,unit_price,net_amount)
      VALUES (${id}::uuid,1,${v.rows[0]!.id}::uuid,1,2000,2000)`.execute(handle.db);
    await sql`INSERT INTO treasury.payment(invoice_id,method_code,amount,ref_no)
      VALUES (${id}::uuid,'gateway',2000,'SYNTHETIC-REQUEST-LOG')`.execute(handle.db);
    await sql`SELECT sales.finalize_invoice(${id}::uuid,${actor}::uuid)`.execute(handle.db);
    const result = await sql<{ token: string }>`SELECT sales.ensure_public_token(${id}::uuid) AS token`.execute(handle.db);
    const token = result.rows[0]!.token;
    const child = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./helpers/request-log-child.ts", import.meta.url))], {
      env: { ...process.env, DATABASE_URL: disposable.url, AUDIT_PUBLIC_TOKEN: token, AUDIT_PRIVATE_QUERY: privateQuery, AUDIT_LOGIN_VALUE: loginValue, AUDIT_ERROR_VALUE: errorValue },
      encoding: "utf8", timeout: 30_000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, "all real HTTP cases in the child must succeed");
    // Inspect the entire output, but never include capability values in assertion diagnostics.
    const output = child.stdout + child.stderr;
    assert.equal(output.includes(token), false, "invoice bearer capability leaked");
    assert.equal(output.includes(privateQuery), false, "private query value leaked");
    assert.equal(output.includes(loginValue), false, "login credential leaked");
    const logs = child.stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
    assert.deepEqual(logs.find((l) => l.auditCase)?.statuses, [200, 200, 200, 403, 404]);
    const incoming = logs.filter((l) => l.msg === "incoming request");
    assert.equal(incoming.length, 5);
    assert.deepEqual(incoming.map((l) => l.req.url), ["/i/:token", "/health", "/auth/login", "/auth/2fa/totp/begin", "/auth/2fa/totp/confirm", "/auth/me", "/auth/logout", "[unmatched]"]);
    for (const entry of incoming) {
      assert.ok(entry.reqId);
      assert.ok(logs.some((l) => l.reqId === entry.reqId && l.msg === "request completed" && Number.isInteger(l.res?.statusCode)));
    }
    // ── مسیر خطا: مقدار ستون نباید بیرون برود، تشخیص باید بماند ────
    // ⚠️ `detail` خطای پستگرس مقدار ستون متعارض را حمل می‌کند
    // («Key (username)=(…) already exists»). سریالایزر `err` فهرست
    // مجاز دارد، پس خصیصه تازه‌ای که فردا یک درایور اضافه کند هم
    // خودبه‌خود بیرون می‌ماند.
    assert.equal(output.includes(errorValue), false, "مقدار ستون از راه detail خطا بیرون رفت");
    const failure = logs.find((l) => l.msg === "خطای پیش‌بینی‌نشده");
    assert.ok(failure, "لاگ خطای پیش‌بینی‌نشده باید نوشته شود");
    assert.equal(failure.err.code, "23505", "کد خطا باید بماند");
    assert.ok(failure.err.constraint, "نام قید باید بماند — وگرنه ریشه‌یابی ممکن نیست");
    assert.ok(failure.err.stack, "Stack باید بماند");
    assert.equal(failure.err.detail, undefined, "detail نباید در لاگ باشد");
    assert.equal(failure.correlationId, "audit-error-path", "ردیابی نباید کشته شود");

    const csrf = logs.find((l) => l.msg === "توکن CSRF نامعتبر");
    assert.equal(csrf?.path, "/auth/logout");
    assert.equal(csrf?.correlationId, incoming[3].reqId);
  } finally {
    await handle.close();
    disposable.drop();
  }
});
