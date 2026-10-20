/**
 * کارت عملیاتی همگام‌سازی سایت (داشبورد، دستهٔ C) — فقط‌خواندنی.
 *
 * دو جهت جدا می‌مانند و هیچ‌کدام «نامعلوم» را صفر یا سبز نشان نمی‌دهد:
 *
 *   Core → سایت   صف Outbox موضوع‌های `web.*` (موجودی، قیمت، خرید حضوری) — از همین پایگاه داده، دقیق.
 *   سایت → Core   صف بحرانی افزونه (سفارش، مرجوعی، رزرو) — از تله‌متری امضاشدهٔ `/lmc/v1/diagnostics`
 *                 (HMAC + nonce، اتصال پین‌شده)؛ هر شکست اتصال یا نبود قرارداد = «نامعلوم» با دلیل.
 *
 * حالت‌های Core → سایت از تعریف خودِ صف می‌آیند (`claim_outbox`/`fail_outbox`، ۰۳۱):
 *   due          pending، بی تلاش قبلی، سررسیده
 *   scheduled    pending، بی تلاش قبلی، هنوز نه
 *   retrying     pending با تلاش قبلی (Backoff)
 *   running      sending با اجارهٔ معتبر
 *   leaseExpired sending با اجارهٔ گذشته — Worker پیش از پایان ایستاده (خرابی، نه تصمیم)؛ دوباره برداشته می‌شود
 *   deadExhausted / deadRejected   متوقف: تلاش‌ها تمام شد / رد قطعی (موضوع ناشناخته)
 */
import { sql } from "kysely";
import type { Db } from "../db/client.ts";
import { testWooConnection, wooQueueView, type WooQueueView } from "./woocommerce-diagnostics.ts";

export interface CoreToWoo {
  counts: { due: number; scheduled: number; retrying: number; running: number; leaseExpired: number; deadExhausted: number; deadRejected: number };
  oldestOpenSeconds: number | null;
  lastSentAt: string | null;
  sample: { total: number; items: { id: string; topic: string; state: "retrying" | "leaseExpired" | "deadExhausted" | "deadRejected"; attempts: number; ageSeconds: number; hasError: boolean }[] };
}

/** نمونهٔ پیام‌های مشکل‌دار: سقف صریح، و «نمونه N از کل» در پاسخ — نه فهرست کامل. */
export const SAMPLE_LIMIT = 5;

