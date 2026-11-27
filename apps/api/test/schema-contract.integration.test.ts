import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {sql} from "kysely";
import {createDb} from "../src/db/client.ts";

test("all declared Kysely table and column names exist in PostgreSQL", {skip: !process.env.DATABASE_URL}, async () => {
  const source = await readFile(new URL("../src/db/types.ts", import.meta.url), "utf8");
  // The contract uses named interfaces with top-level fields. Reject any new, unsupported shape.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const definitions = new Map(Array.from(code.matchAll(/export interface (\w+) \{([\s\S]*?)^\}/gm),
    ([, name, body]) => [name!, body!]));
  const declarations = (name: string) => {
    const body = definitions.get(name);
    assert.ok(body, "Unknown declaration " + name);
    return body.split(";").map(field => field.trim()).filter(Boolean);
  };
  const handle = createDb(process.env.DATABASE_URL!, 1);
  try {
    const catalog = await sql<{table_name: string; column_name: string}>`
      SELECT table_schema || '.' || table_name AS table_name, column_name
      FROM information_schema.columns
      WHERE table_schema IN ('platform','identity','catalog','inventory','purchasing','sales','treasury','ledger')
    `.execute(handle.db);
    const existing = new Set(catalog.rows.map(row => row.table_name + "." + row.column_name));
    const missing: string[] = [];
    for (const entry of declarations("Database")) {
      const table = /^"([\w.]+)":\s*(\w+)$/.exec(entry);
      assert.ok(table, entry);
      for (const field of declarations(table[2]!)) {
        const match = /^(\w+):[\s\S]+$/.exec(field);
        assert.ok(match, field);
        const column = table[1] + "." + match[1];
        if (!existing.has(column)) missing.push(column);
      }
    }
    assert.deepEqual(missing, []);
  } finally {
    await handle.close();
  }
});
