export interface ReturnOperation {
  key: string;
  kind: "returns" | "exchanges";
  userId: string;
  version?: 1;
  body?: Record<string, unknown>;
}
export function operationStorageKey(userId: string): string { return `labelmod.return-operation.${userId}`; }
export function parseReturnOperation(raw: string | null, userId: string): ReturnOperation | null {
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("شناسه عملیات ذخیره‌شده خوانا نیست؛ بررسی پشتیبانی لازم است");
  const v = value as Record<string, unknown>;
  if (v.userId !== userId || typeof v.key !== "string" || !/^[a-f0-9-]{36}$/i.test(v.key)
    || !["returns", "exchanges"].includes(String(v.kind))) throw new Error("شناسه عملیات ذخیره‌شده معتبر نیست؛ بررسی پشتیبانی لازم است");
  // کلیدهای نسخه قدیمی فقط بررسی وضعیت می‌شوند؛ بدنه گمشده حدس زده نمی‌شود.
  if (v.version !== undefined || v.body !== undefined) {
    const b = v.body as Record<string, unknown> | null;
    if (v.version !== 1 || !b || typeof b !== "object" || Array.isArray(b)
      || b.confirmed !== true || typeof b.invoiceId !== "string" || !b.invoiceId
      || typeof b.reasonCode !== "string" || !b.reasonCode || !Array.isArray(b.lines) || !b.lines.length
      || b.lines.some(l => !l || typeof l.invoiceLineId !== "string" || typeof l.qty !== "string" || !/^\d+(\.\d{1,3})?$/.test(l.qty))
      || (v.kind === "returns" && (typeof b.refundAmount !== "string" || !/^\d+$/.test(b.refundAmount)))
      || (v.kind === "exchanges" && (typeof b.token !== "string" || !/^[a-f0-9]{64}$/.test(b.token)
        || typeof b.warehouseId !== "string" || typeof b.returnWarehouseId !== "string"
        || !Array.isArray(b.replacements) || !b.replacements.length
        || b.replacements.some(l => !l || typeof l.variationId !== "string" || typeof l.qty !== "string" || !/^\d+(\.\d{1,3})?$/.test(l.qty)))))
      throw new Error("بدنه عملیات ذخیره‌شده معتبر نیست؛ بررسی پشتیبانی لازم است");
  }
  return v as unknown as ReturnOperation;
}
