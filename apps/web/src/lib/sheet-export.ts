import type { Cell, SheetData } from "write-excel-file/browser";

export type ExportValue = string | number | null;
export interface ExportTable { title: string; columns: string[]; rows: ExportValue[][] }

function numericCell(header: string, value: ExportValue): ExportValue {
  if (typeof value !== "string" || !/مبلغ|قیمت|بها|تعداد|موجودی|بدهکار|بستانکار|مانده|تخفیف|نرخ|ارزش|جمع|پرداخت|طلب|اعتبار|مالیات/.test(header) ||
      /شماره|شناسه|کد|تاریخ|زمان|روش|وضعیت|مرجع/.test(header)) return value;
  const ascii = value.replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٬,]/g, "").replace("٫", ".").replace(/\s*(تومان|ریال)$/, "").trim();
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(ascii) && ascii.replace(/\D/g,"").length <= 15 ? Number(ascii) : value;
}

export async function saveWorkbook(name: string, tables: ExportTable[]) {
  if (!tables.length || !tables.some(t => t.rows.length)) throw new Error("داده‌ای برای خروجی وجود ندارد.");
  const { default: write } = await import("write-excel-file/browser");
  const used = new Set<string>();
  const sheets = tables.filter(t => t.rows.length).map(table => {
    const base = table.title.replace(/[\\/?:*[\]]/g, " ").trim().slice(0, 27) || "گزارش";
    let sheet = base;
    for (let n = 2; used.has(sheet); n++) sheet = base.slice(0, 25) + " " + n;
    used.add(sheet);
    const data: SheetData = [[...table.columns.map(value => ({ value, type: String, fontWeight: "bold" as const,
      fontFamily: "Tahoma", textColor: "#FFFFFF", backgroundColor: "#24453E", align: "right" as const, height: 30 }))]];
    for (const [index,row] of table.rows.entries()) data.push(table.columns.map((header, column): Cell => {
      const value = numericCell(header, row[column] ?? null);
      const style = { fontFamily:"Tahoma", fontSize:10, align:"right" as const, backgroundColor: index % 2 ? "#F1F5F3" : "#FFFFFF", height:22 };
      if (value === null) return { type: String, value: "", ...style };
      return typeof value === "number" ? { type: Number, value, format: "#,##0.###", ...style } : { type: String, value, ...style };
    }));
    return { sheet, data, rightToLeft:true, showGridLines:false, stickyRowsCount:1,
      columns:table.columns.map((header,i) => ({ width: Math.max(12, Math.min(52, Math.max(header.length, ...table.rows.slice(0, 150).map(row=>String(row[i] ?? "").length)) + 4)) })) };
  });
  const day = new Intl.DateTimeFormat("sv-SE", {timeZone:"Asia/Tehran"}).format(new Date());
  await write(sheets).toFile(`${name.replace(/[<>:"/\\|?*]/g, " ")}-${day}.xlsx`);
}

export function parseExportCsv(text: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (c === '"') {
      if (quoted && input[i+1] === '"') { field += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && c === ",") { row.push(field); field = ""; }
    else if (!quoted && (c === "\r" || c === "\n")) {
      if (c === "\r" && input[i+1] === "\n") i++;
      row.push(field); records.push(row); row = []; field = "";
    } else field += c;
  }
  if (quoted) throw new Error("پاسخ گزارش کامل نیست.");
  if (field || row.length) { row.push(field); records.push(row); }
  return records;
}
