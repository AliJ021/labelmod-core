/**
 * دفتر پاداش پرسنل — مهاجرت ۰۹۸.
 *
 * **فقط ثبت «مبلغ + دلیل» و وضعیت؛ هیچ اثری بر دفتر، خزانه، کشو، انبار،
 * حقوق یا پرداخت.** این فایل هیچ سرویس مالی‌ای را صدا نمی‌زند و نباید بزند
 * (خواستهٔ مالک، مثل دفتر برداشت). «تسویه» فقط وضعیت دفتر است.
 *
 *   پاداش‌های من    GET  /bonuses/mine · GET /bonuses/mine/:id · POST /bonuses (درخواست)
 *                   GET  /bonuses/mine/by-key/:key (بررسی نتیجهٔ نامعلوم)
 *                   هر کاربر انسانی واردشده؛ ذی‌نفع همیشه از نشست، نه از بدنه.
 *   دفتر مدیر       GET  /bonuses · /bonuses/owners · /bonuses/:id            — bonus.view_all
 *                   GET  /bonuses/beneficiaries · /bonuses/selection          — bonus.manage
 *                   POST /bonuses/awards · /bonuses/:id/decisions · /bonuses/settlements
 *                   GET  /bonuses/{awards,decisions,settlements}/by-key/:key
 *                   همه نشست انسانی کامل (نه PIN، نه کلید API) و دامنهٔ شعبه.
 *
 * ⚠️ نگهبان‌های اصلی در دیتابیس‌اند (Trigger، مهاجرت ۰۹۸): عامل، ذی‌نفع،
 *    مجوز، دامنه، منع بررسی/اعطا/تسویهٔ خود، وضعیت و حسابرسی. اینجا همان
 *    شرط‌ها **پیش از** اثر سنجیده می‌شوند تا کاربر کد خطای دقیق بگیرد
 *    (`bonus_stale`، `bonus_self`)، نه به‌جای دیتابیس.
 *
 * ⚠️ پاداش دیگری و پاداش بیرون از دامنه هر دو ۴۰۴ می‌گیرند، نه ۴۰۳.
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

export class BonusError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "BonusError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

const STATUSES = ["pending", "approved", "rejected", "settled"] as const;
type Status = typeof STATUSES[number];

const uuid = z.string().uuid("شناسه نامعتبر");
const text = z.string().trim().min(1, "نمی‌تواند خالی باشد").max(500, "حداکثر ۵۰۰ نویسه")
  .refine(v => !CONTROL_CHARS.test(v), { message: CONTROL_CHARS_MESSAGE });
// Zod پس از شکست Regex هم refine را اجرا می‌کند؛ نگهبان دوم «12.5» را از BigInt دور نگه می‌دارد.
const amount = z.string().regex(/^\d+$/, "مبلغ باید رقم صحیح باشد (ریال، بدون اعشار)")
  .refine(v => v.length <= 18, { message: "مبلغ بزرگ‌تر از حد مجاز است" })
  .refine(v => !/^\d+$/.test(v) || BigInt(v) > 0n, { message: "مبلغ پاداش باید بیشتر از صفر باشد" });

const requestBody = z.object({ amount, reason: text }).strict();
const awardBody = z.object({ ownerId: uuid, amount, reason: text }).strict();
const decisionBody = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approved"), note: text.optional() }).strict(),
  z.object({ decision: z.literal("rejected"), note: text }).strict(),
]);
const settlementBody = z.object({
  items: z.array(uuid).min(1).max(500).refine(ids => new Set(ids).size === ids.length, "پاداش تکراری در انتخاب وجود دارد"),
  note: text,
}).strict();
const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
const managerQuery = pageQuery.extend({ ownerId: uuid.optional(), status: z.enum(["all", ...STATUSES]).default("all") });

interface Row {
  id: string; ownerId: string; ownerName: string; origin: "request" | "award"; amount: string; reason: string;
  createdAt: Date; createdByName: string; status: Status; decidedAt: Date | null; decidedByName: string | null;
  decisionNote: string | null; settledAt: Date | null; settledByName: string | null; settlementNote: string | null;
}

type Executor = Db | Transaction<Database>;

function staffSession(req: FastifyRequest): ResolvedSession {
  const s = req.session;
  if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
  if ("apiClientId" in s) throw new BonusError("staff_only", "دفتر پاداش فقط برای پرسنل واردشده است", 403);
  return s;
}

function idempotencyKey(req: { headers: Record<string, unknown> }): string {
  const raw = req.headers["idempotency-key"];
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) {
    throw new BonusError("idempotency_key_required", "این درخواست بدون شناسهٔ عملیات پذیرفته نمی‌شود؛ صفحه را تازه کنید و دوباره بفرستید.", 400);
  }
  return raw;
}

const notFound = () => new BonusError("bonus_not_found", "پاداش یافت نشد", 404);

function item(r: Row) {
  return {
    id: r.id, owner: { id: r.ownerId, name: r.ownerName }, origin: r.origin, amount: String(r.amount), reason: r.reason,
    createdAt: r.createdAt.toISOString(), createdBy: r.createdByName, status: r.status,
    decidedAt: r.decidedAt?.toISOString() ?? null, decidedBy: r.decidedByName, decisionNote: r.decisionNote,
    settledAt: r.settledAt?.toISOString() ?? null, settledBy: r.settledByName, settlementNote: r.settlementNote,
  };
}

const SELECT_CURRENT = sql`SELECT c.id, c.owner_id AS "ownerId", o.full_name AS "ownerName", c.origin,
    c.amount::text AS amount, c.reason, c.created_at AS "createdAt", cb.full_name AS "createdByName", c.status,
    c.decided_at AS "decidedAt", d.full_name AS "decidedByName", c.decision_note AS "decisionNote",
    c.settled_at AS "settledAt", st.full_name AS "settledByName", c.settlement_note AS "settlementNote"
  FROM identity.staff_bonus_current c
  JOIN identity.app_user o ON o.id = c.owner_id
  JOIN identity.app_user cb ON cb.id = c.created_by
  LEFT JOIN identity.app_user d ON d.id = c.decided_by
  LEFT JOIN identity.app_user st ON st.id = c.settled_by`;

async function detail(db: Executor, id: string) {
  const row = (await sql<Row>`${SELECT_CURRENT} WHERE c.id = ${id}::uuid`.execute(db)).rows[0];
  if (!row) throw notFound();
  return item(row);
}

async function page(db: Db, where: ReturnType<typeof sql>, q: { page: number; pageSize: number }) {
  const rows = await sql<Row>`${SELECT_CURRENT} WHERE ${where}
    ORDER BY c.created_at DESC, c.id DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`.execute(db);
  const total = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM identity.staff_bonus_current c WHERE ${where}`.execute(db)).rows[0]?.n ?? 0;
  return { items: rows.rows.map(item), total, page: q.page, pageSize: q.pageSize };
}

/** دفتر مدیر: نشست انسانی کامل + مجوز اختصاصی. نام نقش هرگز سنجیده نمی‌شود. */
async function managerSession(db: Executor, req: FastifyRequest, operation: "bonus.view_all" | "bonus.manage") {
  const s = staffSession(req);
  await requireHumanSession(db, s);
  await requireForSession(db, s, operation);
  return s;
}

