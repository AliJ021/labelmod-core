/**
 * دفتر برداشت پرسنل — مهاجرت ۰۸۴.
 *
 * **فقط ثبت «مبلغ + دلیل»؛ هیچ اثری بر خزانه، دفتر، کشو، انبار یا حقوق.**
 * این فایل هیچ سرویس مالی‌ای را صدا نمی‌زند و نباید بزند (تصمیم مالک
 * ۱۴۰۵/۰۷/۱۰). اصلاح مدیر یک نسخهٔ تازه است، نه سند معکوس.
 *
 *   برداشت‌های من     GET  /withdrawals/mine · GET /withdrawals/mine/:id · POST /withdrawals
 *                     GET  /withdrawals/mine/by-key/:key (بررسی نتیجهٔ نامعلوم)
 *                     هر کاربر انسانی واردشده؛ مالک همیشه از نشست، نه از بدنه.
 *   دفتر مدیر کل       GET  /withdrawals · GET /withdrawals/:id   — withdrawal.view_all
 *                     POST /withdrawals/:id/corrections            — withdrawal.correct
 *                     هر دو نشست انسانی کامل (نه PIN، نه کلید API) و دامنهٔ شعبه.
 *
 * ⚠️ نگهبان‌های اصلی در دیتابیس‌اند (Trigger، مهاجرت ۰۸۴): مالک = عامل،
 *    ترتیب نسخه، مجوز، دامنهٔ شعبه و حسابرسی. اینجا همان
 *    شرط‌ها **پیش از** اثر سنجیده می‌شوند تا کاربر کد خطای دقیق بگیرد
 *    (مثلاً `withdrawal_stale` به‌جای پیام عمومی)، نه به‌جای دیتابیس.
 *
 * ⚠️ ثبتِ دیگری و ثبتِ بیرون از دامنه هر دو ۴۰۴ می‌گیرند، نه ۴۰۳: وجود
 *    یک ثبت هم نباید از راه کد وضعیت لو برود.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import { AuthError, type ResolvedSession } from "../auth/service.ts";
import { requireHumanSession } from "../auth/human-session.ts";
import { can, requireForSession } from "../auth/permission.ts";
import type { Db } from "../db/client.ts";
import type { Database } from "../db/types.ts";
import { runOnce, setActor } from "../lib/idempotency.ts";
import { CONTROL_CHARS, CONTROL_CHARS_MESSAGE } from "../lib/text.ts";

export class WithdrawalError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "WithdrawalError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

const uuid = z.string().uuid("شناسه نامعتبر");
const money = z.string().regex(/^\d+$/, "مبلغ باید رقم صحیح باشد (ریال، بدون اعشار)")
  .refine(v => v.length <= 18, { message: "مبلغ بزرگ‌تر از حد مجاز است" });
const text = z.string().trim().min(1, "نمی‌تواند خالی باشد").max(500, "حداکثر ۵۰۰ نویسه")
  .refine(v => !CONTROL_CHARS.test(v), { message: CONTROL_CHARS_MESSAGE });

const createBody = z.object({
  // Zod پس از شکست Regex هم refine را اجرا می‌کند؛ بی این نگهبان «12.5» به BigInt می‌رسید و ۵۰۰ می‌داد.
  amount: money.refine(v => !/^\d+$/.test(v) || BigInt(v) > 0n, { message: "مبلغ برداشت باید بیشتر از صفر باشد" }),
  reason: text,
}).strict();
const correctionBody = z.object({
  expectedVersion: z.number().int().min(1),
  amount: money,
  reason: text,
  note: text,
}).strict();
const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const managerQuery = pageQuery.extend({ ownerId: uuid.optional(), status: z.enum(["all", "open", "settled"]).default("all") });
const settlementBody = z.object({ items: z.array(z.object({ id: uuid, expectedVersion: z.number().int().min(1) }).strict()).min(1).max(500)
  .refine(items => new Set(items.map(i => i.id)).size === items.length, "ثبت تکراری در انتخاب وجود دارد"), note: text }).strict();

interface Row {
  id: string; ownerId: string; ownerName: string; createdAt: Date; version: number; amount: string;
  reason: string; correctedAt: Date | null; correctedByName: string | null; settledAt: Date | null; settledByName: string | null;
}
interface RevisionRow { version: number; amount: string; reason: string; note: string | null; actorId: string; actorName: string; at: Date; settledAt: Date | null; settledByName: string | null; settlementNote: string | null }

type Executor = Db | Transaction<Database>;

function staffSession(req: FastifyRequest): ResolvedSession {
  const s = req.session;
  if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
  // کلید API یک آدم نیست؛ کاربر پشتی‌اش هم غیرفعال است و Trigger ردش می‌کند.
  if ("apiClientId" in s) throw new WithdrawalError("staff_only", "دفتر برداشت فقط برای پرسنل واردشده است", 403);
  return s;
}

function idempotencyKey(req: { headers: Record<string, unknown> }): string {
  const raw = req.headers["idempotency-key"];
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) {
    throw new WithdrawalError("idempotency_key_required", "این درخواست بدون شناسهٔ عملیات پذیرفته نمی‌شود؛ صفحه را تازه کنید و دوباره بفرستید.", 400);
  }
  return raw;
}

function item(r: Row) {
  return {
    id: r.id, owner: { id: r.ownerId, name: r.ownerName }, createdAt: r.createdAt.toISOString(),
    version: r.version, amount: String(r.amount), reason: r.reason,
    correctedAt: r.correctedAt ? r.correctedAt.toISOString() : null, correctedBy: r.correctedByName,
    settledAt: r.settledAt?.toISOString() ?? null, settledBy: r.settledByName,
  };
}

const SELECT_CURRENT = sql`SELECT c.id, c.owner_id AS "ownerId", o.full_name AS "ownerName", c.created_at AS "createdAt",
    c.version, c.amount::text AS amount, c.reason, c.corrected_at AS "correctedAt", g.full_name AS "correctedByName", c.settled_at AS "settledAt", st.full_name AS "settledByName"
  FROM identity.staff_withdrawal_current c
  JOIN identity.app_user o ON o.id = c.owner_id
  LEFT JOIN identity.app_user g ON g.id = c.corrected_by
  LEFT JOIN identity.app_user st ON st.id = c.settled_by`;

async function detail(db: Executor, id: string) {
  const head = (await sql<Row>`${SELECT_CURRENT} WHERE c.id = ${id}::uuid`.execute(db)).rows[0];
  if (!head) throw new WithdrawalError("withdrawal_not_found", "ثبت برداشت یافت نشد", 404);
  const history = await sql<RevisionRow>`SELECT r.version, r.amount::text AS amount, r.reason, r.note,
      r.actor_id AS "actorId", u.full_name AS "actorName", r.at, st.at AS "settledAt", su.full_name AS "settledByName", st.note AS "settlementNote"
    FROM identity.staff_withdrawal_revision r JOIN identity.app_user u ON u.id = r.actor_id
    LEFT JOIN identity.staff_withdrawal_settlement st ON st.withdrawal_id=r.withdrawal_id AND st.version=r.version
    LEFT JOIN identity.app_user su ON su.id=st.actor_id
    WHERE r.withdrawal_id = ${id}::uuid ORDER BY r.version`.execute(db);
  return {
    ...item(head),
    history: history.rows.map(h => ({ version: h.version, amount: String(h.amount), reason: h.reason, note: h.note,
      actor: { id: h.actorId, name: h.actorName }, at: h.at.toISOString(), settledAt: h.settledAt?.toISOString() ?? null, settledBy: h.settledByName, settlementNote: h.settlementNote })),
  };
}

async function page(db: Db, where: ReturnType<typeof sql>, q: { page: number; pageSize: number }) {
  const rows = await sql<Row>`${SELECT_CURRENT} WHERE ${where}
    ORDER BY c.created_at DESC, c.id DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`.execute(db);
  const total = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM identity.staff_withdrawal_current c WHERE ${where}`.execute(db)).rows[0]?.n ?? 0;
  return { items: rows.rows.map(item), total, page: q.page, pageSize: q.pageSize };
}

/** دفتر مدیر: نشست انسانی کامل + مجوز اختصاصی. نام نقش هرگز سنجیده نمی‌شود. */
async function managerSession(db: Executor, req: FastifyRequest, operation: "withdrawal.view_all" | "withdrawal.correct") {
  const s = staffSession(req);
  await requireHumanSession(db, s);
  await requireForSession(db, s, operation);
  return s;
}