export async function readCoreToWoo(db: Db): Promise<CoreToWoo> {
  const c = await sql<Record<string, string | null>>`
    WITH s AS (SELECT platform.setting_int('notify.max_attempts', 8) AS max_attempts)
    SELECT
      count(*) FILTER (WHERE m.status = 'pending' AND m.attempts = 0 AND m.next_attempt_at <= now())::text AS due,
      count(*) FILTER (WHERE m.status = 'pending' AND m.attempts = 0 AND m.next_attempt_at > now())::text  AS scheduled,
      count(*) FILTER (WHERE m.status = 'pending' AND m.attempts > 0)::text                               AS retrying,
      count(*) FILTER (WHERE m.status = 'sending' AND m.next_attempt_at > now())::text                    AS running,
      count(*) FILTER (WHERE m.status = 'sending' AND m.next_attempt_at <= now())::text                   AS lease_expired,
      count(*) FILTER (WHERE m.status = 'dead' AND m.attempts >= s.max_attempts)::text                    AS dead_exhausted,
      count(*) FILTER (WHERE m.status = 'dead' AND m.attempts < s.max_attempts)::text                     AS dead_rejected,
      floor(extract(epoch FROM now() - min(m.created_at) FILTER (WHERE m.status IN ('pending', 'sending'))))::text AS oldest_open
      FROM platform.outbox_message m CROSS JOIN s
     WHERE m.topic LIKE 'web.%' AND m.status IN ('pending', 'sending', 'dead')`.execute(db);
  const r = c.rows[0]!;
  const n = (k: string) => Number(r[k] ?? 0);
  // آخرین ارسال موفق: پیمایش معکوس کلید اصلی تا اولین پیام سایتِ فرستاده‌شده، نه پیمایش کل تاریخچه.
  const last = await sql<{ sent_at: Date | null }>`
    SELECT sent_at FROM platform.outbox_message
     WHERE topic LIKE 'web.%' AND status = 'sent' ORDER BY id DESC LIMIT 1`.execute(db);
  const sample = await sql<{ id: string; topic: string; state: string; attempts: number; age: string; has_error: boolean }>`
    WITH s AS (SELECT platform.setting_int('notify.max_attempts', 8) AS max_attempts)
    SELECT m.id::text, m.topic, m.attempts,
           CASE WHEN m.status = 'pending' THEN 'retrying'
                WHEN m.status = 'sending' THEN 'leaseExpired'
                WHEN m.attempts >= s.max_attempts THEN 'deadExhausted' ELSE 'deadRejected' END AS state,
           floor(extract(epoch FROM now() - m.created_at))::text AS age,
           m.last_error IS NOT NULL AS has_error
      FROM platform.outbox_message m CROSS JOIN s
     WHERE m.topic LIKE 'web.%'
       AND ((m.status = 'pending' AND m.attempts > 0) OR (m.status = 'sending' AND m.next_attempt_at <= now()) OR m.status = 'dead')
     ORDER BY m.created_at, m.id
     LIMIT ${SAMPLE_LIMIT}`.execute(db);
  const counts = {
    due: n("due"), scheduled: n("scheduled"), retrying: n("retrying"), running: n("running"),
    leaseExpired: n("lease_expired"), deadExhausted: n("dead_exhausted"), deadRejected: n("dead_rejected"),
  };
  return {
    counts,
    oldestOpenSeconds: r.oldest_open === null || r.oldest_open === undefined ? null : Number(r.oldest_open),
    lastSentAt: last.rows[0]?.sent_at ? last.rows[0].sent_at.toISOString() : null,
    sample: {
      total: counts.retrying + counts.leaseExpired + counts.deadExhausted + counts.deadRejected,
      items: sample.rows.map(x => ({ id: x.id, topic: x.topic, state: x.state as CoreToWoo["sample"]["items"][number]["state"],
        attempts: x.attempts, ageSeconds: Number(x.age), hasError: x.has_error })),
    },
  };
}

export type WooToCore = (WooQueueView & { fetchedAt: string })
  | { state: "unknown"; code: string; message: string; fetchedAt: string };

/**
 * تله‌متری سایت با کش کوتاه: به‌روزرسانی خودکار هر دقیقهٔ هر داشبورد بازِ مدیر نباید سایت را بکوبد.
 * کش به نشانی سایت کلید می‌خورد و نتیجهٔ شکست را هم نگه می‌دارد (همان دلیل). `fetchedAt` می‌گوید از کی است.
 */
export const TELEMETRY_TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: WooToCore }>();

export async function readWooToCore(
  local: { siteUrl: string; secret: string | undefined; warehouseId: string; branchId: string },
  deps: { test?: typeof testWooConnection; now?: () => number } = {},
): Promise<WooToCore> {
  const now = (deps.now ?? Date.now)();
  const key = `${local.siteUrl}|${local.warehouseId}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < TELEMETRY_TTL_MS) return hit.value;
  const fetchedAt = new Date(now).toISOString();
  const result = await (deps.test ?? testWooConnection)({ siteUrl: local.siteUrl, secret: local.secret });
  let value: WooToCore;
  if (!result.ok || !result.remote) {
    value = { state: "unknown", code: result.code, message: result.message, fetchedAt };
  } else if (result.remote.warehouseId !== local.warehouseId || result.remote.branchId !== local.branchId) {
    value = { state: "unknown", code: "scope_mismatch", message: "شعبه یا انبار افزونه با انبار سایت در Core یکسان نیست.", fetchedAt };
  } else {
    value = { ...wooQueueView(result.remote.queue), fetchedAt };
  }
  cache.set(key, { at: now, value });
  return value;
}

/** فقط برای آزمون. */
export function resetTelemetryCache(): void {
  cache.clear();
}
