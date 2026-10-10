/**
 * دستگاه‌ها و نشست‌ها — گامی که ADR-005 خواسته بود و محصول نداشت.
 *
 * زنجیره اعتماد دستگاه سه حلقه دارد:
 *
 *     ثبت‌نشده ──تأیید مدیر──→ تأییدشده ──ورود کامل──→ ثبت‌نام‌شده
 *
 * حلقه وسط تا امروز هیچ صفحه‌ای نداشت، پس هیچ دستگاهی تأیید نمی‌شد و
 * **PIN صندوق‌دار هرگز باز نمی‌شد** — هر بار قفل صفحه، ورود کامل با
 * رمز. این صفحه همان حلقه است.
 *
 * ── دو کاری که این صفحه عمداً نمی‌کند ───────────────────────────────
 *
 * **راز دستگاه را نشان نمی‌دهد.** نه خودش، نه هشش. سرور هم نمی‌فرستد —
 * نمای `identity.device_overview` اصلاً ستونش را ندارد. تنها چیزی که
 * دیده می‌شود «ثبت‌نام شده یا نه» است.
 *
 * **مجوز را حدس نمی‌زند.** اگر کاربر `device.manage` نداشته باشد، سرور
 * ۴۰۳ با پیام فارسی می‌دهد و همان نشان داده می‌شود. `device.manage` در
 * فهرست ممنوعه PIN هم هست، پس نشست بازشده با PIN حتی برای مدیر ۴۰۳
 * می‌گیرد — و پیامش همان را می‌گوید.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { ResultState } from "../components/ResultState.tsx";
import { Ltr } from "../components/ui/Bidi.tsx";
import { DataTable, type Column } from "../components/ui/DataTable.tsx";
import { PageHeader, SectionHeader } from "../components/ui/PageHeader.tsx";
import { SafeAction } from "../components/ui/SafeAction.tsx";
import { Skeleton } from "../components/ui/Skeleton.tsx";
import { StatusBadge } from "../components/ui/Status.tsx";
import { ApiError } from "../lib/api.ts";
import { formatCount, formatJalaliMoment } from "../lib/format.ts";
import { admin, type Device, type LiveSession } from "../lib/admin.ts";
import { pos, type Branch } from "../lib/pos.ts";

const KIND: Record<string, string> = {
  pos: "صندوق",
  desktop: "دسکتاپ",
  mobile: "موبایل",
  other: "سایر",
};

const AUTH_METHOD: Record<string, string> = {
  password: "رمز",
  totp: "کد یک‌بارمصرف",
  webauthn: "کلید عبور",
  otp: "پیامک",
};

function message(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "ارتباط با سرور برقرار نشد.";
}

/** تاریخ فقط از قالب‌گر مشترک (جلالی)، نه یک Intl جدا در هر صفحه. */
function when(iso: string | null): string {
  return iso === null ? "—" : formatJalaliMoment(iso);
}

/**
 * «همه نشست‌ها» از این صفحه قابل اثبات نیست: فهرست نشست‌ها (`GET /sessions`) فقط کاربران و
 * دستگاه‌های دامنهٔ همین مدیر را می‌دهد و حداکثر ۵۰۰ سطر دارد. پس نبودِ کاربر در آن نه
 * اثبات بسته‌شدن همهٔ نشست‌هاست و نه دلیلی برای تکرار. پس از پاسخ نامعلوم، نتیجه نامعلوم
 * می‌ماند (بی تأیید دوباره) و راه قطعی، «رمز تازه» از بخش پرسنل است که پاسخ سرورش
 * بسته‌شدن همهٔ نشست‌ها را می‌گوید.
 */
const REVOKE_ALL_LIMIT = "اگر پاسخ قطعی نرسد، این صفحه نمی‌تواند بسته‌شدن همهٔ نشست‌ها را ثابت کند: فهرست نشست‌ها فقط دامنهٔ شما و حداکثر ۵۰۰ نشست را نشان می‌دهد. راه قطعی، «رمز تازه» برای همین کاربر در بخش پرسنل است که همهٔ نشست‌های او را می‌بندد.";
async function unprovableRevokeAll(): Promise<boolean> {
  throw new Error(REVOKE_ALL_LIMIT);
}