function managerWhere(userId: string, q: { ownerId?: string | undefined; status: string }) {
  return sql`identity.withdrawal_in_scope(${userId}::uuid,c.branch_id)
    AND (${q.ownerId ?? null}::uuid IS NULL OR c.owner_id=${q.ownerId ?? null}::uuid)
    AND (${q.status}='all' OR (${q.status}='open' AND c.settled_at IS NULL) OR (${q.status}='settled' AND c.settled_at IS NOT NULL))`;
}

async function settlementResult(db: Executor, batchId: string, actorId: string) {
  const rows = (await sql<{ id: string; version: number; amount: string; inScope: boolean }>`SELECT s.withdrawal_id AS id,s.version,r.amount::text AS amount,
    identity.withdrawal_in_scope(${actorId}::uuid,w.branch_id) AS "inScope"
    FROM identity.staff_withdrawal_settlement s JOIN identity.staff_withdrawal w ON w.id=s.withdrawal_id
    JOIN identity.staff_withdrawal_revision r ON r.withdrawal_id=s.withdrawal_id AND r.version=s.version
    WHERE s.batch_id=${batchId}::uuid ORDER BY s.withdrawal_id`.execute(db)).rows;
  if (!rows.length || rows.some(r => !r.inScope)) throw new WithdrawalError("withdrawal_not_found", "تسویه در دامنهٔ شما یافت نشد", 404);
  return { batchId, count: rows.length, totalAmount: rows.reduce((sum,r) => sum+BigInt(r.amount),0n).toString(),
    items: rows.map(r => ({ id:r.id, version:r.version })) };
}

