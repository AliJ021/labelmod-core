import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { createDisposableDb } from "./helpers/disposable-db.ts";

test("افزودن گزینه ملی‌پیامک انتخاب سرویس و فعال‌بودن پیامک را تغییر نمی‌دهد", async () => {
  assert.ok(process.env.DATABASE_URL);
  const disposable = createDisposableDb(process.env.DATABASE_URL!);
  assert.ok(disposable);
  const db = new Client({ connectionString: disposable.ownerUrl });
  await db.connect();
  try {
    const values = async () => (await db.query(`SELECT key,value FROM platform.setting
      WHERE key IN ('notify.sms_provider','notify.sms_enabled','notify.sms_sender') ORDER BY key`)).rows;
    const before = await values();
    await db.query(`UPDATE platform.setting SET options=(SELECT jsonb_agg(item)
      FROM jsonb_array_elements(options) item WHERE item->>'value'<>'melipayamak')
      WHERE key='notify.sms_provider'`);
    const migration = await readFile(new URL("../../../db/migrations/071_melipayamak_option.sql", import.meta.url), "utf8");
    await db.query(migration);
    await db.query(migration);
    assert.deepEqual(await values(), before);
    const options = (await db.query("SELECT options FROM platform.setting WHERE key='notify.sms_provider'")).rows[0].options as { value: string }[];
    assert.equal(options.filter((o) => o.value === "melipayamak").length, 1);
    for (const value of ["log", "kavenegar", "smsir"]) assert.ok(options.some((o) => o.value === value));
  } finally { await db.end(); disposable.drop(); }
});