export function Devices() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [sessions, setSessions] = useState<LiveSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** خطای خواندن جدا از خطای عملیات: فهرست خوانده‌نشده «خالی» نشان داده نمی‌شود. */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [labelFor, setLabelFor] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState("");

  const load = useCallback(async () => {
    try {
      const [d, s, b] = await Promise.all([admin.devices(), admin.sessions(), pos.branches()]);
      setDevices(d.devices);
      setSessions(s.sessions);
      setBranches(b.branches);
      setLoadError(null);
    } catch (err) {
      setLoadError(message(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(key: string, fn: () => Promise<string>) {
    if (busyRef.current) return; // دو بار زدن دکمه، دو عملیات نمی‌سازد — حتی پیش از رندر بعدی
    busyRef.current = true;
    setBusy(key);
    setError(null);
    try {
      setNote(await fn());
      await load();
    } catch (err) {
      setError(message(err));
      setNote(null);
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  const pending = (devices ?? []).filter((d) => !d.isApproved);
  const trusted = (devices ?? []).filter((d) => d.isApproved);

  /**
   * عملیات ثبت شد ولی خواندن دوباره شکست خورد: فهرست روی صفحه قدیمی است. پیام موفقیت
   * می‌ماند (شکست خواندن، شکست عملیات نیست) و کنش‌ها تا خواندن موفق بسته‌اند.
   */
  const stale = loadError !== null && devices !== null;
  /** نبودِ دستگاه در پاسخ اثبات «انجام نشد» نیست — نتیجه نامعلوم می‌ماند. */
  const readDevice = async (id: string): Promise<Device> => {
    const found = (await admin.devices()).devices.find((x) => x.id === id);
    if (!found) throw new Error("این دستگاه در فهرست قابل‌دید شما نیست؛ وضعیت معلوم نشد.");
    return found;
  };

  /** پس از ابطال تأییدشده (یا تأیید از راه «بررسی وضعیت»): پیام و خواندن دوباره. */
  const afterRevoke = (text: string) => {
    setNote(text);
    setError(null);
    void load();
  };

  const header = <PageHeader title="دستگاه‌ها و نشست‌ها"
    context="تأیید دستگاه تازه، ابطال دستگاه گم‌شده و بستن نشست‌های باز. راز دستگاه هرگز نمایش داده نمی‌شود."
    {...(devices ? { meta: <span className="muted small">{formatCount(pending.length)} در انتظار · {formatCount(trusted.length)} مورد اعتماد · {formatCount(sessions?.length ?? 0)} نشست باز</span> } : {})} />;

  if (loadError !== null && devices === null) return <div className="settings-page">
    {header}
    <Solid as="section" className="settings-section">
      <ResultState kind="error" title={loadError} actionLabel="تلاش دوباره" onAction={() => { setLoadError(null); void load(); }} />
    </Solid>
  </div>;

  const sessionColumns: Column<LiveSession>[] = [
    { key: "user", header: "کاربر", cell: (s) => <>{s.fullName} <span className="muted small">(<Ltr>{s.username}</Ltr>)</span></> },
    { key: "device", header: "دستگاه", cell: (s) => s.deviceLabel ?? "—" },
    {
      key: "method", header: "ورود با", cell: (s) => <>
        {AUTH_METHOD[s.authMethod] ?? s.authMethod}
        {s.pinUnlocked ? <> <StatusBadge state="warning" label="بازشده با PIN" quiet /></> : null}
      </>,
    },
    { key: "ip", header: "IP", cell: (s) => s.ip ? <Ltr>{s.ip}</Ltr> : "—" },
    { key: "seen", header: "آخرین فعالیت", cell: (s) => when(s.lastSeenAt) },
  ];

  return (
    <div className="settings-page">
      {header}
      {stale ? <ResultState kind="error" title="فهرست به‌روز نشد."
        description={`${loadError} فهرست روی صفحه ممکن است قدیمی باشد؛ کنش‌ها تا به‌روزرسانی بسته‌اند.`}
        actionLabel="به‌روزرسانی فهرست" onAction={() => void load()} /> : null}
      {error !== null ? (
        <p className="solid pos-alert" role="alert">
          <span className="dot dot--crit" aria-hidden="true">
            ●
          </span>{" "}
          {error}
        </p>
      ) : null}
      {note !== null ? (
        <p className="solid pos-alert" role="status">
          <span className="dot dot--good" aria-hidden="true">
            ●
          </span>{" "}
          {note}
        </p>
      ) : null}

      {/* ── در انتظار تأیید ────────────────────────────────────────── */}
      <Solid as="section" className="settings-section" aria-labelledby="devices-pending">
        <SectionHeader id="devices-pending" title="در انتظار تأیید" level={3} description={<>
          دستگاهی که یک بار وارد شده ولی هنوز تأیید نشده. تا تأیید نشود،
          صندوق‌دار روی آن نمی‌تواند قفل صفحه را با PIN باز کند — هر بار باید
          رمز کامل بزند.
          تأیید اولیه و انتخاب شعبه با مدیر همهٔ شعب است؛ سپس مدیر شعبه دستگاه‌های همان شعبه را مدیریت می‌کند.
        </>} />

        {devices === null ? (
          <Skeleton variant="row" lines={2} label="در حال دریافت دستگاه‌ها…" />
        ) : pending.length === 0 ? (
          <p className="empty">دستگاهی در انتظار تأیید نیست.</p>
        ) : (
          <ul className="lines">
            {pending.map((d) => (
              <li key={d.id}>
                <div className="line-name">
                  <strong>{d.label}</strong>
                  <span className="muted small">
                    {KIND[d.kind] ?? d.kind}
                    {d.branchName !== null ? ` · ${d.branchName}` : ""} · آخرین
                    بازدید {when(d.lastSeenAt)}
                  </span>
                  <span className="muted small"><Ltr>{d.fingerprint}</Ltr></span>
                </div>

                {labelFor === d.id ? (
                  <form
                    className="row"
                    style={{ gap: "var(--s-2)", flexWrap: "wrap" }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      const name = label.trim();
                      void run(d.id, async () => {
                        await admin.approveDevice(d.id, { ...(name === "" ? {} : { label: name }), branchId });
                        setLabelFor(null);
                        setLabel("");
                        return `«${name === "" ? d.label : name}» تأیید شد. برای فعال‌شدن PIN، یک ورود کامل روی همان دستگاه لازم است.`;
                      });
                    }}
                  >
                    <input
                      type="text"
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      placeholder="مثلاً: تبلت صندوق ۱"
                      aria-label="نام دستگاه"
                      autoFocus
                    />
                    <select aria-label="شعبه دستگاه" value={branchId} required
                      onChange={(e) => setBranchId(e.target.value)}>
                      <option value="">انتخاب شعبه</option>
                      {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                    <button type="submit" className="btn btn--primary" disabled={busy !== null || stale || branchId === ""}>
                      تأیید
                    </button>
                    <button
                      type="button"
                      className="btn btn--quiet"
                      onClick={() => {
                        setLabelFor(null);
                        setLabel("");
                      }}
                    >
                      انصراف
                    </button>
                  </form>
                ) : (
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={busy !== null || stale}
                    onClick={() => {
                      setLabelFor(d.id);
                      setLabel(d.label);
                      setBranchId(d.branchId ?? "");
                    }}
                  >
                    تأیید دستگاه
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Solid>

      {/* ── مورد اعتماد ────────────────────────────────────────────── */}
      <Solid as="section" className="settings-section" aria-labelledby="devices-trusted">
        <SectionHeader id="devices-trusted" title="دستگاه‌های مورد اعتماد" level={3} description={<>
          ابطال، همان لحظه همه نشست‌های زنده روی آن دستگاه را می‌بندد و راز
          ثبت‌نامش را پاک می‌کند. برای تبلتی که گم شده، همین کافی است.
        </>} />

        {devices === null ? <Skeleton variant="row" lines={2} label="در حال دریافت دستگاه‌ها…" /> : trusted.length === 0 ? (
          <p className="empty">هنوز دستگاهی تأیید نشده.</p>
        ) : (
          <ul className="lines">
            {trusted.map((d) => (
              <li key={d.id}>
                <div className="line-name">
                  <strong>{d.label}</strong>
                  <span className="muted small">
                    {KIND[d.kind] ?? d.kind}
                    {d.branchName !== null ? ` · ${d.branchName}` : ""} · تأیید
                    توسط {d.approvedByName ?? "—"} در {when(d.approvedAt)}
                  </span>
                  <span className="small">
                    {d.enrolled
                      ? <StatusBadge state="completed" label="ثبت‌نام کامل — PIN روی این دستگاه کار می‌کند" quiet />
                      : <StatusBadge state="pending" label="در انتظار اولین ورود کامل — تا آن موقع PIN باز نمی‌کند" quiet />}
                    {" · "}
                    {formatCount(d.activeSessions)} نشست زنده
                  </span>
                </div>
                {/* تأیید در گفت‌وگوی خود برنامه، نه confirm مرورگر؛ نتیجهٔ نامعلوم از سرور بررسی می‌شود، نه ارسال دوباره. */}
                <SafeAction trigger="ابطال دستگاه" triggerVariant="button" tone="destructive"
                  title={`ابطال «${d.label}»`}
                  summary={<>اعتماد <strong>{d.label}</strong>{d.branchName !== null ? ` (${d.branchName})` : ""} برداشته می‌شود.</>}
                  consequence={`${formatCount(d.activeSessions)} نشست زندهٔ روی این دستگاه همان لحظه بسته و راز ثبت‌نامش پاک می‌شود. برای استفادهٔ دوباره، تأیید تازهٔ مدیر لازم است.`}
                  confirmLabel="ابطال دستگاه" pendingLabel="در حال ابطال…"
                  disabled={busy !== null || stale}
                  run={() => admin.revokeDevice(d.id, "ابطال از صفحه دستگاه‌ها").then(() => undefined)}
                  verify={async () => !(await readDevice(d.id)).isApproved}
                  onDone={() => afterRevoke(`«${d.label}» باطل شد و نشست‌هایش بسته شد.`)} />
              </li>
            ))}
          </ul>
        )}
      </Solid>

      {/* ── نشست‌های زنده ──────────────────────────────────────────── */}
      <Solid as="section" className="settings-section" aria-labelledby="devices-sessions">
        <SectionHeader id="devices-sessions" title="نشست‌های باز" level={3} description={<>
          «همه نشست‌ها» را وقتی بزنید که گوشی یا حساب کسی از دست رفته باشد.
          خودش نمی‌تواند این کار را بکند — دستگاه دستش نیست.
        </>} />

        {/* فهرست خالی پیام ثابت است نه اعلان: role="status" فقط برای نتیجهٔ عملیات می‌ماند. */}
        {sessions === null ? <Skeleton variant="row" lines={3} label="در حال دریافت نشست‌ها…" />
          : sessions.length === 0 ? <p className="empty">نشست بازی نیست.</p>
          : <DataTable caption="نشست‌های باز" columns={sessionColumns} rows={sessions} rowKey={(x) => x.id} stack
            rowActions={(x) => <SafeAction trigger="همه نشست‌ها" triggerVariant="button" tone="destructive"
              title={`بستن همهٔ نشست‌های ${x.fullName}`}
              summary={<>
                <p style={{ margin: 0 }}>همهٔ نشست‌های باز <strong>{x.fullName}</strong> (<Ltr>{x.username}</Ltr>) بسته می‌شود.</p>
                <p className="field-hint" style={{ margin: "var(--s-2) 0 0" }}>{REVOKE_ALL_LIMIT}</p>
              </>}
              consequence="روی هر دستگاهی که باز است، باید دوباره با رمز کامل وارد شود. کار ثبت‌نشدهٔ روی صفحه از دست می‌رود."
              confirmLabel="بستن همهٔ نشست‌ها" pendingLabel="در حال بستن…"
              disabled={busy !== null || stale}
              run={() => admin.revokeUserSessions(x.userId, "ابطال از صفحه دستگاه‌ها").then(() => undefined)}
              verify={unprovableRevokeAll}
              onDone={() => afterRevoke(`نشست‌های «${x.fullName}» بسته شد.`)} />} />}
      </Solid>
    </div>
  );
}
