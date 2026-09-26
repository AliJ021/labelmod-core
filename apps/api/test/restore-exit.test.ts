import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../../../ops/restore-drill.sh", import.meta.url)), "utf8");
const bashPath = (value: string) => value.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);

test("موفقیت بازیابی هم به pg_restore و هم به ادعاهای داده وابسته است", () => {
  // تمام برنامه‌های PostgreSQL بدل‌اند؛ هیچ اتصال پایگاه داده‌ای برقرار نمی‌شود.
  const root = mkdtempSync(path.join(tmpdir(), "labelmod-restore-status-"));
  try {
    mkdirSync(path.join(root, "ops"));
    mkdirSync(path.join(root, "bin"));
    writeFileSync(path.join(root, "ops/restore-drill.sh"), source.replace(/\r\n/g, "\n"));
    writeFileSync(path.join(root, "copy.dump"), "controlled fixture");
    writeFileSync(path.join(root, "bin/pg_restore"), '#!/usr/bin/env bash\necho "first restore error" >&2\nexit "$RESTORE_RESULT"\n', { mode: 0o755 });
    writeFileSync(path.join(root, "bin/psql"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CALLS"
case "$*" in
  *"-c "*)
    case "$*" in
      *"count(*)"*"information_schema.tables"*|*"count(*) FROM ledger.account"*|*"count(*) FROM ledger.posting_rule"*|*"count(*) FROM platform.setting"*|*"count(*) FROM pg_proc"*) echo 100 ;;
      *"count(*)"*) echo "$ASSERT_RESULT" ;;
    esac ;;
  *) cat >> "$CALLS" ;;
esac
`, { mode: 0o755 });
    for (const [restore, assertion, ok] of [[0, 0, true], [1, 0, false], [0, 1, false]] as const) {
      const calls = path.join(root, "calls.txt");
      writeFileSync(calls, "");
      const result = spawnSync("bash", ["-c", 'export PATH="$1/bin:$PATH"; bash ops/restore-drill.sh copy.dump', "test", bashPath(root)], {
        cwd: root, encoding: "utf8", env: { ...process.env, DATABASE_URL: "postgresql://unused/fixture",
          RESTORE_RESULT: String(restore), ASSERT_RESULT: String(assertion), CALLS: bashPath(calls) },
      });
      if (result.error) throw result.error;
      assert.equal(result.status, ok ? 0 : 1, result.stdout + result.stderr);
      const trace = readFileSync(calls, "utf8");
      assert.match(trace, new RegExp(`drill_ok=${ok}`));
      assert.match(trace, /DROP DATABASE IF EXISTS/);
      assert.match(trace, /:'drill_note'/, "نام فایل باید به‌صورت مقدار SQL نقل‌قول شود");
      if (restore !== 0) assert.match(result.stdout, /first restore error/);
    }
  } finally {
    assert.equal(path.dirname(root), tmpdir());
    assert.ok(path.basename(root).startsWith("labelmod-restore-status-"));
    rmSync(root, { recursive: true, force: true });
  }
});
