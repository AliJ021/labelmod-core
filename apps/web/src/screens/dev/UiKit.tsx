/**
 * UI Kit — سطح تأیید بصری انسانی (docs/DESIGN_SYSTEM.md، «UI Kit»).
 *
 * فقط در توسعه و Build صریح آزمون/پیش‌نمایش (`VITE_LMC_UI_KIT=1`)
 * وجود دارد و فقط داخل پوستهٔ واردشده دیده می‌شود. هیچ درخواست شبکه‌ای
 * نمی‌زند: همهٔ داده‌ها **نمونهٔ ساختگی** و با همین برچسب‌اند، و «عمل
 * مالی ایمن» با شبیه‌ساز محلی اجرا می‌شود.
 */
import { useEffect, useState, type ReactNode } from "react";
import "../../styles/ui-kit.css";
import { Solid } from "../../components/Glass.tsx";
import { Icon, ICON_NAMES } from "../../components/Icon.tsx";
import { TabList, TabPanels, useTabsId } from "../../components/Tabs.tsx";
import { SearchField } from "../../components/SearchField.tsx";
import { ResultState } from "../../components/ResultState.tsx";
import { Accent, ACCENT_NAMES } from "../../components/ui/Accent.tsx";
import { BarChart } from "../../components/ui/BarChart.tsx";
import { Ltr } from "../../components/ui/Bidi.tsx";
import { Button, Field, Segmented, Switch } from "../../components/ui/Controls.tsx";
import { DataTable, type Column } from "../../components/ui/DataTable.tsx";
import { FilterBar } from "../../components/ui/FilterBar.tsx";
import { Dialog } from "../../components/ui/Dialog.tsx";
import { Kpi } from "../../components/ui/Kpi.tsx";
import { Money, Percent, Qty } from "../../components/ui/Money.tsx";
import { PageHeader, SectionHeader } from "../../components/ui/PageHeader.tsx";
import { SafeAction } from "../../components/ui/SafeAction.tsx";
import { Skeleton } from "../../components/ui/Skeleton.tsx";
import { STATUS, StatusBadge, type StatusState } from "../../components/ui/Status.tsx";
import { useToast } from "../../components/ui/Toast.tsx";
import { ApiError } from "../../lib/api.ts";
import { formatJalali } from "../../lib/format.ts";
import { getTheme, setTheme, type Theme } from "../../lib/theme.ts";

const SECTIONS = [
  ["foundation", "پایه"], ["numbers", "عدد و متن"], ["controls", "کنترل‌ها"], ["status", "وضعیت"],
  ["data", "جدول و نمودار"], ["layers", "لایه‌ها و عمل مالی"], ["states", "حالت‌ها"], ["icons", "آیکون"], ["motion", "حرکت و جلوه"],
] as const;

interface Row { id: string; ref: string; name: string; state: StatusState; amount: string; qty: string; date: string }
const ROWS: Row[] = [
  { id: "1", ref: "INV-1405-00017", name: "شلوار پارچه‌ای رگولار سرمه‌ای (نمونه)", state: "completed", amount: "12340000", qty: "2", date: "2026-09-16" },
  { id: "2", ref: "INV-1405-00018", name: "پیراهن کتان TR-1405-NAVY-XL (نمونه)", state: "pending", amount: "-2500000", qty: "1", date: "2026-09-17" },
  { id: "3", ref: "INV-1405-00019", name: "کت تک با نام بسیار طولانی برای آزمون شکستن سطر در عرض کم (نمونه)", state: "draft", amount: "0", qty: "1.5", date: "2026-09-18" },
  { id: "4", ref: "INV-1405-00020", name: "شال پشمی (نمونه)", state: "failed", amount: "987654321000", qty: "12", date: "2026-09-19" },
];

/** بخش‌ها کارت جدا نیستند: هر دسته یک سطح مات است و بخش‌ها با خط جدا می‌شوند. */
function Section({ id, title, description, children }: { id: string; title: string; description?: string; children: ReactNode }) {
  return <section className="kit-section" aria-labelledby={`kit-${id}`}>
    <SectionHeader id={`kit-${id}`} title={title} {...(description ? { description } : {})} />
    {children}
  </section>;
}

