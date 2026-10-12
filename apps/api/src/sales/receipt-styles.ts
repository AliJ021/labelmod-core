/** رسید فروشگاه، مطابق نمونهٔ مالک: جدول خط‌کشی‌شده روی رول ۸۰ میلی‌متری. */
export const RECEIPT_STYLES = `
  :root { color-scheme: light; --ink: #000; --paper: #fff; --muted: #454545; --desk: #eeece7; }
  * { box-sizing: border-box; }
  html { min-height: 100%; background: var(--desk); }
  body { margin: 0; padding: 24px 12px; font-family: Vazirmatn, Tahoma, "Segoe UI", sans-serif; color: var(--ink); font-size: 13px; line-height: 1.5; }
  .sheet { width: 100%; max-width: 400px; margin: 0 auto; padding: 24px 20px; background: var(--paper); box-shadow: 0 4px 24px #00000018; }
  .head { text-align: center; }
  .logo { display: block; width: auto; height: auto; max-width: 76%; max-height: 110px; object-fit: contain; margin: 0 auto; }
  .logo--black { filter: brightness(0); }
  .logo--gray { filter: grayscale(1) contrast(1.2); }
  .brand { font-size: 25px; font-weight: 800; overflow-wrap: anywhere; }
  .shop { margin-top: 6px; font-size: 14px; font-weight: 600; }
  .doc { margin-top: 6px; font-size: 12px; }
  .meta { display: grid; grid-template-columns: 1fr; gap: 3px; margin: 16px 0 12px; }
  .cell { min-width: 0; display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 6px; align-items: baseline; }
  .meta dt { font-size: 11px; color: var(--muted); }
  .meta dd { text-align: left; margin: 0; font-size: 11px; overflow-wrap: anywhere; }
  .docno { font-family: Arial, sans-serif; font-variant-numeric: tabular-nums; }
  .proforma-note { padding: 6px; border: 1px solid; margin-top: 10px; text-align: center; }
  .panel-heading { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 5px; }
  .panel-heading h2 { margin: 0; font-size: 11px; font-weight: 400; }
  .panel-heading span { font-size: 10px; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { text-align: right; vertical-align: middle; }
  .items col.qty { width: 16%; }
  .items col.total { width: 31%; }
  .items th, .items td { border: 1px solid; padding: 6px; }
  .items thead th { font-size: 11px; font-weight: 700; }
  .items th.qty, .items td.qty { text-align: center; }
  .name { font-size: 12px; font-weight: 500; line-height: 1.5; overflow-wrap: anywhere; }
  .name small { font-size: 10px; font-weight: 400; }
  .name small::before { content: " · "; }
  .unit-line, .line-discount { font-size: 9px; font-weight: 400; color: var(--muted); }
  .num { text-align: left; font-family: Arial, Tahoma, sans-serif; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .qty { font-family: Arial, Tahoma, sans-serif; font-variant-numeric: tabular-nums; white-space: nowrap; }
  th.num, th.qty { font-family: inherit; }
  .total { font-size: 12px; }
  .summary-panel { border: 1px solid; border-top: 0; padding: 6px; }
  .totals th, .totals td { padding: 4px 0; font-weight: 400; }
  .totals th { width: 35%; }
  .totals td { width: 65%; }
  .totals .incl { font-size: 10px; }
  .totals .grand th, .totals .grand td { padding-top: 8px; border-top: 1px solid; font-weight: 700; }
  .totals .grand td { font-size: 18px; }
  .totals .grand small, .totals .due small { font-family: Tahoma, sans-serif; font-size: 10px; font-weight: 400; }
  .totals .due th, .totals .due td { font-weight: 700; }
  .settle { text-align: center; font-size: 10px; margin-top: 5px; }
  .foot { text-align: center; margin-top: 12px; font-size: 11px; line-height: 1.8; overflow-wrap: anywhere; }
  .foot strong { display: block; font-size: 12px; }
  .foot .unit { font-size: 10px; }
  .print-bar { margin: 20px auto 0; max-width: 400px; text-align: center; }
  .print-btn { min-height: 44px; padding: 10px 24px; font: inherit; font-weight: 700; border: 1px solid; border-radius: 8px; background: #000; color: #fff; cursor: pointer; }
  .print-btn:focus-visible { outline: 2px solid; outline-offset: 3px; }
  .print-note { font-size: 11px; color: var(--muted); }
  @page { margin: 0; }
  @media print {
    .print-bar { display: none !important; }
    html, body { background: #fff; margin: 0; padding: 0; }
    .sheet { width: 72mm; max-width: 72mm; margin: 0 auto; padding: 3mm 0 4mm; box-shadow: none; font-size: 9pt; }
    .logo { max-width: 54mm; max-height: 24mm; }
    .shop { font-size: 9pt; margin-top: 1mm; }
    .brand { font-size: 18pt; }
    .doc { font-size: 8pt; margin-top: 1mm; }
    .meta { gap: 1mm 2mm; margin: 3mm 0 2mm; }
    .cell { grid-template-columns: 23mm minmax(0, 1fr); gap: 1mm; }
    .meta dt, .meta dd, .panel-heading h2 { font-size: 7pt; }
    .panel-heading { margin-bottom: 1mm; }
    .panel-heading span { font-size: 6.5pt; }
    .items th, .items td { padding: 1mm; border-width: .2mm; }
    .items thead th { font-size: 7pt; }
    .name, .total, .qty { font-size: 8pt; }
    .name small, .unit-line, .line-discount { font-size: 6.5pt; }
    .meta dt, .unit-line, .line-discount { color: #000; }
    .summary-panel { border-width: .2mm; padding: 1mm; }
    .totals th, .totals td { padding: .8mm 0; font-size: 8pt; }
    .totals .incl th, .totals .incl td { font-size: 7pt; }
    .totals .grand th, .totals .grand td { padding-top: 1.5mm; border-width: .2mm; }
    .totals .grand td { font-size: 12pt; }
    .totals .grand small, .totals .due small { font-size: 7pt; }
    .foot { margin-top: 2mm; font-size: 7.5pt; }
    .foot strong { font-size: 8pt; }
    .foot .unit, .settle { font-size: 7pt; }
    .item, tr, .meta, .summary-panel { break-inside: avoid; }
    .panel-heading { break-after: avoid; }
    thead { display: table-header-group; }
  }
`;