function managerWhere(userId: string, q: { ownerId?: string | undefined; status: string }) {
  return sql`identity.withdrawal_in_scope(${userId}::uuid, c.branch_id)
    AND (${q.ownerId ?? null}::uuid IS NULL OR c.owner_id = ${q.ownerId ?? null}::uuid)
    AND (${q.status} = 'all' OR c.status = ${q.status})`;
}

async function inScope(db: Executor, id: string, userId: string): Promise<boolean> {
  return (await sql`SELECT 1 FROM identity.staff_bonus
    WHERE id = ${id}::uuid AND identity.withdrawal_in_scope(${userId}::uuid, branch_id)`.execute(db)).rows.length > 0;
}

async function settlementResult(db: Executor, batchId: string, actorId: string) {
  const rows = (await sql<{ id: string; amount: string; inScope: boolean }>`SELECT s.bonus_id AS id, b.amount::text AS amount,
      identity.withdrawal_in_scope(${actorId}::uuid, b.branch_id) AS "inScope"
    FROM identity.staff_bonus_settlement s JOIN identity.staff_bonus b ON b.id = s.bonus_id
    WHERE s.batch_id = ${batchId}::uuid ORDER BY s.bonus_id`.execute(db)).rows;
  if (!rows.length || rows.some(r => !r.inScope)) throw new BonusError("bonus_not_found", "تسویه در دامنهٔ شما یافت نشد", 404);
  return { batchId, count: rows.length, totalAmount: rows.reduce((sum, r) => sum + BigInt(r.amount), 0n).toString(),
    items: rows.map(r => r.id) };
}