export function UiKit() {
  const tabs = useTabsId();
  const [section, setSection] = useState<(typeof SECTIONS)[number][0]>("foundation");
  const [theme, setThemeState] = useState<Theme>(getTheme());
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");
  return <div className="dashboard kit" data-density={density}>
    <PageHeader eyebrow="فقط توسعه و پیش‌نمایش آزمون" title="UI Kit لیبل مد"
      context="مرجع بصری زندهٔ توکن‌ها، primitiveها و الگوها. همهٔ داده‌های این صفحه نمونهٔ ساختگی‌اند."
      actions={<>
        <Segmented label="تم" value={theme} onChange={t => { setTheme(t); setThemeState(t); }}
          options={[{ key: "system", label: "سیستم" }, { key: "light", label: "روشن" }, { key: "dark", label: "تیره" }]} />
        <Segmented label="تراکم" value={density} onChange={setDensity}
          options={[{ key: "comfortable", label: "راحت" }, { key: "compact", label: "فشرده" }]} />
      </>} />
    <TabList id={tabs} items={SECTIONS.map(([key, label]) => ({ key, label }))} value={section} onChange={setSection} label="بخش‌های UI Kit" />
    <TabPanels id={tabs} items={SECTIONS.map(([key, label]) => ({ key, label }))} value={section} className="kit-panel">
      <Solid className="kit-sheet">
      {section === "foundation" ? <Foundation /> : section === "numbers" ? <Numbers /> : section === "controls" ? <Controls /> :
        section === "status" ? <Statuses /> : section === "data" ? <Data density={density} /> : section === "layers" ? <Layers /> :
        section === "states" ? <States /> : section === "icons" ? <Icons /> : <Motion />}
      </Solid>
    </TabPanels>
  </div>;
}

function Foundation() {
  const surfaces = ["bg-deep", "surface-solid", "surface-solid-2", "surface-glass", "surface-inverse", "accent", "accent-soft", "neutral-soft"];
  const inks = ["ink", "ink-2", "ink-3", "control-border", "chart-1", "chart-2"];
  const tones = ["good", "warn", "crit", "info"];
  return <div className="kit-stack">
    <Section id="type" title="نوشتار" description="Vazirmatn برای متن، IBM Plex Mono برای عدد و شناسه. فاصلهٔ حروف فارسی هرگز تغییر نمی‌کند.">
      <div className="kit-type">
        <p className="t-page-title">عنوان صفحه — فروش امروز</p>
        <p className="t-section-title">عنوان بخش — نیاز به رسیدگی</p>
        <p>متن اصلی برای توضیح و راهنما؛ طول سطر خوانا حدود ۶۸ نویسه است و سطر بلند در عرض کم می‌شکند.</p>
        <p className="t-label">برچسب فرم و سرستون</p>
        <p className="t-meta">فراداده: ثبت‌شده توسط مدیر آزمایشی · ۲۵ شهریور ۱۴۰۵</p>
        <p className="t-table">متن جدول با <Money rial="12340000" size="sm" /> و شناسهٔ <Ltr>TR-1405</Ltr></p>
      </div>
    </Section>
    <Section id="color" title="سطح و رنگ" description="دو سطح جدا: مات برای داده، شیشه فقط برای لایهٔ کنترلی. رنگ‌ها در palette.test.ts سنجیده می‌شوند.">
      <div className="kit-swatches">
        {[...surfaces, ...inks, ...tones].map(name => <div key={name} className="kit-swatch">
          <span className="kit-chip" style={{ background: `var(--${name})` }} />
          <Ltr>{`--${name}`}</Ltr>
        </div>)}
      </div>
    </Section>
    <Section id="space" title="فاصله، شعاع و ارتفاع">
      <div className="kit-row">
        {[1, 2, 3, 4, 5, 6, 7, 8].map(n => <div key={n} className="kit-space"><span style={{ inlineSize: `var(--s-${n})` }} /><Ltr>{`s-${n}`}</Ltr></div>)}
      </div>
      <div className="kit-row">
        {["xs", "sm", "md", "lg"].map(r => <div key={r} className="kit-radius" style={{ borderRadius: `var(--r-${r})` }}><Ltr>{`r-${r}`}</Ltr></div>)}
        {[1, 2, 3].map(e => <div key={e} className="kit-radius" style={{ boxShadow: `var(--elev-${e})` }}><Ltr>{`elev-${e}`}</Ltr></div>)}
      </div>
    </Section>
  </div>;
}