export function registerWithdrawalRoutes(app: FastifyInstance, db: Db): void {
  // ── برداشت‌های من ────────────────────────────────────────────────
  app.get("/withdrawals/mine", async req => {
    const s = staffSession(req);
    return page(db, sql`c.owner_id = ${s.userId}::uuid`, pageQuery.parse(req.query));
  });

  app.get("/withdrawals/mine/:id", async req => {
    const s = staffSession(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const own = await sql`SELECT 1 FROM identity.staff_withdrawal WHERE id = ${id}::uuid AND owner_id = ${s.userId}::uuid`.execute(db);
    if (!own.rows.length) throw new WithdrawalError("withdrawal_not_found", "ثبت برداشت یافت نشد", 404);
    return detail(db, id);
  });

  /**
   * «آیا ثبتِ نامعلوم نشست؟» — فقط خواندن، با همان شناسهٔ عملیات (الگوی قصد
   * پرداخت F-115-01). «پیدا نشد» نهایی نیست؛ صفحه پس از آن با **همان** کلید
   * دوباره تأیید می‌کند و سرور Replay یا اجرای یکتا می‌دهد، نه ثبت دوم.
   */
  app.get("/withdrawals/mine/by-key/:key", async req => {
    const s = staffSession(req);
    const { key } = z.object({ key: z.string().min(1).max(200) }).parse(req.params);
    const row = (await sql<{ ref: string | null }>`SELECT result_ref AS ref FROM platform.inbox_message
      WHERE source = 'api.withdrawal.create' AND event_id = ${key} AND payload->>'ownerId' = ${s.userId}`.execute(db)).rows[0];
    return row?.ref ? { status: "recorded" as const, withdrawal: await detail(db, row.ref) } : { status: "not_found" as const };
  });

  app.post("/withdrawals", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const s = staffSession(req);
    const key = idempotencyKey(req);
    const body = createBody.parse(req.body);
    const out = await runOnce(db, {
      key, source: "api.withdrawal.create",
      // مالک بخشی از هویت درخواست است: کلید دیگری از کاربر دیگر Replay نمی‌شود.
      payload: { ownerId: s.userId, ...body },
      run: async trx => {
        await setActor(trx, s.userId);
        const id = (await sql<{ id: string }>`SELECT identity.record_withdrawal(${body.amount}::numeric, ${body.reason}) AS id`
          .execute(trx)).rows[0]!.id;
        return { value: await detail(trx, id), ref: id };
      },
      replay: ref => detail(db, ref),
    });
    return reply.code(out.replayed ? 200 : 201).send({ withdrawal: out.value, replayed: out.replayed });
  });

  // ── دفتر مدیر کل ────────────────────────────────────────────────
  app.get("/withdrawals", async req => {
    const s = await managerSession(db, req, "withdrawal.view_all");
    const q = managerQuery.parse(req.query);
    return page(db, managerWhere(s.userId, q), q);
  });

  app.get("/withdrawals/owners", async req => {
    const s = await managerSession(db, req, "withdrawal.view_all");
    const owners = await sql`SELECT DISTINCT o.id,o.full_name AS name FROM identity.staff_withdrawal w
      JOIN identity.app_user o ON o.id=w.owner_id WHERE identity.withdrawal_in_scope(${s.userId}::uuid,w.branch_id)
      ORDER BY name,o.id`.execute(db);
    return { owners: owners.rows };
  });

  // انتخاب همه، تصویر صریح نسخه‌هاست؛ ثبت تازه بعد از این خواندن وارد عملیات نمی‌شود.
  app.get("/withdrawals/selection", async req => {
    const s = await managerSession(db, req, "withdrawal.correct");
    const q = managerQuery.parse(req.query);
    const rows = await sql<Row>`${SELECT_CURRENT} WHERE ${managerWhere(s.userId, { ...q, status: "open" })}
      ORDER BY c.created_at DESC,c.id DESC LIMIT 501`.execute(db);
    if (rows.rows.length > 500) throw new WithdrawalError("withdrawal_selection_limit", "بیش از ۵۰۰ ثبت باز وجود دارد؛ کاربر را انتخاب کنید یا هر صفحه را جدا تسویه کنید.", 422);
    return { items: rows.rows.map(item) };
  });

  app.get("/withdrawals/settlements/by-key/:key", async req => {
    const s = await managerSession(db, req, "withdrawal.correct");
    const { key } = z.object({ key: z.string().min(1).max(200) }).parse(req.params);
    const row = (await sql<{ ref: string | null }>`SELECT result_ref AS ref FROM platform.inbox_message
      WHERE source='api.withdrawal.settle' AND event_id=${key} AND payload->>'actorId'=${s.userId}`.execute(db)).rows[0];
    return row?.ref ? { status: "recorded", ...await settlementResult(db, row.ref, s.userId) } : { status: "not_found" };
  });

  app.post("/withdrawals/settlements", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async req => {
    const s = await managerSession(db, req, "withdrawal.correct");
    const key = idempotencyKey(req);
    const parsed = settlementBody.parse(req.body);
    const body = { ...parsed, items: [...parsed.items].sort((a,b) => a.id.localeCompare(b.id)) };
    const out = await runOnce(db, { key, source: "api.withdrawal.settle", payload: { actorId: s.userId, ...body },
      run: async trx => {
        await managerSession(trx, req, "withdrawal.correct");
        await setActor(trx, s.userId);
        // ترتیب ثابت قفل‌ها برای دو انتخاب هم‌پوشان؛ همه یا هیچ.
        for (const selected of body.items) {
          const head = (await sql<{ inScope: boolean }>`SELECT identity.withdrawal_in_scope(${s.userId}::uuid,branch_id) AS "inScope"
            FROM identity.staff_withdrawal WHERE id=${selected.id}::uuid FOR UPDATE`.execute(trx)).rows[0];
          if (!head?.inScope) throw new WithdrawalError("withdrawal_not_found", "ثبت برداشت یافت نشد", 404);
          const cur = (await sql<{ version: number; settled: boolean }>`SELECT version,settled_at IS NOT NULL AS settled
            FROM identity.staff_withdrawal_current WHERE id=${selected.id}::uuid`.execute(trx)).rows[0]!;
          if (cur.version !== selected.expectedVersion || cur.settled) throw new WithdrawalError("withdrawal_stale", "بخشی از انتخاب تغییر کرده یا تسویه شده است؛ فهرست را تازه و دوباره انتخاب کنید.", 409);
        }
        const batchId = randomUUID();
        for (const selected of body.items) await sql`INSERT INTO identity.staff_withdrawal_settlement(withdrawal_id,version,batch_id,actor_id,note)
          VALUES (${selected.id}::uuid,${selected.expectedVersion},${batchId}::uuid,${s.userId}::uuid,${body.note})`.execute(trx);
        return { value: await settlementResult(trx,batchId,s.userId), ref: batchId };
      }, replay: ref => settlementResult(db,ref,s.userId),
    });
    return { ...out.value, replayed: out.replayed };
  });

  app.get("/withdrawals/:id", async req => {
    const s = await managerSession(db, req, "withdrawal.view_all");
    const { id } = z.object({ id: uuid }).parse(req.params);
    const scoped = await sql`SELECT 1 FROM identity.staff_withdrawal
      WHERE id = ${id}::uuid AND identity.withdrawal_in_scope(${s.userId}::uuid, branch_id)`.execute(db);
    if (!scoped.rows.length) throw new WithdrawalError("withdrawal_not_found", "ثبت برداشت یافت نشد", 404);
    const found = await detail(db, id);
    // فقط نمایش؛ دروازهٔ واقعی همان مسیر اصلاح و Trigger نسخه است.
    const verdict = await can(db, { userId: s.userId, operation: "withdrawal.correct", viaPin: s.pinUnlocked });
    return { ...found, canCorrect: verdict.verdict === "allow" };
  });

  app.post("/withdrawals/:id/corrections", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async req => {
    const s = staffSession(req);
    const key = idempotencyKey(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = correctionBody.parse(req.body);
    // پیش از Replay هم: کسی که مجوزش برداشته شده، پاسخ قبلی را هم نمی‌گیرد.
    await managerSession(db, req, "withdrawal.correct");
    const out = await runOnce(db, {
      key, source: "api.withdrawal.correct",
      payload: { actorId: s.userId, id, ...body },
      run: async trx => {
        await managerSession(trx, req, "withdrawal.correct");
        // قفل سرآیند تا پایان تراکنش: اصلاح هم‌زمانِ دوم پشت این صف می‌کشد و «قدیمی» می‌شود.
        const head = (await sql<{ ownerId: string; inScope: boolean }>`SELECT owner_id AS "ownerId",
            identity.withdrawal_in_scope(${s.userId}::uuid, branch_id) AS "inScope"
          FROM identity.staff_withdrawal WHERE id = ${id}::uuid FOR UPDATE`.execute(trx)).rows[0];
        if (!head?.inScope) throw new WithdrawalError("withdrawal_not_found", "ثبت برداشت یافت نشد", 404);
        const cur = (await sql<{ version: number; amount: string; reason: string }>`SELECT version, amount::text AS amount, reason
          FROM identity.staff_withdrawal_current WHERE id = ${id}::uuid`.execute(trx)).rows[0]!;
        if (cur.version !== body.expectedVersion) {
          throw new WithdrawalError("withdrawal_stale",
            `این ثبت در این فاصله تغییر کرده است (نسخهٔ جاری ${cur.version}). پیش از اصلاح، تاریخچهٔ تازه را ببینید.`, 409);
        }
        if (BigInt(cur.amount) === BigInt(body.amount) && cur.reason === body.reason) {
          throw new WithdrawalError("withdrawal_no_change", "اصلاح تغییری در مبلغ یا دلیل ندارد.", 422);
        }
        await setActor(trx, s.userId);
        const version = (await sql<{ v: number }>`SELECT identity.correct_withdrawal(${id}::uuid, ${body.expectedVersion}::int,
          ${body.amount}::numeric, ${body.reason}, ${body.note}) AS v`.execute(trx)).rows[0]!.v;
        return { value: { appliedVersion: version, withdrawal: await detail(trx, id) }, ref: `${id}:${version}` };
      },
      replay: async ref => {
        const scoped = await sql`SELECT 1 FROM identity.staff_withdrawal
          WHERE id = ${id}::uuid AND identity.withdrawal_in_scope(${s.userId}::uuid, branch_id)`.execute(db);
        if (!scoped.rows.length) throw new WithdrawalError("withdrawal_not_found", "ثبت برداشت یافت نشد", 404);
        return { appliedVersion: Number(ref.split(":")[1]), withdrawal: await detail(db, id) };
      },
    });
    return { ...out.value, replayed: out.replayed };
  });
}
