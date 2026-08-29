/**
 * داشبورد — ناحیه شیشه کامل.
 *
 * ADR-002 اینجا را «شیشه کامل» گذاشته و دلیلش عملیاتی است: این صفحه
 * **خوانده می‌شود، نه عمل**. روی دسکتاپ باز می‌شود، کسی پشتش صف
 * نایستاده، و هیچ تصمیمی در کسری از ثانیه گرفته نمی‌شود.
 *
 * `.claude/rules/design.md` یک قاعده زبانی هم گذاشته که اینجا اجرا
 * می‌شود: **فروش**، **وجه دریافتی** و **سود** هر کدام برچسب صریح خودشان
 * را دارند و هرگز زیر «دخل» جمع نمی‌شوند. سه عدد متفاوت‌اند و یکی
 * کردنشان همان جایی است که مغازه‌دار فکر می‌کند پول دارد ولی ندارد.
 */
import { Glass, Solid } from "../components/Glass.tsx";
import { toman } from "../lib/money.ts";

/** داده نمونه تا وقتی مسیر گزارش API ساخته شود. */
const TODAY = {
  sales: 184_500_000n,
  received: 151_000_000n,
  profit: 47_300_000n,
  invoices: 23,
  returns: 2,
};

const HOURS = [3, 5, 4, 8, 12, 14, 11, 17, 21, 16, 9, 6];

export function Dashboard() {
  return (
    <div className="stack" style={{ gap: "var(--s-5)" }}>
      <Glass as="section" live className="pad">
        <header className="row between">
          <div>
            <h1 style={{ fontSize: "1.35rem" }}>امروز</h1>
            <p className="muted" style={{ margin: 0 }}>
              شعبه اصلی · شنبه ۷ شهریور
            </p>
          </div>
          <span className="pill">
            <Dot tone="good" />
            صندوق باز
          </span>
        </header>

        {/*
          سه کارت، سه برچسب صریح. کارت‌ها داخل شیشه‌اند، پس `Glass`
          خودش به تینت تبدیلشان می‌کند — بلور دوم نمی‌گیرند.
        */}
        <div className="kpis">
          <Kpi label="فروش" value={toman(TODAY.sales)} note={`${TODAY.invoices} فاکتور`} />
          <Kpi
            label="وجه دریافتی"
            value={toman(TODAY.received)}
            note={`${toman(TODAY.sales - TODAY.received)} تومان نسیه`}
            tone="warn"
          />
          <Kpi label="سود" value={toman(TODAY.profit)} note="پس از بهای تمام‌شده" tone="good" />
        </div>
      </Glass>

      <div className="two">
        <Glass as="section" className="pad">
          <h2 style={{ fontSize: "1rem" }}>فروش در ساعت</h2>
          {/*
            نمودار روی سطح **مات** می‌نشیند، نه شیشه — حتی اینجا که
            کارتِ دربرگیرنده شیشه‌ای است.

            دلیلش سنجیده شده، نه سلیقه: رنگ نمودار در تم روشن روی
            شیشه‌ی روی مِش تضاد ۲٫۷۷:۱ می‌دهد و از حداقل ۳:۱ رد
            می‌شود؛ روی سطح مات ۳٫۵۳:۱ است. `test/palette.test.ts`
            همین را قفل کرده.

            ADR-002 هم گزارش مالی را «متوسط — فقط نوار و کارت» گذاشته
            بود؛ این همان قاعده در عمل است.
          */}
          <Solid className="chart-panel">
            <Bars data={HOURS} />
          </Solid>
        </Glass>

        <Glass as="section" className="pad">
          <h2 style={{ fontSize: "1rem" }}>نیاز به رسیدگی</h2>
          <ul className="tasks">
            <Task tone="crit" label="۳ فروش سایت هنوز به دفتر نرفته" action="بستن دوره" />
            <Task tone="warn" label="۲ چک تا ۵ روز دیگر سررسید دارد" action="دیدن چک‌ها" />
            <Task tone="good" label="شمارش صندوق دیروز خواند" action="گزارش" />
          </ul>
        </Glass>
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  tone?: "good" | "warn";
}) {
  return (
    <Glass radius="md" className="kpi">
      <span className="muted">{label}</span>
      <strong className="num kpi-value">{value}</strong>
      <span className="muted small">
        {tone ? <Dot tone={tone} /> : null}
        {note}
      </span>
    </Glass>
  );
}

/**
 * نمودار میله‌ای، بدون کتابخانه.
 *
 * دوازده مستطیل با ارتفاع درصدی، به‌علاوه یک جدول پنهان برای
 * صفحه‌خوان — چون نمودار بدون معادل متنی، برای کسی که نمی‌بیندش
 * وجود ندارد.
 */
function Bars({ data }: { data: number[] }) {
  const max = Math.max(...data, 1);
  return (
    <>
      <div className="bars" role="img" aria-label="نمودار فروش ساعتی">
        {data.map((v, i) => (
          <span
            key={i}
            className="bar"
            style={{ height: `${Math.round((v / max) * 100)}%` }}
            title={`ساعت ${9 + i}: ${v} فاکتور`}
          />
        ))}
      </div>
      <table className="sr-only">
        <caption>فروش ساعتی</caption>
        <tbody>
          {data.map((v, i) => (
            <tr key={i}>
              <th scope="row">ساعت {9 + i}</th>
              <td>{v} فاکتور</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Task({
  tone,
  label,
  action,
}: {
  tone: "good" | "warn" | "crit";
  label: string;
  action: string;
}) {
  return (
    <li>
      <Dot tone={tone} />
      <span>{label}</span>
      <button type="button" className="link">
        {action}
      </button>
    </li>
  );
}

/**
 * نشانه وضعیت.
 *
 * `.claude/rules/design.md`: رنگ هرگز به‌تنهایی حامل معنا نیست. پس
 * شکل هم فرق می‌کند و متن هم همیشه کنارش هست — برای کوررنگی و برای
 * صفحه‌خوان.
 */
function Dot({ tone }: { tone: "good" | "warn" | "crit" }) {
  const shape = { good: "●", warn: "▲", crit: "■" }[tone];
  const name = { good: "خوب", warn: "هشدار", crit: "بحرانی" }[tone];
  return (
    <span className={`dot dot--${tone}`} aria-hidden="false">
      <span aria-hidden="true">{shape}</span>
      <span className="sr-only">{name}: </span>
    </span>
  );
}
