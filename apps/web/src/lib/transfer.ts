/**
 * لایه داده انتقال بین انبارها.
 *
 * ── دو چیزی که این لایه نگه می‌دارد ────────────────────────────────
 *
 * **بها را نمی‌فرستد و نمی‌سازد.** `unitCost` فقط **خوانده** می‌شود و
 * تا لحظه ثبت `null` است. بهای خروج را `apply_movement` در دیتابیس
 * تعیین می‌کند؛ فرستادنش از مرورگر یعنی ارزش موجودی از کلاینت بیاید.
 *
 * **تعداد مطلق است.** `setLineQty` جای مقدار قبلی می‌نشیند و
 * `addLine` جمع می‌زند (اسکن دوباره = یکی بیشتر). هر دو تکرارپذیرند،
 * پس کلید Idempotency نمی‌خواهند — برخلاف **ثبت** که اثر انباری دارد.
 */
import { api, type RequestOptions } from "./api.ts";

export interface TransferLine {
  id: string;
  variationId: string;
  sku: string;
  productName: string;
  color: string;
  size: string;
  qty: string;
  /** تا لحظه ثبت `null` — بها در لحظه خروج معلوم می‌شود. */
  unitCost: string | null;
  valueDelta: string | null;
}

export interface TransferHead {
  id: string;
  number: string | null;
  branchId: string;
  fromWarehouseId: string;
  fromWarehouseName: string;
  toWarehouseId: string;
  toWarehouseName: string;
  status: string;
  occurredAt: string;
  postedAt: string | null;
  note: string | null;
  createdByName: string | null;
  lineCount: number;
  totalQty: string;
  totalValue: string | null;
}

export interface Transfer extends TransferHead {
  lines: TransferLine[];
}

export const TRANSFER_STATUS: Record<string, string> = {
  draft: "پیش‌نویس",
  posted: "ثبت‌شده",
  cancelled: "باطل",
};

export const transfers = {
  list: (limit = 50) =>
    api.get<{ transfers: TransferHead[] }>(`/transfers?limit=${limit}`),

  byId: (id: string) => api.get<Transfer>(`/transfers/${id}`),

  create: (input: {
    branchId: string;
    fromWarehouseId: string;
    toWarehouseId: string;
    note?: string;
  }) => api.post<{ id: string }>("/transfers", input),

  /**
   * افزودن قلم — با **بارکد** یا شناسه.
   *
   * انباردار اسکن می‌کند؛ شناسه را نمی‌داند. سرور بارکد را حل می‌کند
   * و همان‌جا کالای بایگانی‌شده را رد می‌کند.
   *
   * اسکن دوباره همان کالا تعداد را **جمع** می‌زند، سطر دوم نمی‌سازد.
   */
  addLine: (
    id: string,
    input: { variationId?: string; barcode?: string; qty: string },
  ) => api.post<Transfer>(`/transfers/${id}/lines`, input),

  setLineQty: (id: string, lineId: string, qty: string) =>
    api.patch<Transfer>(`/transfers/${id}/lines/${lineId}`, { qty }),

  removeLine: (id: string, lineId: string) =>
    api.del<Transfer>(`/transfers/${id}/lines/${lineId}`),

  discard: (id: string) => api.del<{ ok: boolean }>(`/transfers/${id}`),

  /**
   * ثبت — تنها عملیاتی اینجا که اثر انباری دارد، پس تنها یکی که کلید
   * Idempotency می‌گیرد. سرور اگر کلید نفرستیم خودش از شناسه برگه
   * می‌سازد؛ فرستادنش فقط لایه اول است.
   */
  post: (id: string, opts?: RequestOptions) =>
    api.post<Transfer & { lines: number; replayed: boolean }>(
      `/transfers/${id}/post`,
      {},
      opts,
    ),
};