function Numbers() {
  return <div className="kit-stack">
    <Section id="money" title="نظام عدد مالی" description="رقم در برگ LTR با قلم مونو؛ منفی همیشه با علامت؛ صفر کم‌رنگ؛ «—» یعنی نامعلوم.">
      <dl className="kit-facts">
        <div><dt>مثبت</dt><dd><Money rial="12340000" /></dd></div>
        <div><dt>منفی</dt><dd><Money rial="-2500000" /></dd></div>
        <div><dt>منفی حسابداری</dt><dd><Money rial="-2500000" negative="parens" /></dd></div>
        <div><dt>صفر</dt><dd><Money rial="0" /></dd></div>
        <div><dt>بسیار بزرگ</dt><dd><Money rial="987654321000000" /></dd></div>
        <div><dt>فشرده (داشبورد)</dt><dd><Money rial="123456789000" compact /></dd></div>
        <div><dt>بدهکار</dt><dd><Money rial="4500000" side="debit" /></dd></div>
        <div><dt>بستانکار</dt><dd><Money rial="4500000" side="credit" /></dd></div>
        <div><dt>تخفیف</dt><dd><Money rial="-150000" /> <Percent value={12.5} /></dd></div>
        <div><dt>درصد رشد</dt><dd><Percent value={8.2} trend="up" /> · <Percent value={-3} trend="down" /> · <Percent value={0} trend="flat" /></dd></div>
        <div><dt>نامعلوم / بی‌مجوز</dt><dd><Money rial={null} /> · <Percent value={null} /></dd></div>
        <div><dt>تعداد</dt><dd><Qty value="1.500" unit="متر" /> · <Qty value="12" unit="عدد" /></dd></div>
        <div><dt>نامعلوم/بی‌مجوز</dt><dd><span className="kpi-unknown">—</span></dd></div>
      </dl>
      <p className="kit-sample">اندازه‌ها: <Money rial="12340000" size="sm" /> · <Money rial="12340000" /> · <Money rial="12340000" size="lg" /> · <Money rial="12340000" size="xl" /></p>
    </Section>
    <Section id="bidi" title="متن دوجهتی" description="LTR فقط روی کوچک‌ترین برگ؛ جمله فارسی جهت خودش را نگه می‌دارد.">
      <ul className="kit-list">
        <li>کالای <Ltr>TR-1405-NAVY-XL</Ltr> در انبار <Ltr>STORE</Ltr> موجودی ندارد.</li>
        <li>موبایل مشتری <Ltr>0912 345 6789</Ltr> ثبت شد.</li>
        <li>نشانی فاکتور <Ltr>https://shop.example.com/i/abcd…</Ltr> ارسال شد.</li>
        <li>فاکتور <Ltr>INV-1405-00017</Ltr> با مرجع بانکی <Ltr>REF 7788-99001</Ltr> به مبلغ <Money rial="12340000" /> تسویه شد.</li>
        <li>شناسهٔ تراکنش <Ltr>3f2a9c1e-77b4-4c1a-9e0d-5b6a1f2e8c90</Ltr> در دفتر پیدا نشد.</li>
        <li>کد کالای لاتین <Ltr mono={false}>Slim Fit Oxford Shirt</Ltr> — تخفیف <Percent value={15} /> — تاریخ {formatJalali("2026-09-16", true)}</li>
      </ul>
    </Section>
  </div>;
}

