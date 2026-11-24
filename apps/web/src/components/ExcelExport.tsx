import { useEffect, useState } from "react";
import { saveWorkbook, type ExportTable } from "../lib/sheet-export.ts";

export function ExcelButton({ name, load, label = "اکسل همهٔ نتایج", full = true }: {
  name: string; load: () => ExportTable[] | Promise<ExportTable[]>; label?: string; full?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error,setError] = useState("");
  return <span className="excel-export"><button className="btn btn--quiet" type="button" data-full-xlsx={full || undefined}
    disabled={busy} onClick={async () => {
      setBusy(true); setError("");
      try { await saveWorkbook(name, await load()); }
      catch (e) { setError(e instanceof Error ? e.message : "ساخت اکسل ناموفق بود."); }
      finally { setBusy(false); }
    }}>{busy ? "در حال ساخت اکسل…" : label}</button>{error && <small role="alert">{error}</small>}</span>;
}

function eligibleTables(root: HTMLElement) {
  return [...root.querySelectorAll("table")].filter(t => t.getClientRects().length && t.tHead && t.tBodies[0]?.rows.length);
}

function exportTable(table: HTMLTableElement, fallback: string): ExportTable {
  const headers = Array.from(table.tHead!.rows[table.tHead!.rows.length-1]!.cells, cell => cell.innerText.trim());
  const indices = headers.map((name,i) => name && !/^(عملیات|انتخاب|چاپ|ویرایش)$/.test(name) ? i : -1).filter(i=>i>=0);
  const rows = [...table.tBodies].flatMap(b => [...b.rows].filter(r => r.getClientRects().length && r.cells.length === headers.length)
    .map(r => indices.map(i => {
      const cell = r.cells[i]!;
      return cell.innerText.trim();
    })));
  return { title:table.caption?.textContent?.trim() || fallback, columns:indices.map(i=>headers[i]!), rows };
}

export function VisibleExcel({ zone, title }: { zone: string; title:string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const root = document.getElementById("workspace-content");
    if (!root) return;
    let frame = 0;
    const scan = () => { frame = 0; setVisible(eligibleTables(root).length > 0 && !root.querySelector("[data-full-xlsx]")); };
    const observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(scan); });
    scan(); observer.observe(root, { childList:true, subtree:true, attributes:true, attributeFilter:["hidden","aria-hidden"] });
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [zone]);
  return visible ? <ExcelButton name={title} label="اکسل جدول‌های این صفحه" full={false} load={() => {
    const root = document.getElementById("workspace-content")!;
    return eligibleTables(root).map(t=>exportTable(t,title));
  }} /> : null;
}
