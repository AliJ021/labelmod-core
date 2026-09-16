import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

test("فونت‌ها و مجوزهای محلی با checksum منبع ثبت‌شده یکسان‌اند", () => {
  const base = new URL("../src/assets/fonts/", import.meta.url);
  const sources = JSON.parse(readFileSync(new URL("sources.json", base), "utf8")) as Array<{ name: string; sha256: string; bytes: number; url: string }>;
  assert.equal(sources.length, 7);
  for (const source of sources) {
    const bytes = readFileSync(new URL(source.name, base));
    assert.equal(bytes.length, source.bytes, source.name);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), source.sha256, source.name);
    assert.match(source.url, /^https:\/\/raw\.githubusercontent\.com\//);
  }
});