function Controls() {
  const [text, setText] = useState("شلوار");
  const [search, setSearch] = useState("");
  const [on, setOn] = useState(true);
  const [mode, setMode] = useState<"card" | "cash" | "more">("card");
  return <div className="kit-stack">
    <Section id="buttons" title="دکمه‌ها" description="یک کنش اصلی در هر ناحیه؛ کنش نهایی/خطرناک ظاهر جدا دارد.">
      <div className="kit-row">
        <Button variant="primary">ثبت فروش</Button>
        <Button>ذخیرهٔ پیش‌نویس</Button>
        <Button variant="quiet">انصراف</Button>
        <Button variant="danger" icon={<Icon name="alert" size="sm" />}>ابطال فاکتور</Button>
        <Button variant="primary" busy busyLabel="در حال ثبت…">ثبت</Button>
        <Button disabled>غیرفعال</Button>
        <button type="button" className="icon-button" aria-label="چاپ"><Icon name="print" /></button>
        <button type="button" className="icon-button" aria-label="تازه‌سازی"><Icon name="refresh" /></button>
        <button type="button" className="link">پیوند کنشی</button>
      </div>
    </Section>
    <Section id="inputs" title="ورودی‌ها">
      <div className="kit-grid">
        <Field label="نام کالا" hint="همان نامی که روی برچسب چاپ می‌شود."><input value={text} onChange={e => setText(e.target.value)} /></Field>
        <Field label="قیمت (تومان)" error="مبلغ باید عدد صحیح باشد؛ مثلاً ۱۵۰٬۰۰۰."><input defaultValue="۱۵۰٬۰۰۰٫۵" inputMode="numeric" /></Field>
        <Field label="شعبه"><select defaultValue="b1"><option value="b1">شعبه آزمایشی</option><option value="b2">شعبه دوم</option></select></Field>
        <Field label="یادداشت" optional><textarea defaultValue="" /></Field>
        <div className="field"><span className="field-label">جست‌وجو</span><SearchField label="جست‌وجوی کد یا نام کالا" value={search} onChange={setSearch} /></div>
        <div className="field">
          <span className="field-label">انتخاب‌ها</span>
          <label className="filter-check"><input type="checkbox" defaultChecked /> بایگانی‌شده‌ها هم</label>
          <label className="filter-check"><input type="radio" name="kit-r" defaultChecked /> امروز</label>
          <label className="filter-check"><input type="radio" name="kit-r" /> این هفته</label>
        </div>
        <Switch label="ارسال پیامک فاکتور" description="فقط با رضایت مشتری." checked={on} onChange={setOn} />
        <div className="field"><span className="field-label">روش پرداخت (الگوی آینده)</span>
          <Segmented label="روش پرداخت" value={mode} onChange={setMode} options={[{ key: "card", label: "کارت‌خوان" }, { key: "cash", label: "نقد" }, { key: "more", label: "روش‌های بیشتر" }]} />
        </div>
      </div>
    </Section>
  </div>;
}

function Statuses() {
  return <div className="kit-stack">
    <Section id="status" title="زبان واحد وضعیت" description="هر برچسب کسب‌وکاری به یکی از این حالت‌ها نگاشت می‌شود. شکل + متن، نه فقط رنگ.">
      <div className="kit-row">{(Object.keys(STATUS) as StatusState[]).map(s => <StatusBadge key={s} state={s} />)}</div>
      <div className="kit-row">
        <StatusBadge state="draft" label="فاکتور پیش‌نویس" />
        <StatusBadge state="attention" label="چک سررسیدگذشته" />
        <StatusBadge state="completed" label="دوره بسته شد" />
        <StatusBadge state="pending" label="در صف ارسال به سایت" quiet />
      </div>
    </Section>
    <Section id="kpi" title="کارت شاخص">
      <div className="kpis kpis--band kit-bordered">
        <Kpi label="فروش" icon="receipt" emphasis value={<Money rial="12340000" size="xl" />} note="۱۲ فاکتور · ۱ مرجوعی" />
        <Kpi label="وجه دریافتی" icon="card" value={<Money rial="11000000" size="xl" />} state="warning" note={<><Money rial="1340000" size="sm" /> هنوز نرسیده</>} />
        <Kpi label="سود" icon="chart" value={<span className="kpi-unknown">—</span>} state="warning" note="برای دیدن سود، دسترسی بهای تمام‌شده لازم است" />
      </div>
    </Section>
  </div>;
}

