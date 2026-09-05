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
import { useEffect, useState } from "react";
import { Glass, Solid } from "../components/Glass.tsx";
import { ApiError } from "../lib/api.ts";
import { parseRial, toman } from "../lib/money.ts";
import {
  canClosePeriod,
  periodNote,
  pos,
  type Branch,
  type DailyReport,
  type UnpostedRow,
} from "../lib/pos.ts";
import { session } from "../lib/session.ts";

export function Dashboard() {
  const [branch, setBranch] = useState<Branch | null>(null);
  const [report, setReport] = useState<DailyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * `null` یعنی «نمی‌دانیم» — این کاربر `cost.view` ندارد.
   *
   * جدا از آرایه خالی که یعنی «سنجیدیم و چیزی نبود». نشان‌دادن
   * «همه‌چیز مرتب است» به کسی که اصلاً اجازه دیدنش را ندارد، یک
   * اطمینان بی‌پشتوانه است.
   */
  const [unposted, setUnposted] = useState<UnpostedRow[] | null>(null);
  /**
   * آیا این کاربر اجازه بستن دوره را دارد؟
   *
   * `cost.view` (که فهرست را نشان می‌دهد) و `period.close` دو چیزند:
   * صندوق‌دار هیچ‌کدام را ندارد، ولی حسابدارِ فقط‌خوان می‌تواند اولی را
   * داشته باشد و دومی را نه. دکمه‌ای که سرور بعداً ۴۰۳ بدهد، بدتر از
   * نبودنش است.
   *
   * ⚠️ این یک **راحتی** است، نه دروازه. سرور در لحظه اجرا دوباره
   *    مجوز می‌گیرد.
   */
  const [mayClose, setMayClose] = useState(false);
  const [closing, setClosing] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [closed, setClosed] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { branches } = await pos.branches();
        const first = branches[0];
        if (!first) {
          setError("به هیچ شعبه‌ای دسترسی ندارید.");
          return;
        }
        setBranch(first);
        setReport(await pos.dailyReport(first.id));

        // درآمد ثبت‌نشده پشت `cost.view` است. نداشتنش خطا نیست —
        // فقط یعنی این کارت برای این کاربر نیست.
        try {
          setUnposted((await pos.unpostedRevenue()).rows);
        } catch {
          setUnposted(null);
        }

        // جدا از بالا: اگر پرسش مجوز شکست بخورد، کارت باید همچنان
        // دیده شود — فقط بدون دکمه. یکی‌کردن این دو `try` یعنی یک
        // خطای بی‌ربط، زنگ خطر «درآمد ثبت‌نشده» را خاموش کند.
        try {
          setMayClose((await session.can("period.close")).verdict === "allow");
        } catch {
          setMayClose(false);
        }
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "ارتباط با سرور برقرار نشد.");
      }
    })();
  }, []);

  if (error) {
    return (
      <Solid className="pad">
        <p style={{ margin: 0 }}>
          <span className="dot dot--crit" aria-hidden="true">●</span> {error}
        </p>
      </Solid>
    );
  }

  if (!report) return <Solid className="pad">در حال بارگذاری…</Solid>;

  /**
   * بستن دوره یک کانال — همان دکمه‌ای که تا امروز هیچ کاری نمی‌کرد.
   *
   * سه چیز که این تابع نگه می‌دارد:
   *
   * **کلید Idempotency نمی‌فرستد.** سرور آن را از (شعبه، کانال،
   * تاریخ) می‌سازد و هدر کلاینت را نادیده می‌گیرد؛ فرستادنش فقط
   * توهم می‌ساخت.
   *
   * **دو بار کلیک، یک بار اثر.** `closing` پیش از تماس ست می‌شود و
   * دکمه غیرفعال؛ و حتی اگر از دستمان در برود، سرور Replay می‌دهد نه
   * سند دوم.
   *
   * **پیام سرور همان‌طور که هست دیده می‌شود.** «دوره ثبتی برای این
   * کانال وجود ندارد» و «هیچ فاکتوری نهایی نشده» جمله‌های فارسیِ
   * دیتابیس‌اند و ترجمه دوباره‌شان فقط دقت را کم می‌کرد.
   */
  async function closeDay(row: UnpostedRow) {
    if (closing !== null) return;
    setClosing(row.batchId);
    setCloseError(null);
    setClosed(null);
    try {
      await pos.closeChannelDay({
        branchId: row.branchId,
        channel: row.channel,
        date: row.businessDate,
      });
      setClosed(`دوره ${row.channel} در ${row.businessDate} بسته شد.`);
      // فهرست از سرور دوباره خوانده می‌شود، نه اینکه سطر را از حافظه
      // برداریم: اگر بستن نیمه‌کاره مانده باشد، سطر باید بماند.
      setUnposted((await pos.unpostedRevenue()).rows);
    } catch (err) {
      setCloseError(err instanceof ApiError ? err.message : "ارتباط با سرور برقرار نشد.");
    } finally {
      setClosing(null);
    }
  }

  const sales = parseRial(report.salesAmount);
  const received = parseRial(report.receivedAmount);
  // نسیه = فروخته ولی پولش نیامده. منفی بی‌معناست (پیش‌پرداخت روز
  // قبل)، پس صفر می‌شود تا کارت «−۵۰٬۰۰۰ نسیه» نشان ندهد.
  const credit = sales > received ? sales - received : 0n;

  return (
    <div className="stack" style={{ gap: "var(--s-5)" }}>
      <Glass as="section" live className="pad">
        <header className="row between">
          <div>
            <h1 style={{ fontSize: "1.35rem" }}>امروز</h1>
            <p className="muted" style={{ margin: 0 }}>
              {branch?.name} · {report.businessDate}
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
          <Kpi
            label="فروش"
            value={toman(sales)}
            note={
              report.returnCount > 0
                ? `${report.invoiceCount} فاکتور · ${report.returnCount} مرجوعی`
                : `${report.invoiceCount} فاکتور`
            }
          />
          <Kpi
            label="وجه دریافتی"
            value={toman(received)}
            note={credit > 0n ? `${toman(credit)} تومان هنوز نرسیده` : "همه پول رسیده"}
            tone={credit > 0n ? "warn" : "good"}
          />
          {/*
            سود `null` یعنی این کاربر `cost.view` ندارد — نه اینکه سود
            صفر بوده. نشان‌دادن «۰» به‌جایش، به صندوق‌دار می‌گفت
            فروشگاه امروز ضرر کرده.
          */}
          <Kpi
            label="سود"
            value={report.profitAmount === null ? "—" : toman(parseRial(report.profitAmount))}
            note={
              report.profitAmount === null
                ? "برای دیدن سود، دسترسی بهای تمام‌شده لازم است"
                : "پس از بهای تمام‌شده"
            }
            tone={report.profitAmount === null ? "warn" : "good"}
          />
        </div>
      </Glass>

      {/*
        دو چیزی که قبلاً اینجا بودند — نمودار «فروش در ساعت» و فهرست
        کارهای نمونه — **حذف شدند**، نه اینکه برچسب «نمونه» بگیرند.

        داده ساختگی کنار داده واقعی روی داشبوردی که پول نشان می‌دهد،
        بدتر از نبودنش است: «۲ چک تا ۵ روز دیگر سررسید دارد» یا یک
        نمودار ساعتی، وقتی از هیچ کوئری‌ای نیامده‌اند، یک ادعای مالی
        دروغ‌اند.

        `Bars` هم با آن رفت. نگه‌داشتن کامپوننتی که هیچ‌چیز صدایش
        نمی‌زند، «بعداً لازم می‌شود» است — همان جمله‌ای که کد مرده با
        آن جمع می‌شود. تاریخچه git نگهش داشته و بازگرداندنش یک
        `git show` است.
      */}
      <Glass as="section" className="pad">
        <h2 style={{ fontSize: "1rem" }}>نیاز به رسیدگی</h2>
        {closeError ? (
          <p className="auth-error" role="alert">
            <span className="dot dot--crit" aria-hidden="true">●</span> {closeError}
          </p>
        ) : null}
        {closed ? (
          <p className="muted small" role="status">
            <Dot tone="good" />
            {closed}
          </p>
        ) : null}
        <ul className="tasks">
          {unposted === null ? (
            <Task
              tone="warn"
              label="برای دیدن درآمد ثبت‌نشده، دسترسی بهای تمام‌شده لازم است"
            />
          ) : unposted.length === 0 ? (
            <Task tone="good" label="همه درآمدها به دفتر رفته‌اند" />
          ) : (
            unposted.map((r) => (
              <Task
                key={r.batchId}
                tone="crit"
                label={`${r.invoiceCount} فاکتور ${r.channel} در ${r.businessDate} هنوز به دفتر نرفته`}
                note={periodNote(r, report.businessDate, mayClose)}
                {...(canClosePeriod(r, report.businessDate, mayClose)
                  ? {
                      action: closing === r.batchId ? "در حال بستن…" : "بستن دوره",
                      onAction: () => void closeDay(r),
                      busy: closing !== null,
                    }
                  : {})}
              />
            ))
          )}
        </ul>
      </Glass>
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

function Task({
  tone,
  label,
  note,
  action,
  onAction,
  busy,
}: {
  tone: "good" | "warn" | "crit";
  label: string;
  note?: string | undefined;
  action?: string | undefined;
  onAction?: (() => void) | undefined;
  busy?: boolean | undefined;
}) {
  return (
    <li>
      <Dot tone={tone} />
      <span>{label}</span>
      {/*
        دکمه فقط وقتی ساخته می‌شود که کاری برای انجام باشد. نسخه
        قبلی همیشه یک `<button>` می‌گذاشت — بی `onClick` و گاهی با
        متن خالی — یعنی صفحه‌خوان یک دکمه بی‌نام اعلام می‌کرد و کلیک
        روی «بستن دوره» بی‌صدا هیچ کاری نمی‌کرد.
      */}
      {action === undefined || onAction === undefined ? (
        note === undefined ? null : <span className="muted small task-note">{note}</span>
      ) : (
        <button type="button" className="link" onClick={onAction} disabled={busy === true}>
          {action}
        </button>
      )}
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
