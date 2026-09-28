import type { ReactNode } from "react";

/**
 * برگ LTR — تنها جای مجاز `dir="ltr"` برای محتوای تازه.
 *
 * SKU، موبایل، نشانی، شمارهٔ مرجع، شناسهٔ تراکنش و کد لاتین کالا. همیشه
 * **کوچک‌ترین** عنصر ممکن را چپ‌چین کن، هرگز ظرف یا سطر را
 * (test/direction.test.ts). `<bdi>` متن اطراف را از ترتیب این برگ جدا
 * نگه می‌دارد، پس «کد TR-1405 پیدا نشد» درست خوانده می‌شود.
 */
export function Ltr({ children, mono = true, title }: { children: ReactNode; mono?: boolean; title?: string }) {
  return <bdi dir="ltr" className={`ltr${mono ? " ltr--mono" : ""}`} title={title}>{children}</bdi>;
}