function Data({ density }: { density: "comfortable" | "compact" }) {
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "amount", dir: "desc" });
  const [selected, setSelected] = useState<Set<string>>(new Set(["2"]));
  const rows = [...ROWS].sort((a, b) => {
    const d = sort.key === "amount" ? (BigInt(a.amount) < BigInt(b.amount) ? -1 : BigInt(a.amount) > BigInt(b.amount) ? 1 : 0) : a.date.localeCompare(b.date);
    return sort.dir === "asc" ? d : -d;
  });
  const columns: Column<Row>[] = [
    { key: "ref", header: "شماره", cell: r => <Ltr>{r.ref}</Ltr> },
    { key: "name", header: "شرح", cell: r => r.name },
    { key: "date", header: "تاریخ", sortable: true, cell: r => formatJalali(r.date) },
    { key: "state", header: "وضعیت", cell: r => <StatusBadge state={r.state} /> },
    { key: "qty", header: "تعداد", numeric: true, cell: r => <Qty value={r.qty} /> },
    { key: "amount", header: "مبلغ", numeric: true, sortable: true, cell: r => <Money rial={r.amount} negative="parens" /> },
  ];
  const bars = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22].map((h, i) => {
    const value = BigInt([0, 0, 12, 30, 18, 9, 22, 41, 38, 55, 72, 64, 40, 15, 0][i] ?? 0) * 100000n;
    return { key: String(h), label: new Intl.NumberFormat("fa-IR").format(h), value, display: `${(value / 10n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "٬")} تومان` };
  });
  return <div className="kit-stack">
    <Section id="table" title="جدول مالی" description="سرستون چسبان، ستون عددی هم‌تراز، اسکرول داخلی، انتخاب، مرتب‌سازی. روی موبایل به کارت تبدیل می‌شود و هیچ ستونی حذف نمی‌شود.">
      <DataTable caption="فاکتورهای نمونه" columns={columns} rows={rows} rowKey={r => r.id} density={density} stack
        sort={sort} onSort={key => setSort(s => ({ key, dir: s.key === key && s.dir === "desc" ? "asc" : "desc" }))}
        selected={selected} onSelect={(key, next) => setSelected(s => { const n = new Set(s); if (next) n.add(key); else n.delete(key); return n; })}
        rowActions={() => <button type="button" className="btn btn--quiet">جزئیات</button>}
        foot={{ label: "جمع نمونه", cells: { amount: <Money rial={ROWS.reduce((a, r) => a + BigInt(r.amount), 0n)} negative="parens" /> } }} />
    </Section>
    <Section id="filters" title="نوار فیلتر" description="فیلدها در یک ردیف فشرده، خلاصهٔ متنی فیلتر فعال و بازنشانی فقط وقتی چیزی عوض شده. مقدارها در نشانی می‌مانند.">
      <FilterBar label="فیلتر نمونه" summary={<>بازه: <strong>{formatJalali("2026-09-01")} تا {formatJalali("2026-09-16")}</strong> · همه شعبه‌ها</>} onReset={() => {}}>
        <Field label="از تاریخ" hint={formatJalali("2026-09-01")}><input defaultValue="2026-09-01" className="num" /></Field>
        <Field label="تا تاریخ" error="«تا تاریخ» نباید پیش از «از تاریخ» باشد."><input defaultValue="2026-08-01" className="num" /></Field>
        <Field label="شعبه"><select defaultValue=""><option value="">همه شعبه‌ها</option></select></Field>
      </FilterBar>
    </Section>
    <Section id="table-states" title="جدول: بارگذاری و خالی">
      <div className="kit-grid kit-grid--2">
        <DataTable caption="در حال بارگذاری" columns={columns.slice(0, 3)} rows={[]} rowKey={r => r.id} loading />
        <DataTable caption="بدون نتیجه" columns={columns.slice(0, 3)} rows={[]} rowKey={r => r.id} empty={{ title: "برای این فیلتر فاکتوری نیست.", description: "بازهٔ تاریخ را بزرگ‌تر کنید." }} />
      </div>
    </Section>
    <Section id="chart" title="نمودار" description="روی سطح مات، با جدول پنهان برای صفحه‌خوان و خلاصهٔ متنی. داده نمونه است.">
      <BarChart title="فروش خالص هر ساعت — نمونه" labelHeader="ساعت" valueHeader="فروش" summary="بیشترین فروش: ساعت ۱۸ (نمونه)" bars={bars} />
    </Section>
  </div>;
}

