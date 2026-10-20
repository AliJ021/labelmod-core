import { test } from "node:test";
import assert from "node:assert/strict";
import { ageText, dueIn, freshness, MAX_BACKOFF_MS, nextDelay, REFRESH_MS, STALE_MS } from "../src/lib/dashboard-freshness.ts";

test("Backoff: عادی هر دقیقه؛ پس از شکست نمایی و با سقف", () => {
  assert.equal(nextDelay(0), REFRESH_MS);
  assert.equal(nextDelay(1), 2 * REFRESH_MS);
  assert.equal(nextDelay(2), 4 * REFRESH_MS);
  assert.equal(nextDelay(5), MAX_BACKOFF_MS, "سقف");
  assert.equal(nextDelay(1000), MAX_BACKOFF_MS, "سرریز نمی‌کند");
  assert.equal(dueIn(1_000_000, null, 0), 0, "هنوز تلاشی نبوده: همین حالا");
  assert.equal(dueIn(1_000_000, 1_000_000 - 10_000, 0), REFRESH_MS - 10_000);
  assert.equal(dueIn(1_000_000, 1_000_000 - 5 * REFRESH_MS, 0), 0, "دیرشده منفی نمی‌شود");
});

test("حالت‌ها جدا می‌مانند و هیچ‌کدام سبز ساختگی نیست", () => {
  const now = 10_000_000;
  const base = { now, lastOk: now - 1000, online: true, refreshing: false, failure: null };
  assert.deepEqual(freshness({ ...base, lastOk: null }), { kind: "loading" });
  assert.deepEqual(freshness(base), { kind: "fresh", at: now - 1000 });
  assert.deepEqual(freshness({ ...base, lastOk: now - STALE_MS - 1 }), { kind: "stale", at: now - STALE_MS - 1 });
  assert.deepEqual(freshness({ ...base, refreshing: true }), { kind: "refreshing", at: now - 1000 });
  assert.deepEqual(freshness({ ...base, failure: { reference: "r-1" } }), { kind: "failed", at: now - 1000, reference: "r-1" });
  // قطعی بر هر چیز دیگر مقدم است: «در حال به‌روزرسانی» بی شبکه دروغ است.
  assert.equal(freshness({ ...base, online: false, refreshing: true, failure: { reference: null } }).kind, "offline");
  // شکست بر «تازه» مقدم است حتی وقتی داده هنوز جوان است.
  assert.equal(freshness({ ...base, failure: { reference: null } }).kind, "failed");
});

test("سن داده به دقیقه، با رقم فارسی", () => {
  const now = 50_000_000;
  assert.equal(ageText(now, now - 30_000), "همین حالا");
  assert.equal(ageText(now, now - 3 * 60_000), "۳ دقیقه پیش");
  assert.equal(ageText(now, now - 125 * 60_000), "۲ ساعت پیش");
  assert.equal(ageText(now, now + 5000), "همین حالا", "ساعت جلوتر منفی نمی‌دهد");
});
