/**
 * رسید فروشگاه روی رول ۸۰ میلی‌متری (محتوای چاپ‌پذیر ۷۲mm).
 *
 * فقط سیاه روی سفید؛ سلسله‌مراتب با اندازه و وزن قلم. هیچ فونت بیرونی بار
 * نمی‌شود (CSP صفحه `font-src` ندارد): فارسی از فونت سیستم و شعار لاتین از
 * خانوادهٔ سنس سیستم. کادر اقلام گوشهٔ گرد دارد و خط‌های داخلی‌اش با جدول
 * `border-collapse` کشیده می‌شوند؛ لبهٔ بیرونی فقط از خودِ کادر می‌آید تا
 * دوبار کشیده نشود.
 */
export const RECEIPT_STYLES = `
  :root { color-scheme: light; --ink: #000; --paper: #fff; --muted: #454545; --desk: #eeece7; }
  * { box-sizing: border-box; }
  html { min-height: 100%; background: var(--desk); }
  body { margin: 0; padding: 24px 12px; font-family: Vazirmatn, Tahoma, "Segoe UI", sans-serif; color: var(--ink); font-size: 13px; line-height: 1.5; }
  .sheet { width: 100%; max-width: 400px; margin: 0 auto; padding: 24px 20px; background: var(--paper); box-shadow: 0 4px 24px #00000018; }
  .head { text-align: center; }
  .logo { display: block; width: 86%; max-width: 86%; height: auto; max-height: 200px; object-fit: contain; margin: 0 auto; }
  .logo--black { filter: brightness(0); }
  .logo--gray { filter: grayscale(1) contrast(1.2); }
  .brand { font-size: 25px; font-weight: 800; overflow-wrap: anywhere; }
  .shop { margin-top: 6px; font-size: 16px; font-weight: 800; }
  .doc { margin-top: 4px; font-size: 12px; font-weight: 600; }
  .meta { display: grid; grid-template-columns: 1fr; gap: 4px; margin: 14px 0 12px; }
  .cell { min-width: 0; display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 6px; align-items: baseline; }
  .meta dt { font-size: 12px; font-weight: 600; }
  .meta dd { text-align: left; margin: 0; font-size: 14px; font-weight: 800; overflow-wrap: anywhere; }
  .docno { font-family: Arial, sans-serif; font-variant-numeric: tabular-nums; }
  .proforma-note { padding: 6px; border: 1px solid; margin-top: 10px; text-align: center; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { text-align: right; vertical-align: middle; }
  .items-box { border: 1.5px solid; border-radius: 8px; overflow: hidden; }
  .items col.qty { width: 16%; }
  .items th, .items td { border: 1px solid; padding: 6px; }
  .items tr > :first-child { border-inline-start: 0; }
  .items tr > :last-child { border-inline-end: 0; }
  .items thead tr > * { border-top: 0; }
  .items tfoot tr > * { border-bottom: 0; }
  .items thead th { font-size: 12px; font-weight: 700; }
  .items th.qty, .items td.qty { text-align: center; }
  .items th.num, .items td.num { text-align: center; vertical-align: middle; }
  .items tfoot th, .items tfoot td { border-top-width: 1.5px; font-weight: 800; }
  .name { font-size: 13px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
  .name small { font-size: 11px; font-weight: 400; }
  .name small::before { content: " · "; }
  .num { text-align: left; font-family: Arial, Tahoma, sans-serif; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .qty { font-family: Arial, Tahoma, sans-serif; font-variant-numeric: tabular-nums; white-space: nowrap; font-weight: 700; }
  th.num, th.qty { font-family: inherit; }
  .total { font-size: 13px; font-weight: 700; }
  .summary { margin-top: 6px; }
  .totals th, .totals td { padding: 4px 0; font-weight: 600; }
  .totals th { width: 35%; }
  .totals td { width: 65%; }
  .totals .incl { font-size: 11px; }
  .totals .grand th, .totals .grand td { padding-top: 8px; border-top: 1.5px solid; font-weight: 800; }
  .totals .grand td { font-size: 19px; }
  .totals .grand small { font-family: Tahoma, sans-serif; font-size: 11px; font-weight: 600; }
  .foot { text-align: center; margin-top: 12px; font-size: 12px; line-height: 1.8; overflow-wrap: anywhere; }
  .foot strong { display: block; font-size: 13px; }
  .foot .policy { font-weight: 700; }
  .foot .site, .foot .tel bdi { font-family: Arial, sans-serif; font-weight: 600; }
  .slogan { margin-top: 6px; font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 14px; font-weight: 400; letter-spacing: .02em; unicode-bidi: isolate; }
  .slogan b { font-weight: 800; letter-spacing: .06em; }
  .print-bar { margin: 20px auto 0; max-width: 400px; text-align: center; }
  .print-btn { min-height: 44px; padding: 10px 24px; font: inherit; font-weight: 700; border: 1px solid; border-radius: 8px; background: #000; color: #fff; cursor: pointer; }
  .print-btn:focus-visible { outline: 2px solid; outline-offset: 3px; }
  .print-note { font-size: 11px; color: var(--muted); }
  @page { margin: 0; }
  @media print {
    .print-bar { display: none !important; }
    html, body { background: #fff; margin: 0; padding: 0; }
    .sheet { width: 72mm; max-width: 72mm; margin: 0 auto; padding: 3mm 0 4mm; box-shadow: none; font-size: 9pt; }
    .logo { width: 62mm; max-width: 62mm; max-height: 40mm; }
    .shop { font-size: 11pt; margin-top: 1.5mm; }
    .brand { font-size: 18pt; }
    .doc { font-size: 8.5pt; margin-top: .5mm; }
    .meta { gap: 1mm; margin: 3mm 0 2.5mm; }
    .cell { grid-template-columns: 22mm minmax(0, 1fr); gap: 1mm; }
    .meta dt { font-size: 8.5pt; }
    .meta dd { font-size: 10pt; }
    .items-box { border-width: .35mm; border-radius: 2mm; }
    .items th, .items td { padding: 1.2mm 1mm; border-width: .2mm; }
    .items tfoot th, .items tfoot td { border-top-width: .35mm; }
    .items thead th { font-size: 8pt; }
    .name, .qty { font-size: 8.5pt; }
    .total { font-size: 9pt; }
    .name small { font-size: 7pt; }
    .totals th, .totals td { padding: .8mm 0; font-size: 8.5pt; }
    .totals .incl th, .totals .incl td { font-size: 7.5pt; }
    .totals .grand th, .totals .grand td { padding-top: 1.5mm; border-width: .35mm; }
    .totals .grand td { font-size: 13pt; }
    .totals .grand small { font-size: 7.5pt; }
    .foot { margin-top: 2.5mm; font-size: 8pt; }
    .foot strong { font-size: 8.5pt; }
    .slogan { margin-top: 1.5mm; font-size: 9.5pt; }
    .item, tr, .meta, .summary, .foot { break-inside: avoid; }
    thead { display: table-header-group; }
    tfoot { display: table-row-group; }
  }
`;
