import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const hook = readFileSync(path.join(repo, "ops/hooks/pre-push"), "utf8");
const line = 'const secret = "synthetic-fixture-value";';
const digest = createHash("sha256").update(`sample.ts\t${line}`).digest("hex");

function scan(eol: string, file = "sample.ts", text = line, allow = digest, allowEol = eol): number | null {
  // این مخزن کوچک فقط اسکن Hook را می‌سنجد؛ package.json و دیتابیس محصول ندارد.
  const dir = mkdtempSync(path.join(tmpdir(), "labelmod-secret-fixture-"));
  try {
    mkdirSync(path.join(dir, "ops/hooks"), { recursive: true });
    writeFileSync(path.join(dir, "ops/hooks/pre-push"), hook.replace(/\r\n/g, "\n"));
    writeFileSync(path.join(dir, "ops/secret-allowlist.txt"), allow + allowEol);
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text + eol);
    const env = { ...process.env, DATABASE_URL: "" };
    for (const args of [["init", "-q"], ["-c", "core.autocrlf=false", "add", "."],
      ["update-index", "--chmod=+x", "ops/hooks/pre-push"]]) {
      execFileSync("git", args, { cwd: dir, env, stdio: "pipe" });
    }
    const result = spawnSync("bash", ["ops/hooks/pre-push"], { cwd: dir, env, encoding: "utf8" });
    if (result.error) throw result.error;
    return result.status;
  } finally {
    assert.equal(realpathSync(path.dirname(dir)), realpathSync(tmpdir()));
    assert.ok(path.basename(dir).startsWith("labelmod-secret-fixture-"));
    rmSync(dir, { recursive: true, force: true });
  }
}

test("استثنای دقیق با LF پذیرفته می‌شود", () => assert.equal(scan("\n"), 0));
test("همان استثنا با CRLF ویندوز هم پذیرفته می‌شود", () => assert.equal(scan("\r\n"), 0));
test("فایل CRLF و فهرست LF همان استثنای دقیق‌اند", () => assert.equal(scan("\r\n", "sample.ts", line, digest, "\n"), 0));
test("فایل LF و فهرست CRLF همان استثنای دقیق‌اند", () => assert.equal(scan("\n", "sample.ts", line, digest, "\r\n"), 0));
test("CR داخل متن بخشی از هش است و آزاد نمی‌شود", () => assert.equal(scan("\n", "sample.ts", line.replace("fixture", "fix\rture")), 1));
test("انتقال همان متن به مسیر دیگر مجاز نمی‌شود", () => assert.equal(scan("\n", "other.ts"), 1));
test("مقدار تازه در همان مسیر مجاز نمی‌شود", () => assert.equal(scan("\n", "sample.ts", line.replace("fixture", "changed")), 1));
test("نبود استثنا شکست می‌دهد", () => assert.equal(scan("\n", "sample.ts", line, ""), 1));
test("خط تازه کنار خط مجاز همچنان شناسایی می‌شود", () => assert.equal(scan("\r\n", "sample.ts", line + '\r\nconst token = "another-synthetic-value";'), 1));

test("نمونهٔ ساختگی آزمون نشت راز با استثنای دقیق خودش مجاز است", () => {
  const file = "apps/api/test/secret-leak.integration.test.ts";
  const text = readFileSync(path.join(repo, file), "utf8").split(/\r?\n/)
    .find((row) => row.includes("totp_secret ="));
  assert.ok(text);
  const allow = readFileSync(path.join(repo, "ops/secret-allowlist.txt"), "utf8");
  assert.equal(scan("\n", file, text, allow), 0);
});