function Layers() {
  const [dialog, setDialog] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [outcome, setOutcome] = useState<"success" | "failed" | "unknown">("success");
  const [done, setDone] = useState(false);
  const toast = useToast();
  return <div className="kit-stack">
    <Section id="dialogs" title="Dialog، Sheet و Toast" description="Dialog بومی با برگشت فوکوس؛ Sheet روی موبایل از پایین و روی دسکتاپ از کنار. Toast فقط بازخورد گذرا.">
      <div className="kit-row">
        <Button onClick={() => setDialog(true)}>باز کردن Dialog</Button>
        <Button onClick={() => setSheet(true)}>باز کردن Sheet</Button>
        <Button onClick={() => toast("تنظیم ذخیره شد.")}>Toast موفق</Button>
        <Button onClick={() => toast("در صف ارسال به سایت است.", "pending")}>Toast در انتظار</Button>
      </div>
      <Dialog open={dialog} onClose={() => setDialog(false)} title="تغییر شعبهٔ پیش‌فرض" description="این تغییر فقط روی همین دستگاه اثر دارد."
        footer={<><Button variant="primary" onClick={() => setDialog(false)}>ذخیره</Button><Button variant="quiet" onClick={() => setDialog(false)}>انصراف</Button></>}>
        <Field label="شعبه"><select defaultValue="b1"><option value="b1">شعبه آزمایشی</option></select></Field>
      </Dialog>
      <Dialog open={sheet} onClose={() => setSheet(false)} variant="sheet" title="فیلترهای فاکتور">
        <Field label="وضعیت"><select defaultValue="all"><option value="all">همه</option><option value="draft">پیش‌نویس</option></select></Field>
        <Field label="از تاریخ"><input defaultValue="۱ شهریور ۱۴۰۵" /></Field>
      </Dialog>
    </Section>
    <Section id="safe" title="عمل مالی ایمن" description="خلاصه ← پیامد ← تأیید ← در حال اجرا ← نتیجه. نتیجهٔ نامعلوم «ارسال دوباره» ندارد؛ فقط بررسی وضعیت.">
      <Segmented label="نتیجهٔ شبیه‌سازی" value={outcome} onChange={o => { setOutcome(o); setDone(false); }}
        options={[{ key: "success", label: "موفق" }, { key: "failed", label: "رد سرور" }, { key: "unknown", label: "نامعلوم" }]} />
      <div className="kit-row">
        <SafeAction key={outcome} trigger="بستن دوره (نمونه)" title="بستن دورهٔ سایت — نمونه" triggerVariant="button"
          summary={<dl className="safe-facts"><div><dt>فاکتورها</dt><dd>۱۲</dd></div><div><dt>مبلغ قابل ثبت</dt><dd><Money rial="12340000" /></dd></div></dl>}
          consequence="درآمد و بهای تمام‌شدهٔ این دوره در دفتر ثبت می‌شود و این کار فقط با سند معکوس اصلاح‌پذیر است."
          confirmLabel="بستن دوره و ثبت در دفتر" pendingLabel="در حال بستن…"
          run={() => new Promise<void>((resolve, reject) => window.setTimeout(() => {
            if (outcome === "success") resolve();
            else if (outcome === "failed") reject(new ApiError(409, "rule_violation", "دوره ثبت این فاکتور قبلاً بسته شده است.", "kit-ref-0001"));
            else reject(new TypeError("network"));
          }, 700))}
          verify={() => new Promise<boolean>(resolve => window.setTimeout(() => resolve(true), 500))}
          onDone={o => { setDone(true); toast(o === "verified" ? "بررسی شد: دوره بسته شده است." : "دوره بسته شد."); }} />
        {done ? <StatusBadge state="completed" label="دوره بسته شد (نمونه)" /> : null}
      </div>
    </Section>
  </div>;
}

