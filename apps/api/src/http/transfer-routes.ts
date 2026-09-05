/**
 * مسیرهای انتقال بین انبارها.
 *
 * ── دروازه‌ای که اگر نصفه اجرا شود، هیچ نیست ──────────────────────
 *
 * دامنه شعبه باید روی **هر دو** انبار اعمال شود. اگر فقط مبدأ سنجیده
 * شود، کاربر شعبه A می‌تواند کالا را به انبار شعبه B بفرستد و از آن
 * لحظه دیگر نبیندش — یعنی موجودی شعبه A بی‌آنکه کسی بفهمد کم شده و
 * کالا جایی است که هیچ‌کدامشان دنبالش نمی‌گردند.
 *
 * `assertBranch` روی شعبه برگه، و `assertWarehouseInBranch` روی هر دو
 * انبار. سه سنجش، نه یکی.
 *
 * ── چرا ثبت `Idempotency-Key` می‌گیرد ولی افزودن قلم نه ────────────
 *
 * ثبت **اثر مالی و انباری** دارد و تکرارش کالا را دو بار جابه‌جا
 * می‌کند. افزودن قلم مطلق است (`ON CONFLICT DO UPDATE` جمع می‌زند) و
 * تغییر تعداد هم مطلق — تکرارشان همان نتیجه را می‌دهد.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AuthError } from "../auth/service.ts";
import { requireForSession } from "../auth/permission.ts";
import type { Db } from "../db/client.ts";
import { runOnce } from "../lib/idempotency.ts";
import { assertBranch, assertWarehouseInBranch, branchesOf } from "../sales/scope.ts";
import { TransferError, type TransferService } from "../inventory/transfer.ts";
import { resolveVariationId } from "../catalog/resolve.ts";

const uuid = z.string().uuid("شناسه نامعتبر");

/**
 * تعداد انتقال عدد صحیح است.
 *
 * `platform.qty` اعشاری می‌پذیرد و باید بپذیرد (متر پارچه روزی
 * می‌آید)، ولی امروز کالای این فروشگاه تعدادی است و «۱٫۵ مانتو» یک
 * اشتباه تایپی است — همان محدودیتی که Endpoint صندوق دارد.
 */
const qtyString = z.string().regex(/^\d+$/, "تعداد باید عدد صحیح مثبت باشد");

const createBody = z.object({
  branchId: uuid,
  fromWarehouseId: uuid,
  toWarehouseId: uuid,
  note: z.string().max(500).optional(),
});

/**
 * قلم انتقال — با بارکد یا شناسه.
 *
 * انباردار **اسکن** می‌کند؛ شناسه را نمی‌داند و نباید بداند. همان
 * الگوی رسید خرید و انبارگردانی، با همان تابع مشترک
 * (`catalog/resolve.ts`) — که یعنی «کالای بایگانی‌شده اسکن نمی‌شود»
 * اینجا هم برقرار است، بدون کپی‌کردن قاعده.
 */
const addLineBody = z
  .object({
    variationId: uuid.optional(),
    barcode: z.string().trim().min(1).max(64).optional(),
    qty: qtyString.default("1"),
  })
  .refine((v) => v.variationId !== undefined || v.barcode !== undefined, {
    message: "کالا باید با شناسه یا بارکد مشخص شود",
  });

const setQtyBody = z.object({ qty: qtyString });

export interface TransferRouteDeps {
  db: Db;
  transfers: TransferService;
}

