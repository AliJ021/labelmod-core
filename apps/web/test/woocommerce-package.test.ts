import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { packagePlugin } from "../../../integrations/woocommerce/package.ts";

test("بستهٔ افزونه در دو ساخت بایت‌به‌بایت یکسان و دارای نسخه و SHA256 صحیح است", async () => {
  const dir = await mkdtemp(join(tmpdir(), "woo-package-"));
  try {
    const first = await packagePlugin(join(dir, "a"));
    const second = await packagePlugin(join(dir, "b"));
    assert.deepEqual(first, second);
    const zip = await readFile(join(dir, "a", first.filename));
    assert.deepEqual(zip, await readFile(join(dir, "b", second.filename)));
    assert.equal(createHash("sha256").update(zip).digest("hex"), first.sha256);
    assert.equal(zip.length, first.bytes);
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
    assert.ok(zip.includes(Buffer.from("labelmod-connector/includes/class-lmc-diagnostics.php")));
    assert.ok(zip.includes(Buffer.from(`define('LMC_VERSION', '${first.version}');`)));
    assert.ok(!zip.includes(Buffer.from("payload-test.php")));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