function States() {
  return <div className="kit-stack">
    <Section id="loading" title="بارگذاری">
      <div className="kit-grid kit-grid--2">
        <Skeleton lines={4} />
        <div className="kpis"><Skeleton variant="kpi" lines={2} /></div>
      </div>
    </Section>
    <Section id="results" title="خالی، خطا، مجوز، آفلاین و موفقیت" description="تصویر سه‌بعدی فقط برای لحظه‌های معنادار؛ جست‌وجوی بی‌نتیجه تصویر نمی‌گیرد.">
      <div className="kit-grid kit-grid--3">
        <div className="kit-state"><ResultState accent="ledger" title="هنوز گزارشی ساخته نشده است." description="با اولین فاکتور نهایی، گزارش اینجا پر می‌شود." /></div>
        <div className="kit-state"><ResultState title="برای این جست‌وجو کالایی پیدا نشد." actionLabel="پاک‌کردن جست‌وجو" onAction={() => {}} /></div>
        <div className="kit-state"><ResultState kind="error" title="فهرست خوانده نشد." description="اتصال را بررسی کنید." reference="req-7f3a91" actionLabel="تلاش دوباره" onAction={() => {}} /></div>
        <div className="kit-state"><ResultState accent="shield" title="این بخش دسترسی «مدیریت خزانه» می‌خواهد." description="از مدیر بخواهید دسترسی را در «مجوزها» بدهد." /></div>
        <div className="kit-state"><ResultState kind="denied" title="این گزارش دسترسی «بینش مشتری» می‌خواهد." description="حالت بی‌مجوز: قفل + متن، بدون تلاش دوباره." /></div>
        <div className="kit-state"><div className="result-state"><StatusBadge state="offline" /><p className="muted">اتصال این دستگاه قطع است. نتیجهٔ کارهای نیمه‌تمام را پس از اتصال بررسی کنید.</p></div></div>
        <div className="kit-state"><ResultState accent="success" title="بکاپ دیشب با موفقیت ساخته شد (نمونه)." /></div>
      </div>
    </Section>
  </div>;
}

function Icons() {
  return <div className="kit-stack">
    <Section id="icons2d" title="آیکون کارکردی (دوبعدی)" description="یک خانواده، شبکهٔ ۲۴، خط ۱٫۷. برای ناوبری، جدول، فرم و کنترل.">
      <ul className="kit-icons">{ICON_NAMES.map(n => <li key={n}><Icon name={n} /><Ltr>{n}</Ltr></li>)}</ul>
    </Section>
    <Section id="icons3d" title="نشانهٔ سه‌بعدی تأکیدی" description="فقط حالت خالی، موفقیت، بکاپ، امنیت و گزارش. تنبل‌بار و جدا از Bundle؛ هرگز روی دکمه یا ناوبری.">
      <ul className="kit-icons kit-icons--accent">{ACCENT_NAMES.map(n => <li key={n}><Accent name={n} /><Ltr>{n}</Ltr></li>)}</ul>
    </Section>
  </div>;
}

function Motion() {
  const [replay, setReplay] = useState(0);
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const m = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(m.matches);
    update(); m.addEventListener("change", update);
    return () => m.removeEventListener("change", update);
  }, []);
  return <div className="kit-stack">
    <Section id="motion" title="حرکت" description="کارکردی (باز شدن، پیمایش) > بازخورد (فشار، نتیجه) > تزئینی. ۱۵۰ تا ۳۰۰ میلی‌ثانیه، فقط transform و opacity.">
      <p className="kit-sample">{reduced ? <StatusBadge state="active" label="کاهش حرکت روشن است: همهٔ رده‌ها خاموش" /> : <StatusBadge state="completed" label="حرکت مجاز است" quiet />}</p>
      <div className="kit-row"><Button onClick={() => setReplay(r => r + 1)}>پخش دوباره</Button></div>
      <div className="kit-grid kit-grid--3" key={replay}>
        <div className="kit-motion m-fade-in">محو — بازخورد</div>
        <div className="kit-motion m-rise">برآمدن — ورود محتوا</div>
        <div className="kit-motion m-rise" style={{ animationDelay: "60ms" }}>برآمدن با تأخیر کوتاه</div>
      </div>
    </Section>
    <Section id="signature" title="جلوهٔ امضا و جایگزین" description="نور فلزی آرام فقط در ورود و قفل حرکت می‌کند. صفحه‌های داده زمینهٔ ساکن دارند. WebGL در این مرحله ساخته نشده؛ جایگزین CSS همین است.">
      <div className="kit-signature" aria-hidden="true"><i /><i /><i /></div>
    </Section>
  </div>;
}