export function registerTransferRoutes(app: FastifyInstance, deps: TransferRouteDeps): void {
  const { db, transfers } = deps;

  const session = (req: { session: unknown }) => {
    const s = req.session as
      | { userId: string; pinUnlocked: boolean; fullName: string }
      | null;
    if (!s) throw new AuthError("no_session", "وارد نشده‌اید");
    return s;
  };

  /** برگه در دامنه این کاربر است؟ — پیش از هر خواندن یا نوشتنی. */
  async function assertTransferInScope(userId: string, id: string): Promise<void> {
    const t = await transfers.branchOf(id);
    if (!t) throw new TransferError("transfer_not_found", "برگه انتقال یافت نشد", 404);
    await assertBranch(db, userId, t.branchId);
  }

  app.get("/transfers", async (req) => {
    const s = session(req);
    await requireForSession(db, s, "stock.transfer");
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query);
    return { transfers: await transfers.list(await branchesOf(db, s.userId), q.limit) };
  });

  app.get("/transfers/:id", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await requireForSession(db, s, "stock.transfer");
    await assertTransferInScope(s.userId, id);
    const t = await transfers.byId(id);
    if (!t) throw new TransferError("transfer_not_found", "برگه انتقال یافت نشد", 404);
    return t;
  });

  app.post("/transfers", async (req, reply) => {
    const s = session(req);
    const body = createBody.parse(req.body);
    await assertBranch(db, s.userId, body.branchId);
    // ⚠️ **هر دو** انبار. سنجش نصفه یعنی راهی برای بیرون‌بردن کالا.
    await assertWarehouseInBranch(db, body.fromWarehouseId, body.branchId);
    await assertWarehouseInBranch(db, body.toWarehouseId, body.branchId);
    await requireForSession(db, s, "stock.transfer");

    const id = await transfers.create({
      branchId: body.branchId,
      fromWarehouseId: body.fromWarehouseId,
      toWarehouseId: body.toWarehouseId,
      actorId: s.userId,
      ...(body.note === undefined ? {} : { note: body.note }),
    });
    return reply.code(201).send({ id });
  });

  app.post("/transfers/:id/lines", async (req, reply) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = addLineBody.parse(req.body);
    await requireForSession(db, s, "stock.transfer");
    await assertTransferInScope(s.userId, id);

    const variationId = await resolveVariationId(
      db,
      {
        ...(body.variationId === undefined ? {} : { variationId: body.variationId }),
        ...(body.barcode === undefined ? {} : { barcode: body.barcode }),
      },
      (code, message, status) => new TransferError(code, message, status),
    );

    await transfers.addLine({
      transferId: id,
      variationId,
      qty: body.qty,
      actorId: s.userId,
    });
    return reply.code(201).send(await transfers.byId(id));
  });

  app.patch("/transfers/:id/lines/:lineId", async (req) => {
    const s = session(req);
    const { id, lineId } = z.object({ id: uuid, lineId: uuid }).parse(req.params);
    const body = setQtyBody.parse(req.body);
    await requireForSession(db, s, "stock.transfer");
    await assertTransferInScope(s.userId, id);

    await transfers.setLineQty({
      transferId: id,
      lineId,
      qty: body.qty,
      actorId: s.userId,
    });
    return await transfers.byId(id);
  });

  app.delete("/transfers/:id/lines/:lineId", async (req) => {
    const s = session(req);
    const { id, lineId } = z.object({ id: uuid, lineId: uuid }).parse(req.params);
    await requireForSession(db, s, "stock.transfer");
    await assertTransferInScope(s.userId, id);
    await transfers.removeLine(id, lineId, s.userId);
    return await transfers.byId(id);
  });

  /** پیش‌نویس رهاشده — حذفش شماره‌ای نسوزانده، چون هنوز شماره ندارد. */
  app.delete("/transfers/:id", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await requireForSession(db, s, "stock.transfer");
    await assertTransferInScope(s.userId, id);
    await transfers.discard(id, s.userId);
    return { ok: true };
  });

  /**
   * ثبت — همان لحظه‌ای که کالا واقعاً جابه‌جا می‌شود.
   *
   * کلید Idempotency **از خودِ برگه** ساخته می‌شود اگر کلاینت نفرستد:
   * هویت این عملیات همان برگه است و دو بار زدن «ثبت» نباید کالا را دو
   * بار جابه‌جا کند. لایه دوم هم در دیتابیس است — `post_transfer`
   * برگه `posted` را دوباره ثبت نمی‌کند.
   */
  app.post("/transfers/:id/post", async (req) => {
    const s = session(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await requireForSession(db, s, "stock.transfer");
    await assertTransferInScope(s.userId, id);

    const key = (req.headers["idempotency-key"] as string | undefined) ?? `transfer:${id}`;

    const out = await runOnce<{ lines: number }>(db, {
      key,
      source: "api.inventory.transfer_post",
      payload: { transferId: id, actorId: s.userId },
      run: async (trx) => {
        const n = await transfers.postIn(trx, { transferId: id, actorId: s.userId });
        return { value: { lines: n }, ref: id };
      },
      replay: async () => {
        const t = await transfers.byId(id);
        return { lines: t?.lineCount ?? 0 };
      },
    });

    const t = await transfers.byId(id);
    return { ...t, lines: out.value.lines, replayed: out.replayed };
  });
}
