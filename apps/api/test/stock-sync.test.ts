import { test } from "node:test";
import assert from "node:assert/strict";
import { wooQueueView } from "../src/platform/woocommerce-diagnostics.ts";
import { readWooToCore, resetTelemetryCache, TELEMETRY_TTL_MS } from "../src/platform/stock-sync.ts";
import type { testWooConnection } from "../src/platform/woocommerce-diagnostics.ts";

const full = { backend: "action-scheduler", group: "labelmod-critical", pendingDue: 2, pendingFuture: 1, running: 1,
  deadTasks: 0, deadScope: "unexpected_failure_only", deferredTasks: 3, busyTasks: 0, failedActions: 7,
  failedActionsScope: "action_scheduler_retained_rows" };

test("تله‌متری صف: نبودِ میدان «نامعلوم» است، نه صفر؛ قرارداد نامعتبر فقط همین بخش را نامعلوم می‌کند", () => {
  const absent = wooQueueView(undefined);
  assert.ok(absent.state === "unknown" && absent.code === "no_queue_telemetry" && !("counts" in absent));
  const known = wooQueueView(full);
  assert.deepEqual(known, { state: "known", backend: "action-scheduler", counts: {
    due: 2, scheduled: 1, running: 1, deferred: 3, busy: 0, stoppedTasks: 0, failedRows: 7 } });
  // افزونهٔ ۱٫۵٫۰ (PR183): بی شمار معلق/در حال اجرا — همان‌ها null، بقیه دقیق.
  const { pendingDue: _a, pendingFuture: _b, running: _c, ...older } = full;
  const partial = wooQueueView(older);
  assert.equal(partial.state, "known");
  if (partial.state === "known") {
    assert.deepEqual([partial.counts.due, partial.counts.scheduled, partial.counts.running], [null, null, null]);
    assert.equal(partial.counts.failedRows, 7);
  }
  // شمارش ناموفق در افزونه (null) نامعلوم می‌ماند.
  const failedCount = wooQueueView({ ...full, deadTasks: null });
  assert.ok(failedCount.state === "known" && failedCount.counts.stoppedTasks === null);
  for (const bad of [{ ...full, failedActions: -1 }, { ...full, deadScope: "all" }, { ...full, backend: "x" }, "queue", null, { ...full, failedActionsScope: "tasks" }]) {
    const v = wooQueueView(bad);
    assert.equal(v.state, "unknown");
    assert.equal(v.state === "unknown" && v.code, "invalid_queue_telemetry");
  }
});

const local = { siteUrl: "https://shop.example.test", secret: "s", warehouseId: "00000000-0000-7000-8000-000000000101", branchId: "00000000-0000-7000-8000-000000000001" };
const remote = (queue: unknown, scope: Partial<{ warehouseId: string; branchId: string }> = {}) => ({
  ok: true as const, code: "connected", message: "", remote: { protocol: 1 as const, pluginVersion: "1.5.0", wooVersion: "11.1.1",
    siteUrl: local.siteUrl, branchId: scope.branchId ?? local.branchId, warehouseId: scope.warehouseId ?? local.warehouseId,
    apiKeyConfigured: true, stockPolling: true, pricePolling: true, cronDisabled: false, stockScheduled: true,
    mapping: { linkedProducts: 1, orderIdentity: "sku" as const, stockIdentity: "variationId" as const }, order: null, queue } });

test("سایت → Core: شکست اتصال و ناهمخوانی دامنه «نامعلوم» با دلیل؛ کش ۳۰ ثانیه، نتیجهٔ شکست را هم نگه می‌دارد", async () => {
  resetTelemetryCache();
  let calls = 0, t = 1_000_000;
  const fail = (async () => { calls++; return { ok: false as const, code: "network", message: "اتصال کامل نشد", remote: null }; }) as unknown as typeof testWooConnection;
  const a = await readWooToCore(local, { test: fail, now: () => t });
  assert.deepEqual([a.state, a.state === "unknown" && a.code, calls], ["unknown", "network", 1]);
  t += TELEMETRY_TTL_MS - 1;
  await readWooToCore(local, { test: fail, now: () => t });
  assert.equal(calls, 1, "درون مهلت کش: درخواست بیرونی دوم نه");
  t += 2;
  const ok = (async () => { calls++; return remote(full); }) as unknown as typeof testWooConnection;
  const b = await readWooToCore(local, { test: ok, now: () => t });
  assert.deepEqual([b.state, calls], ["known", 2]);
  assert.equal(b.fetchedAt, new Date(t).toISOString());
  resetTelemetryCache();
  const other = (async () => remote(full, { warehouseId: "00000000-0000-7000-8000-0000000009ff" })) as unknown as typeof testWooConnection;
  const c = await readWooToCore(local, { test: other, now: () => t });
  assert.ok(c.state === "unknown" && c.code === "scope_mismatch");
  resetTelemetryCache();
  const old = (async () => remote(undefined)) as unknown as typeof testWooConnection;
  const d = await readWooToCore(local, { test: old, now: () => t });
  assert.ok(d.state === "unknown" && d.code === "no_queue_telemetry");
});
