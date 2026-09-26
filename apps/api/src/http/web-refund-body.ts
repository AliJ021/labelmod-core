import { z } from "zod";

const money = z.string().regex(/^\d{1,18}$/);

/** قرارداد مشترک پیام ورودی و دادهٔ ذخیره‌شده، پیش از هر اثر مالی. */
export const wooRefundBodySchema = z.object({
  orderId: z.string().trim().min(1).max(64),
  refundId: z.string().trim().min(1).max(64),
  amount: money.pipe(z.string().refine((x) => BigInt(x) > 0n)),
  shippingAmount: money.default("0"),
  lines: z.array(z.object({
    lineNo: z.number().int().positive(),
    qty: z.string().regex(/^\d{1,11}(\.\d{1,3})?$/).refine((x) => Number(x) > 0),
    restock: z.boolean(),
  })).min(1).max(200),
});

export type WooRefundBody = z.infer<typeof wooRefundBodySchema>;