export function registerBonusRoutes(app: FastifyInstance, db: Db): void {
  // ── پاداش‌های من ────────────────────────────────────────────────
  app.get("/bonuses/mine", async req => {
    const s = staffSession(req);
    return page(db, sql`c.owner_id = ${s.userId}::uuid`, pageQuery.parse(req.query));
  });

  app.get("/bonuses/mine/:id", async req => {
    const s = staffSession(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const own = await sql`SELECT 1 FROM identity.staff_bonus WHERE id = ${id}::uuid AND owner_id = ${s.userId}::uuid`.execute(db);
    if (!own.rows.length) throw notFound();
    return detail(db, id);
  });

  app.get("/bonuses/mine/by-key/:key", async req => {
    const s = staffSession(req);
    const { key } = z.object({ key: z.string().min(1).max(200) }).parse(req.params);
    const row = (await sql<{ ref: string | null }>`SELECT result_ref AS ref FROM platform.inbox_message
      WHERE source = 'api.bonus.request' AND event_id = ${key} AND payload->>'ownerId' = ${s.userId}`.execute(db)).rows[0];
    return row?.ref ? { status: "recorded" as const, bonus: await detail(db, row.ref) } : { status: "not_found" as const };
  });

  app.post("/bonuses", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const s = staffSession(req);
    const key = idempotencyKey(req);
    const body = requestBody.parse(req.body);
    const out = await runOnce(db, {
      key, source: "api.bonus.request",
      payload: { ownerId: s.userId, ...body },
      run: async trx => {
        await setActor(trx, s.userId);
        const id = (await sql<{ id: string }>`SELECT identity.request_bonus(${body.amount}::numeric, ${body.reason}) AS id`
          .execute(trx)).rows[0]!.id;
        return { value: await detail(trx, id), ref: id };
      },
      replay: ref => detail(db, ref),
    });
    return reply.code(out.replayed ? 200 : 201).send({ bonus: out.value, replayed: out.replayed });
  });

  // ── دفتر مدیر ───────────────────────────────────────────────────
  app.get("/bonuses", async req => {
    const s = await managerSession(db, req, "bonus.view_all");
    const q = managerQuery.parse(req.query);
    return page(db, managerWhere(s.userId, q), q);
  });

  app.get("/bonuses/owners", async req => {
    const s = await managerSession(db, req, "bonus.view_all");
    const owners = await sql`SELECT DISTINCT o.id, o.full_name AS name FROM identity.staff_bonus b
      JOIN identity.app_user o ON o.id = b.owner_id WHERE identity.withdrawal_in_scope(${s.userId}::uuid, b.branch_id)
      ORDER BY name, o.id`.execute(db);
    return { owners: owners.rows };
  });

  // ذی‌نفعان مجاز اعطا: کارمند فعال با نقش، در دامنه، جز خود مدیر — همان شرط Trigger.
  app.get("/bonuses/beneficiaries", async req => {
    const s = await managerSession(db, req, "bonus.manage");
    const rows = await sql`SELECT u.id, u.full_name AS name FROM identity.app_user u
      WHERE u.is_active AND u.id <> ${s.userId}::uuid
        AND EXISTS (SELECT 1 FROM identity.user_role r WHERE r.user_id = u.id)
        AND identity.withdrawal_in_scope(${s.userId}::uuid, identity.withdrawal_home_branch(u.id))
      ORDER BY name, u.id`.execute(db);
    return { beneficiaries: rows.rows };
  });

  // انتخاب همه: تصویر صریح پاداش‌های تأییدشدهٔ تسویه‌نشده؛ پاداش خود مدیر بیرون است.
  app.get("/bonuses/selection", async req => {
    const s = await managerSession(db, req, "bonus.manage");
    const q = managerQuery.parse(req.query);
    const rows = await sql<Row>`${SELECT_CURRENT} WHERE ${managerWhere(s.userId, { ...q, status: "approved" })}
        AND c.owner_id <> ${s.userId}::uuid
      ORDER BY c.created_at DESC, c.id DESC LIMIT 501`.execute(db);
    if (rows.rows.length > 500) throw new BonusError("bonus_selection_limit", "بیش از ۵۰۰ پاداش تأییدشده وجود دارد؛ کارمند را انتخاب کنید یا هر صفحه را جدا تسویه کنید.", 422);
    return { items: rows.rows.map(item) };
  });

  app.get("/bonuses/awards/by-key/:key", async req => {
    const s = await managerSession(db, req, "bonus.manage");
    const { key } = z.object({ key: z.string().min(1).max(200) }).parse(req.params);
    const row = (await sql<{ ref: string | null }>`SELECT result_ref AS ref FROM platform.inbox_message
      WHERE source = 'api.bonus.award' AND event_id = ${key} AND payload->>'actorId' = ${s.userId}`.execute(db)).rows[0];
    if (!row?.ref) return { status: "not_found" as const };
    if (!await inScope(db, row.ref, s.userId)) throw notFound();
    return { status: "recorded" as const, bonus: await detail(db, row.ref) };
  });

  app.post("/bonuses/awards", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const s = await managerSession(db, req, "bonus.manage");
    const key = idempotencyKey(req);
    const body = awardBody.parse(req.body);
    if (body.ownerId === s.userId) throw new BonusError("bonus_self", "هیچ مدیری به خودش پاداش اعطا نمی‌کند.", 422);
    const out = await runOnce(db, {
      key, source: "api.bonus.award", payload: { actorId: s.userId, ...body },
      run: async trx => {
        await managerSession(trx, req, "bonus.manage");
        const target = (await sql<{ ok: boolean }>`SELECT (u.is_active AND EXISTS (SELECT 1 FROM identity.user_role r WHERE r.user_id = u.id)
            AND identity.withdrawal_in_scope(${s.userId}::uuid, identity.withdrawal_home_branch(u.id))) AS ok
          FROM identity.app_user u WHERE u.id = ${body.ownerId}::uuid`.execute(trx)).rows[0];
        if (!target?.ok) throw new BonusError("bonus_beneficiary_not_found", "کارمند فعال در دامنهٔ شما یافت نشد.", 404);
        await setActor(trx, s.userId);
        const id = (await sql<{ id: string }>`SELECT identity.award_bonus(${body.ownerId}::uuid, ${body.amount}::numeric, ${body.reason}) AS id`
          .execute(trx)).rows[0]!.id;
        return { value: await detail(trx, id), ref: id };
      },
      replay: async ref => {
        if (!await inScope(db, ref, s.userId)) throw notFound();
        return detail(db, ref);
      },
    });
    return reply.code(out.replayed ? 200 : 201).send({ bonus: out.value, replayed: out.replayed });
  });

  // «آیا تصمیمِ نامعلوم نشست؟» — با همان شناسهٔ عملیات و همان مدیر؛ تصمیم مدیر دیگر «نشسته» شمرده نمی‌شود.
  app.get("/bonuses/decisions/by-key/:key", async req => {
    const s = await managerSession(db, req, "bonus.manage");
    const { key } = z.object({ key: z.string().min(1).max(200) }).parse(req.params);
    const row = (await sql<{ ref: string | null }>`SELECT result_ref AS ref FROM platform.inbox_message
      WHERE source = 'api.bonus.decide' AND event_id = ${key} AND payload->>'actorId' = ${s.userId}`.execute(db)).rows[0];
    if (!row?.ref) return { status: "not_found" as const };
    if (!await inScope(db, row.ref, s.userId)) throw notFound();
    return { status: "recorded" as const, bonus: await detail(db, row.ref) };
  });

  app.get("/bonuses/settlements/by-key/:key", async req => {
    const s = await managerSession(db, req, "bonus.manage");
    const { key } = z.object({ key: z.string().min(1).max(200) }).parse(req.params);
    const row = (await sql<{ ref: string | null }>`SELECT result_ref AS ref FROM platform.inbox_message
      WHERE source = 'api.bonus.settle' AND event_id = ${key} AND payload->>'actorId' = ${s.userId}`.execute(db)).rows[0];
    return row?.ref ? { status: "recorded", ...await settlementResult(db, row.ref, s.userId) } : { status: "not_found" };
  });

  app.post("/bonuses/settlements", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async req => {
    const s = await managerSession(db, req, "bonus.manage");
    const key = idempotencyKey(req);
    const parsed = settlementBody.parse(req.body);
    const body = { ...parsed, items: [...parsed.items].sort() };
    const out = await runOnce(db, { key, source: "api.bonus.settle", payload: { actorId: s.userId, ...body },
      run: async trx => {
        await managerSession(trx, req, "bonus.manage");
        await setActor(trx, s.userId);
        // ترتیب ثابت قفل‌ها برای دو انتخاب هم‌پوشان؛ همه یا هیچ.
        for (const id of body.items) {
          const head = (await sql<{ inScope: boolean; ownerId: string }>`SELECT identity.withdrawal_in_scope(${s.userId}::uuid, branch_id) AS "inScope",
              owner_id AS "ownerId" FROM identity.staff_bonus WHERE id = ${id}::uuid FOR UPDATE`.execute(trx)).rows[0];
          if (!head?.inScope) throw notFound();
          if (head.ownerId === s.userId) throw new BonusError("bonus_self", "پاداش خود را نمی‌توانید تسویه کنید؛ آن را از انتخاب بردارید.", 422);
          const cur = (await sql<{ status: Status }>`SELECT status FROM identity.staff_bonus_current WHERE id = ${id}::uuid`.execute(trx)).rows[0]!;
          if (cur.status !== "approved") throw new BonusError("bonus_stale", "بخشی از انتخاب تغییر کرده یا تسویه شده است؛ فهرست را تازه و دوباره انتخاب کنید.", 409);
        }
        const batchId = randomUUID();
        for (const id of body.items) await sql`INSERT INTO identity.staff_bonus_settlement(bonus_id, batch_id, actor_id, note)
          VALUES (${id}::uuid, ${batchId}::uuid, ${s.userId}::uuid, ${body.note})`.execute(trx);
        return { value: await settlementResult(trx, batchId, s.userId), ref: batchId };
      }, replay: ref => settlementResult(db, ref, s.userId),
    });
    return { ...out.value, replayed: out.replayed };
  });

  app.get("/bonuses/:id", async req => {
    const s = await managerSession(db, req, "bonus.view_all");
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!await inScope(db, id, s.userId)) throw notFound();
    const found = await detail(db, id);
    // فقط نمایش؛ دروازهٔ واقعی مسیرهای مدیریت و Trigger است.
    const verdict = await can(db, { userId: s.userId, operation: "bonus.manage", viaPin: s.pinUnlocked });
    return { ...found, canManage: verdict.verdict === "allow" && found.owner.id !== s.userId };
  });

  app.post("/bonuses/:id/decisions", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async req => {
    const s = staffSession(req);
    const key = idempotencyKey(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = decisionBody.parse(req.body);
    // پیش از Replay هم: کسی که مجوزش برداشته شده، پاسخ قبلی را هم نمی‌گیرد.
    await managerSession(db, req, "bonus.manage");
    const out = await runOnce(db, {
      key, source: "api.bonus.decide", payload: { actorId: s.userId, id, ...body },
      run: async trx => {
        await managerSession(trx, req, "bonus.manage");
        // قفل سرآیند تا پایان تراکنش: تصمیم هم‌زمانِ دوم پشت این صف می‌کشد و «قدیمی» می‌شود.
        const head = (await sql<{ ownerId: string; origin: string; inScope: boolean }>`SELECT owner_id AS "ownerId", origin,
            identity.withdrawal_in_scope(${s.userId}::uuid, branch_id) AS "inScope"
          FROM identity.staff_bonus WHERE id = ${id}::uuid FOR UPDATE`.execute(trx)).rows[0];
        if (!head?.inScope) throw notFound();
        if (head.ownerId === s.userId) throw new BonusError("bonus_self", "درخواست پاداش خود را نمی‌توانید بررسی کنید.", 422);
        const cur = (await sql<{ status: Status }>`SELECT status FROM identity.staff_bonus_current WHERE id = ${id}::uuid`.execute(trx)).rows[0]!;
        if (head.origin !== "request" || cur.status !== "pending") {
          throw new BonusError("bonus_stale", "این پاداش دیگر در انتظار بررسی نیست؛ فهرست را تازه کنید.", 409);
        }
        await setActor(trx, s.userId);
        await sql`SELECT identity.decide_bonus(${id}::uuid, ${body.decision}, ${body.note ?? null})`.execute(trx);
        return { value: await detail(trx, id), ref: id };
      },
      replay: async ref => {
        if (!await inScope(db, ref, s.userId)) throw notFound();
        return detail(db, ref);
      },
    });
    return { bonus: out.value, replayed: out.replayed };
  });
}
