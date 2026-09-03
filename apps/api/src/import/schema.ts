/**
 * قرارداد فایل‌های ورودی مهاجرت داده.
 *
 * ── این یک «موتور Import عمومی» نیست، و عمداً ───────────────────────
 *
 * CLAUDE.md موتور Import عمومی را در فهرست «چه چیزی نساز» گذاشته.
 * دلیلش هم روشن است: نگاشت دلخواه ستون‌ها یعنی هر بار که کسی فایلی
 * می‌آورد، باید تصمیم بگیرد کدام ستون به کجا می‌رود — و آن تصمیم
 * جایی ثبت نمی‌شود.
 *
 * پس اینجا **پنج فایل با ستون‌های ثابت** است. کسی که از نرم‌افزار
 * فعلی خروجی می‌گیرد، ستون‌ها را یک بار در اکسل مرتب می‌کند و از آن
 * به بعد قرارداد ثابت است. `docs/DATA-MIGRATION.md` همان قرارداد را
 * برای آدم می‌نویسد.
 *
 * ── قاعده‌ای که کل این ماژول رویش ایستاده ───────────────────────────
 *
 * **همه فایل‌ها اعتبارسنجی می‌شوند، بعد هیچ‌کدام یا همه نوشته می‌شوند.**
 * وارداتِ نیمه‌کاره از واردات‌نشده بدتر است: کاتالوگی که نصفش آمده،
 * موجودی‌ای که به بعضی کالاها خورده، و کسی که نمی‌داند از کجا ادامه
 * دهد.
 */
import { z } from "zod";
import { normalizeDigits } from "./csv.ts";

/** مبلغ ریالی از فایل: رقم فارسی و جداکننده هزارگان را می‌فهمد. */
const money = z
  .string()
  .transform((v) => normalizeDigits(v))
  .refine((v) => v === "" || /^-?\d+$/.test(v), {
    message: "مبلغ باید عدد صحیح ریالی باشد (بدون اعشار)",
  })
  .transform((v) => (v === "" ? 0n : BigInt(v)));

/** تعداد: حداکثر سه رقم اعشار، مثل `platform.qty`. */
const qty = z
  .string()
  .transform((v) => normalizeDigits(v))
  .refine((v) => v !== "" && /^-?\d+(\.\d{1,3})?$/.test(v), {
    message: "تعداد نامعتبر است",
  });

const required = (label: string) =>
  z.string().trim().min(1, `${label} خالی است`);

const optional = z.string().trim().default("");

/**
 * کالا و تنوع.
 *
 * ⚠️ **SKU کلید مهاجرت است، نه بارکد.** بارکد ممکن است نباشد (کالای
 *    قدیمی)، تکراری باشد (دو کالا با یک بارکد کارخانه) یا عوض شود.
 *    SKU چیزی است که انباردار روی برچسب می‌بیند و در فایل می‌نویسد.
 *
 * ⚠️ **قیمت اختیاری است.** کالایی که هنوز قیمت‌گذاری نشده باید بتواند
 *    وارد شود؛ اجبارش یعنی یا صفر بنویسند (که یک قیمت واقعی است و
 *    فروش با آن ممکن می‌شود) یا کالا جا بماند.
 */
export const productRow = z.object({
  sku: required("SKU"),
  name: required("نام کالا"),
  color: optional,
  size: optional,
  barcode: optional,
  price: money.optional(),
  /** کد کالا در سیستم قبلی — برای رهگیری و Idempotency. */
  legacy_id: optional,
});

/**
 * موجودی اول دوره.
 *
 * ⚠️ **بهای تمام‌شده اجباری است و این مذاکره‌پذیر نیست.** موجودی بدون
 *    بها یعنی اولین فروشِ آن کالا سودِ صددرصد نشان می‌دهد و ترازنامه
 *    دارایی‌ای دارد که ارزشش صفر است. اگر بهای واقعی معلوم نیست،
 *    مهاجرت باید بایستد تا کسی تصمیم بگیرد — نه اینکه صفر فرض کند.
 */
