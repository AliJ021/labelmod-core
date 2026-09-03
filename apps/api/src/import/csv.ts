/**
 * خواندن CSV — بدون وابستگی تازه.
 *
 * ── چرا خودمان و نه یک کتابخانه ─────────────────────────────────────
 *
 * بند ۵ SECURITY.md: «هیچ وابستگی‌ای بدون دلیل مشخص اضافه نمی‌شود. برای
 * این پروژه، تعداد کم وابستگی خودش یک کنترل امنیتی است.» یک Parser
 * برای CSV استاندارد صد خط است و همه‌اش را اینجا می‌شود خواند.
 *
 * ── چه چیزی از دنیای واقعی پشتیبانی می‌شود، و چرا ───────────────────
 *
 * فایل‌هایی که از نرم‌افزار حسابداری فعلی و اکسل بیرون می‌آیند، سه
 * چیز دارند که Parser ساده‌ی `split(',')` را می‌شکند:
 *
 * ۱. **BOM** در ابتدای فایل. اکسل فارسی همیشه می‌گذاردش، و بدون
 *    حذفش نام **اولین ستون** با یک کاراکتر نامرئی شروع می‌شود و هیچ
 *    ستونی پیدا نمی‌شود — با پیام خطایی که هیچ‌کس نمی‌فهمد.
 * ۲. **فیلد نقل‌قولی** با کاما یا خط تازه داخلش: «تهران، خیابان …».
 * ۳. **پایان خط ویندوزی** `\r\n`.
 *
 * جداکننده هم می‌تواند `;` باشد: اکسل روی ویندوزِ فارسی، در برخی
 * تنظیمات منطقه‌ای، به‌جای کاما نقطه‌ویرگول می‌نویسد. تشخیصش خودکار
 * است، چون کسی که فایل را Export می‌کند از این تفاوت خبر ندارد.
 */

export class CsvError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(message);
    this.name = "CsvError";
    this.line = line;
  }
}

/**
 * جداکننده را از **سطر عنوان** حدس می‌زند.
 *
 * فقط بیرون از نقل‌قول شمرده می‌شود، وگرنه «تهران، خیابان» یک فایل
 * نقطه‌ویرگولی را «کامایی» نشان می‌داد.
 */
export function detectDelimiter(head: string): string {
  let inQuotes = false;
  let comma = 0;
  let semi = 0;
  let tab = 0;
  for (const ch of head) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes) {
      if (ch === ",") comma++;
      else if (ch === ";") semi++;
      else if (ch === "\t") tab++;
    }
  }
  if (semi > comma && semi >= tab) return ";";
  if (tab > comma && tab > semi) return "\t";
  return ",";
}

/**
 * CSV → آرایه‌ای از سطرها (هر سطر آرایه‌ای از رشته).
 *
 * سطر خالی رد می‌شود: فایل اکسل تقریباً همیشه با یک خط خالی تمام
 * می‌شود و «سطر بدون داده» یک خطای گیج‌کننده بود.
 */
export function parseCsv(input: string, delimiter?: string): string[][] {
  // BOM — اکسل فارسی همیشه می‌گذاردش.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delim = delimiter ?? detectDelimiter(text.split(/\r?\n/, 1)[0] ?? "");

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let started = false;

  const endField = () => {
    row.push(field);
    field = "";
    started = false;
  };
  const endRow = () => {
    endField();
    // سطر تک‌فیلدیِ خالی = خط خالی.
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;

    if (inQuotes) {
      if (ch === '"') {
        // `""` داخل نقل‌قول یعنی یک `"` واقعی.
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }

    if (ch === '"' && !started) {
      inQuotes = true;
      started = true;
    } else if (ch === delim) {
      endField();
    } else if (ch === "\r") {
      // `\r\n` ویندوزی: `\r` نادیده، `\n` سطر را می‌بندد.
      if (text[i + 1] !== "\n") {
        endRow();
        line++;
      }
    } else if (ch === "\n") {
      endRow();
      line++;
    } else {
      field += ch;
      started = true;
    }
  }

  if (inQuotes) {
    throw new CsvError("نقل‌قول بسته نشده است — فایل ناقص یا خراب است", line);
  }
  if (field !== "" || row.length > 0) endRow();

  return rows;
}

export interface CsvTable {
  headers: string[];
  /** هر سطر: نام ستون → مقدار. شماره سطر برای پیام خطا نگه داشته می‌شود. */
  rows: { values: Record<string, string>; line: number }[];
}

/**
 * سطر اول را عنوان می‌گیرد و بقیه را به شیء تبدیل می‌کند.
 *
 * ⚠️ نام ستون‌ها `trim` می‌شوند و **حساس به بزرگی و کوچکی نیستند**:
 *    اکسل گاهی فاصله‌ای در انتهای عنوان می‌گذارد که در فایل دیده
 *    نمی‌شود، و کسی که فایل را می‌سازد «SKU» یا «sku» می‌نویسد بی‌آنکه
 *    فرقی برایش داشته باشد.
 */
export function toTable(input: string): CsvTable {
  const rows = parseCsv(input);
  if (rows.length === 0) throw new CsvError("فایل خالی است", 1);

  const headers = (rows[0] as string[]).map((h) => h.trim().toLowerCase());
  const dupes = headers.filter((h, i) => h !== "" && headers.indexOf(h) !== i);
  if (dupes.length > 0) {
    throw new CsvError(`ستون تکراری: ${[...new Set(dupes)].join("، ")}`, 1);
  }

  const out: CsvTable = { headers, rows: [] };
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i] as string[];
    const values: Record<string, string> = {};
    headers.forEach((h, j) => {
      if (h !== "") values[h] = (cells[j] ?? "").trim();
    });
    // سطری که همه ستون‌هایش خالی است، داده نیست.
    if (Object.values(values).some((v) => v !== "")) {
      out.rows.push({ values, line: i + 1 });
    }
  }
  return out;
}

/**
 * رقم فارسی و عربی → لاتین، و پاک‌کردن جداکننده هزارگان.
 *
 * ⚠️ همان قاعده `normalizeDigits` در `apps/web`: صفحه‌کلید فارسی
 *    «۱۲۳٬۴۵۶» می‌فرستد و `Number()` رویش `NaN` می‌دهد. اینجا لازم‌تر
 *    است، چون فایل را آدمی در اکسل فارسی ساخته.
 */
export function normalizeDigits(raw: string): string {
  return raw
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    // جداکننده هزارگان: کامای لاتین، کامای عربی، ممیز فارسی
    .replace(/[,٬،]/g, "")
    // نیم‌فاصله و فاصله‌های نامرئی که از کپی‌کردن می‌آیند
    .replace(/[‌‎‏\s]/g, "")
    .trim();
}
