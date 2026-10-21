import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coreRows, coreVerdict, formatAge, topicLabel, wooRows, wooVerdict, type CoreToWoo, type WooCounts,
} from "../src/lib/stock-sync.ts";

const zero = { due: 0, scheduled: 0, retrying: 0, running: 0, leaseExpired: 0, deadExhausted: 0, deadRejected: 0 };
const core = (counts: Partial<CoreToWoo["counts"]>, extra: Partial<CoreToWoo> = {}): CoreToWoo => ({
  enabled: true, misconfigured: false, reconcileMinutes: 15, counts: { ...zero, ...counts },
  oldestOpenSeconds: null, lastSentAt: null, sample: { total: 0, items: [] }, ...extra,
});
const known = (counts: Partial<WooCounts>) => ({
  state: "known" as const, backend: "action-scheduler" as const, fetchedAt: "2026-09-16T08:00:00Z",
  counts: { due: 0, scheduled: 0, running: 0, deferred: 0, busy: 0, stoppedTasks: 0, failedRows: 0, ...counts },
});

test("Core → سایت: هر حالت یک سطر جدا با شمار خودش؛ هیچ دو حالتی جمع نمی‌شوند", () => {
  const rows = coreRows(core({ due: 1, scheduled: 2, running: 3, retrying: 4, leaseExpired: 5, deadExhausted: 6, deadRejected: 7 }));
  assert.deepEqual(rows.map(r => [r.key, r.count]), [
    ["due", 1], ["scheduled", 2], ["running", 3], ["retrying", 4], ["leaseExpired", 5], ["deadExhausted", 6], ["deadRejected", 7],
  ]);
  // اجارهٔ منقضی خرابی Worker است، نه توقف؛ متوقف‌ها شدیدترند.
  assert.equal(rows.find(r => r.key === "leaseExpired")?.tone, "warn");
  assert.equal(rows.find(r => r.key === "deadRejected")?.tone, "crit");
  assert.ok(rows.every(r => r.count !== null), "Core از پایگاه دادهٔ خودش دقیق است");
});

test("حکم Core → سایت: متوقف بر همه مقدم؛ خرابی Worker از تلاش دوباره جدا؛ خاموش «سالم» نیست", () => {
  assert.equal(coreVerdict(core({ deadRejected: 1, leaseExpired: 3 })).state, "attention");
  assert.match(coreVerdict(core({ deadExhausted: 2 })).label, /خودکار دوباره فرستاده نمی‌شود/);
  assert.equal(coreVerdict(core({}, { misconfigured: true })).state, "attention");
  assert.equal(coreVerdict(core({ leaseExpired: 1, retrying: 1 })).label, "Worker پیش از پایان کار ایستاده است");
  assert.equal(coreVerdict(core({ retrying: 1 })).state, "warning");
  const off = coreVerdict(core({}, { enabled: false }));
  assert.notEqual(off.state, "completed", "ارسال خاموش، صف خالیِ سالم گفته نمی‌شود");
  assert.equal(coreVerdict(core({ running: 1 })).state, "active");
  assert.equal(coreVerdict(core({})).state, "completed");
});

test("سایت → Core نامعلوم: حکم «نامعلوم» با دلیل، هرگز سبز", () => {
  const v = wooVerdict({ state: "unknown", code: "timeout", message: "سایت پاسخ نداد.", fetchedAt: "2026-09-16T08:00:00Z" });
  assert.equal(v.state, "unknown");
  assert.match(v.label, /سایت پاسخ نداد/);
});

test("شمارِ گزارش‌نشده «نامعلوم» است نه صفر — و تا یکی نامعلوم است حکم «سالم» نیست", () => {
  const partial = known({ due: null, scheduled: null, running: null });
  const rows = wooRows(partial.counts);
  assert.deepEqual(rows.filter(r => r.count === null).map(r => r.key), ["due", "scheduled", "running"]);
  assert.ok(rows.filter(r => r.count === null).every(r => r.tone === "neutral"));
  assert.equal(wooVerdict(partial).state, "unknown");
  assert.equal(wooVerdict(known({})).state, "completed", "کنترل مثبت: همه صفرِ گزارش‌شده یعنی صف خالی");
});

test("سایت → Core: متوقف فقط شکست غیرمنتظره است؛ سطر ناموفق Action Scheduler سطر است، نه کار", () => {
  const rows = wooRows(known({}).counts);
  assert.match(rows.find(r => r.key === "stoppedTasks")!.hint, /توقف تجاری/);
  assert.match(rows.find(r => r.key === "failedRows")!.label, /سطر/);
  assert.match(rows.find(r => r.key === "failedRows")!.hint, /نه شمار کارها/);
  assert.equal(wooVerdict(known({ stoppedTasks: 2, due: null })).state, "attention", "متوقف حتی با شمار نامعلوم دیگر دیده می‌شود");
  assert.equal(wooVerdict(known({ failedRows: 3 })).state, "warning");
  assert.equal(wooVerdict(known({ deferred: 1 })).state, "warning");
  assert.equal(wooVerdict(known({ due: 4 })).state, "active");
});

test("سن و موضوع: رقم فارسی، و کد خام موضوع به کاربر نمی‌رسد", () => {
  assert.equal(formatAge(30), "کمتر از یک دقیقه");
  assert.equal(formatAge(125), "۲ دقیقه");
  assert.equal(formatAge(2 * 3600 + 5), "۲ ساعت");
  assert.equal(formatAge(3 * 86400), "۳ روز");
  assert.equal(topicLabel("web.stock_push"), "موجودی");
  assert.equal(topicLabel("web.something_new"), "موضوع دیگر");
});