export const stockRow = z.object({
  sku: required("SKU"),
  qty,
  /** بهای تمام‌شده **هر واحد**، به ریال. */
  unit_cost: money,
});

export const customerRow = z.object({
  mobile: required("موبایل"),
  name: optional,
  /** حد اعتبار نسیه. خالی یعنی صفر — یعنی نسیه ندارد. */
  credit_limit: money.optional(),
  legacy_id: optional,
});

export const supplierRow = z.object({
  code: required("کد تأمین‌کننده"),
  name: required("نام تأمین‌کننده"),
  mobile: optional,
  legacy_id: optional,
});

/**
 * مانده‌های افتتاحیه.
 *
 * هر سطر یک مؤلفه از `posting_rule` رویداد `opening` است. مؤلفه‌های
 * مجاز: `cash` · `bank` · `receivable` · `payable`.
 *
 * ⚠️ `inventory` و `equity` در این فایل **نیستند و نباید باشند**:
 *
 *   • `inventory` از جمع فایل موجودی ساخته می‌شود. اگر دستی هم نوشته
 *     شود، دو عدد داریم که باید همیشه با هم بخوانند — و روزی
 *     نمی‌خوانند.
 *   • `equity` **رقم متوازن‌کننده** است، نه یک ورودی. سرمایه‌ای که
 *     دستی نوشته شود و سند را متوازن نکند، فقط یک خطای دیرهنگام
 *     می‌سازد.
 *
 * `party` برای `receivable` و `payable` اجباری است: بدون آن، گردش
 * حساب اشخاص از دفتر ساختنی نیست (قاعده `party_id` در CLAUDE.md).
 * برای مشتری موبایل، برای تأمین‌کننده کد.
 */
export const openingRow = z.object({
  leg: z.enum(["cash", "bank", "receivable", "payable"], {
    message: "مؤلفه باید یکی از cash، bank، receivable یا payable باشد",
  }),
  amount: money,
  /** موبایل مشتری یا کد تأمین‌کننده. برای cash و bank خالی. */
  party: optional,
  note: optional,
});

export type ProductRow = z.infer<typeof productRow>;
export type StockRow = z.infer<typeof stockRow>;
export type CustomerRow = z.infer<typeof customerRow>;
export type SupplierRow = z.infer<typeof supplierRow>;
export type OpeningRow = z.infer<typeof openingRow>;

/** نام فایل → Schema. نام فایل بخشی از قرارداد است. */
export const FILES = {
  "products.csv": productRow,
  "customers.csv": customerRow,
  "suppliers.csv": supplierRow,
  "opening-stock.csv": stockRow,
  "opening-balances.csv": openingRow,
} as const;

export type FileName = keyof typeof FILES;

/** یک خطای اعتبارسنجی، با محل دقیقش در فایل. */
export interface RowError {
  file: string;
  line: number;
  column: string;
  message: string;
}

/**
 * یک فایل را می‌سنجد و **همه** خطاهایش را برمی‌گرداند، نه اولی را.
 *
 * ⚠️ توقف روی اولین خطا یعنی کسی که فایل هزار سطری دارد، هزار بار
 *    اجرا کند تا همه را پیدا کند. فهرست کامل یعنی یک بار اصلاح.
 */
export function validateRows<T extends z.ZodType>(
  file: string,
  schema: T,
  rows: { values: Record<string, string>; line: number }[],
): { ok: z.infer<T>[]; errors: RowError[] } {
  const ok: z.infer<T>[] = [];
  const errors: RowError[] = [];

  for (const row of rows) {
    const parsed = schema.safeParse(row.values);
    if (parsed.success) {
      ok.push(parsed.data);
      continue;
    }
    for (const issue of parsed.error.issues) {
      errors.push({
        file,
        line: row.line,
        column: issue.path.join(".") || "—",
        message: issue.message,
      });
    }
  }
  return { ok, errors };
}
