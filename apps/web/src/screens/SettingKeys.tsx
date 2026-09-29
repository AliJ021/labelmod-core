/**
 * «تنظیمات» — کلیدهای `platform.setting`، الگوی «تنظیمات/فرم» (UI_PATTERNS §۳).
 *
 * **هیچ چیزی در این فایل درباره تنظیمات hardcode نیست.** برچسب، نوع
 * ویجت، گزینه‌ها، بازه مجاز و اینکه این کاربر اجازه تغییرش را دارد یا
 * نه — همه از پاسخ `GET /settings` می‌آیند. اگر فردا تنظیمی اضافه شود،
 * این صفحه بدون یک خط تغییر نشانش می‌دهد. اگر لازم می‌شد اینجا فهرستی
 * از کلیدها بنویسیم، یعنی فراداده‌ای در دیتابیس کم است.
 *
 * ── رفتاری که عمداً همان ماند ────────────────────────────────────────
 *
 * - **هر ردیف جدا ذخیره می‌شود** (`PATCH /settings/:key`)؛ ذخیرهٔ گروهی یا
 *   خودکار نیست. تنظیم مالی خودش دادهٔ مالی است و هر تغییر با مقدار پیش و
 *   پس در سابقه می‌نشیند.
 * - تنظیمی که `requiresApproval` دارد، بی «دلیل تغییر» ذخیره نمی‌شود.
 * - مرجع اعتبارسنجی دیتابیس است؛ سنجش اینجا (`settings-value.ts`) فقط
 *   بازخورد فوری است و پیام ردِ سرور همان‌طور که هست نشان داده می‌شود.
 *
 * ── آنچه تازه است ───────────────────────────────────────────────────
 *
 * - یک سطح مات با گروه‌های خط‌دار به‌جای کارت شیشه‌ای هر گروه و کارت مات
 *   هر ردیف (کارت‌کمتر). گروه همچنان آکاردئون است، ولی بستنش ردیف‌ها را
 *   Unmount نمی‌کند: پیش‌نویسِ ذخیره‌نشده با بستن گروه گم نمی‌شد.
 * - «تغییر ذخیره‌نشده» روی ردیف و شمارش آن روی گروه، به‌علاوهٔ «بازگردانی»؛
 *   و هشدار مرورگر هنگام ترک صفحه با پیش‌نویس باز.
 */
import { useCallback, useEffect, useId, useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { Icon } from "../components/Icon.tsx";
import { ResultState } from "../components/ResultState.tsx";
import { PageHeader } from "../components/ui/PageHeader.tsx";
import { Button, Switch } from "../components/ui/Controls.tsx";
import { StatusBadge, StatusIcon } from "../components/ui/Status.tsx";
import { Skeleton } from "../components/ui/Skeleton.tsx";
import { Ltr } from "../components/ui/Bidi.tsx";
import { MeliPayamakSettings } from "./MeliPayamakSettings.tsx";
import { api, ApiError } from "../lib/api.ts";
import { admin, type SettlementTerm } from "../lib/admin.ts";
import { isZeroFee } from "../lib/settlement.ts";
import { formatCount } from "../lib/format.ts";
import { describeValue, fromInput, toInput, type SettingKind, type SettingMeta } from "../lib/settings-value.ts";

interface Setting extends SettingMeta {
  key: string;
  value: unknown;
  kind: SettingKind;
  label: string;
  description: string;
  help: string | null;
  unit: string | null;
  requiresApproval: boolean;
  isEditable: boolean;
  canEdit: boolean;
  permission: string;
  updatedAt: string;
  updatedBy: string | null;
}

interface Group { key: string; title: string; subtitle: string | null; settings: Setting[] }

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };
type Draft = string | boolean | string[];

/**
 * کلید گروهِ «کارمزد و دوره تسویه» در آکاردئون. عمداً دو نقطه دارد:
 * `group_key` دیتابیس بی‌نقطه‌دونقطه است، پس هرگز با گروهی از سرور یکی نمی‌شود.
 */
const TERMINALS_GROUP = "terminals:settlement";

export function SettingKeys({ onOpenTerminals }: { onOpenTerminals: () => void }) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [loadError, setLoadError] = useState<{ message: string; reference: string | null } | null>(null);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set());
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoadError(null);
    api.get<{ groups: Group[] }>("/settings", { signal: controller.signal })
      .then(r => { setGroups(r.groups); setOpenGroup(k => k ?? r.groups[0]?.key ?? null); })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(e instanceof ApiError ? { message: e.message, reference: e.correlationId } : { message: "ارتباط با سرور برقرار نشد", reference: null });
      });
    return () => controller.abort();
  }, [attempt]);

  // پیش‌نویس ذخیره‌نشده: مرورگر پیش از ترک صفحه هشدار می‌دهد (UI_PATTERNS §۳ «فرم»).
  useEffect(() => {
    if (dirty.size === 0) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty.size]);

  const markDirty = useCallback((key: string, isDirty: boolean) => {
    setDirty(prev => {
      if (prev.has(key) === isDirty) return prev;
      const next = new Set(prev);
      if (isDirty) next.add(key); else next.delete(key);
      return next;
    });
  }, []);

  function replace(next: Setting) {
    setGroups(gs => gs?.map(g => ({ ...g, settings: g.settings.map(s => (s.key === next.key ? next : s)) })) ?? null);
  }

  const header = <PageHeader title="تنظیمات"
    context="هر چیزی که اینجا عوض می‌شود بلافاصله روی کل سیستم اثر می‌گذارد و با نام شما در سابقه ثبت می‌شود."
    {...(dirty.size > 0 ? { meta: <StatusBadge state="draft" label={`${formatCount(dirty.size)} تغییر ذخیره‌نشده`} /> } : {})} />;

  if (loadError !== null) {
    // پیام واقعی سرور، نه یک «خطایی رخ داد» عمومی.
    return <div className="settings-page">{header}
      <Solid className="pad"><ResultState kind="error" title={loadError.message} reference={loadError.reference} actionLabel="تلاش دوباره" onAction={() => setAttempt(n => n + 1)} /></Solid>
    </div>;
  }
  if (groups === null) {
    return <div className="settings-page">{header}<Skeleton variant="row" lines={5} label="در حال بارگذاری تنظیمات…" /></div>;
  }

  return <div className="settings-page">
    {header}
    <Solid as="section" className="settings-groups" aria-label="گروه‌های تنظیمات">
      {groups.map(g => {
        const rows = g.settings.filter(s => s.key !== "payment.snappay_account_id");
        const pending = rows.filter(s => dirty.has(s.key)).length;
        return <SettingsGroup key={g.key} id={g.key} title={g.title} subtitle={g.subtitle} count={rows.length} pending={pending}
          open={openGroup === g.key} onToggle={() => setOpenGroup(k => (k === g.key ? null : g.key))}>
          {g.key === "notify" ? <div className="set-embedded"><MeliPayamakSettings /></div> : null}
          {rows.map(s => <Row key={s.key} setting={s} onSaved={replace} onDirty={markDirty} />)}
        </SettingsGroup>;
      })}
      <SettlementGroup open={openGroup === TERMINALS_GROUP}
        onToggle={() => setOpenGroup(k => (k === TERMINALS_GROUP ? null : TERMINALS_GROUP))} onOpenTerminals={onOpenTerminals} />
    </Solid>
  </div>;
}

/**
 * یک گروه آکاردئونی. پنل بسته `hidden` می‌شود، نه Unmount: پیش‌نویس ردیف‌ها
 * با بستن گروه نمی‌پرد. شمارش ذخیره‌نشده متنی است، نه فقط نقطهٔ رنگی.
 */
function SettingsGroup({ id, title, subtitle, count, pending = 0, open, onToggle, children }: {
  id: string; title: string; subtitle: string | null; count: number | null; pending?: number; open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  const panelId = useId();
  return <section className="set-group" aria-labelledby={`${panelId}-h`} data-group={id}>
    <h2 className="set-group-title" id={`${panelId}-h`}>
      <button type="button" className="set-group-head" aria-expanded={open} aria-controls={panelId} onClick={onToggle}>
        <span className={`set-group-chevron${open ? " is-open" : ""}`}><Icon name="chevron" size="sm" /></span>
        <span className="set-group-text">
          <span className="set-group-name">{title}</span>
          {subtitle ? <span className="set-group-sub">{subtitle}</span> : null}
        </span>
        {pending > 0 ? <StatusBadge state="draft" label={`${formatCount(pending)} ذخیره‌نشده`} quiet /> : null}
        <span className="set-count" aria-label={count === null ? "در حال شمارش" : `${formatCount(count)} مورد`}>{count === null ? "…" : formatCount(count)}</span>
      </button>
    </h2>
    <div id={panelId} className="set-group-body" hidden={!open}>{children}</div>
  </section>;
}

/**
 * کارمزد و دوره تسویه، **به‌ازای هر پایانه** — اینجا فقط دیده می‌شود.
 *
 * این دو عدد در `platform.setting` نیستند و نباید بروند: کارت‌خوان
 * فروشگاه و درگاه سایت دو قرارداد جدا با PSP دارند. ولی کسی که دنبال
 * «کارمزد» می‌گردد اول همین فهرست را می‌بیند؛ نبودنش اینجا یعنی به این
 * نتیجه برسد که از تنظیمات عوض نمی‌شود و سراغ کد برود. پس سطرش هست،
 * مقدار واقعی هر پایانه را نشان می‌دهد، و راه تغییر را می‌گوید.
 *
 * `feePercent` رشته می‌ماند و همان‌طور نشان داده می‌شود — از `Number()` یا
 * `Percent` نمی‌گذرد (`lib/settlement.ts`).
 */
function SettlementGroup({ open, onToggle, onOpenTerminals }: { open: boolean; onToggle: () => void; onOpenTerminals: () => void }) {
  const [terms, setTerms] = useState<SettlementTerm[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    admin.settlementTerms()
      .then(r => { if (alive) setTerms(r.terms); })
      .catch((e: unknown) => { if (alive) setError(e instanceof ApiError ? e.message : "ارتباط با سرور برقرار نشد"); });
    return () => { alive = false; };
  }, []);
  return <SettingsGroup id={TERMINALS_GROUP} title="کارمزد و دوره تسویه" subtitle="به‌ازای هر پایانه — کارت‌خوان فروشگاه و درگاه سایت یک قرارداد ندارند"
    count={terms === null ? null : terms.length} open={open} onToggle={onToggle}>
    {error !== null ? <ResultState kind="error" title={error} />
      : terms === null ? <Skeleton variant="row" lines={2} label="در حال بارگذاری پایانه‌ها…" />
      : terms.length === 0 ? <ResultState title="هیچ پایانه‌ای تعریف نشده است." />
      : terms.map(t => <div key={t.id} className="set-row">
          <div className="set-row-meta">
            <span className="set-label">{t.name}</span>
            <Ltr><span className="set-key">{t.code}</span></Ltr>
            {!t.canEdit ? <LockNote text="دسترسی ندارید" /> : null}
          </div>
          <div className="set-row-control">
            {isZeroFee(t.feePercent) ? <p className="set-help set-help--warn"><StatusIcon state="warning" />
              کارمزد صفر است. اگر قرارداد PSP کارمزد دارد، دفتر کل مبلغ را درآمد می‌بیند و بانک کمتر واریز می‌کند — تفاوتش جایی ثبت نمی‌شود.</p> : null}
            <div className="set-foot">
              <span className="set-current">کارمزد: <bdi className="num">{t.feePercent}</bdi>٪ · دوره تسویه: {formatCount(t.settlementDays)} روز</span>
              <Button onClick={onOpenTerminals}>تغییر در زبانه پایانه‌ها</Button>
            </div>
          </div>
        </div>)}
  </SettingsGroup>;
}

function LockNote({ text }: { text: string }) {
  // رنگ به‌تنهایی حامل معنا نیست: نشانهٔ قفل و متن هر دو هست.
  return <span className="set-lock"><Icon name="lock" size="sm" /> {text}</span>;
}

function initial(s: Setting): Draft {
  if (s.kind === "bool") return s.value === true;
  if (s.kind === "multichoice") return Array.isArray(s.value) ? (s.value as string[]) : [];
  return toInput(s.kind, s.value);
}

function Row({ setting, onSaved, onDirty }: { setting: Setting; onSaved: (s: Setting) => void; onDirty: (key: string, dirty: boolean) => void }) {
  const [draft, setDraft] = useState<Draft>(() => initial(setting));
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [touched, setTouched] = useState(false);
  const id = `f-${setting.key}`;
  const hintId = useId(), errorId = useId(), reasonId = useId();

  const dirty = JSON.stringify(draft) !== JSON.stringify(initial(setting));
  useEffect(() => { onDirty(setting.key, dirty); }, [dirty, setting.key, onDirty]);
  useEffect(() => () => onDirty(setting.key, false), [setting.key, onDirty]);

  const needsReason = setting.requiresApproval;
  // بازخورد فوری از همان فراداده‌ای که سرور فرستاده؛ مرجع همچنان دیتابیس است.
  const parsed = dirty ? fromInput(setting, draft) : null;
  const fieldError = touched && parsed && !parsed.ok ? parsed.error : status.kind === "error" ? status.message : null;
  const reasonMissing = dirty && needsReason && reason.trim() === "";
  const locked = !setting.canEdit || status.kind === "saving";

  async function save() {
    const out = fromInput(setting, draft);
    setTouched(true);
    if (!out.ok) { setStatus({ kind: "error", message: out.error }); return; }
    if (needsReason && reason.trim() === "") { setStatus({ kind: "error", message: "برای این تنظیم، نوشتن دلیل اجباری است" }); return; }
    setStatus({ kind: "saving" });
    try {
      const res = await api.patch<{ value: unknown; updatedAt: string }>(`/settings/${setting.key}`,
        needsReason ? { value: out.value, reason: reason.trim() } : { value: out.value });
      const next = { ...setting, value: res.value, updatedAt: res.updatedAt };
      onSaved(next);
      setDraft(initial(next));
      setReason("");
      setTouched(false);
      setStatus({ kind: "saved" });
    } catch (e: unknown) {
      // پیام نگهبان دیتابیس عمداً فارسی و برای کاربر نوشته شده؛ همان را نشان می‌دهیم.
      setStatus({ kind: "error", message: e instanceof ApiError ? e.message : "ذخیره نشد" });
    }
  }
  function revert() {
    setDraft(initial(setting)); setReason(""); setTouched(false); setStatus({ kind: "idle" });
  }
  const change = (v: Draft) => { setDraft(v); setStatus({ kind: "idle" }); };
  const describedBy = [setting.help ? hintId : null, fieldError ? errorId : null].filter(Boolean).join(" ") || undefined;

  return <div className={`set-row${dirty ? " is-dirty" : ""}`} data-setting={setting.key}>
    <div className="set-row-meta">
      {setting.kind === "bool"
        ? <span className="set-label" aria-hidden="true">{setting.label}</span>
        : setting.kind === "multichoice" ? <span className="set-label">{setting.label}</span>
        : <label className="set-label" htmlFor={id}>{setting.label}</label>}
      <Ltr><span className="set-key">{setting.key}</span></Ltr>
      {!setting.canEdit ? <LockNote text={setting.isEditable ? "دسترسی ندارید" : "قفل‌شده"} /> : null}
      {setting.requiresApproval ? <span className="set-flag">نیازمند دلیل و تأیید</span> : null}
    </div>
    <div className="set-row-control">
      <Control setting={setting} id={id} value={draft} disabled={locked} describedBy={describedBy} invalid={fieldError !== null}
        onChange={change} onBlur={() => setTouched(true)} />
      {setting.help ? <p id={hintId} className="set-help">{setting.help}</p> : null}
      {fieldError ? <p id={errorId} className="field-error" role="alert">{fieldError}</p> : null}

      {setting.canEdit && dirty && needsReason ? <div className="field set-reason">
        <label className="field-label" htmlFor={reasonId}>دلیل تغییر — اجباری، در سابقه ثبت می‌شود</label>
        <input id={reasonId} type="text" value={reason} maxLength={500} aria-invalid={reasonMissing && touched ? true : undefined}
          onChange={e => setReason(e.target.value)} placeholder="مثلاً: ابلاغیه جدید سازمان امور مالیاتی" />
      </div> : null}

      <div className="set-foot">
        <span className="set-current">
          مقدار فعلی: <strong>{describeValue(setting, setting.value)}{setting.unit ? ` ${setting.unit}` : ""}</strong>
          {setting.updatedBy ? <> · آخرین تغییر: {setting.updatedBy}</> : null}
        </span>
        <span className="set-actions">
          {status.kind === "saved" ? <span className="set-msg" role="status"><StatusIcon state="completed" /> ذخیره شد</span> : null}
          {dirty && status.kind !== "saving" ? <StatusBadge state="draft" label="ذخیره‌نشده" quiet /> : null}
          {setting.canEdit && dirty ? <Button variant="quiet" disabled={status.kind === "saving"} onClick={revert}>بازگردانی</Button> : null}
          {setting.canEdit ? <Button variant="primary" busy={status.kind === "saving"} busyLabel="در حال ذخیره…"
            disabled={!dirty || (parsed !== null && !parsed.ok)} onClick={() => void save()}>
            ذخیره<span className="sr-only"> {setting.label}</span>
          </Button> : null}
        </span>
      </div>
    </div>
  </div>;
}

function Control({ setting, id, value, disabled, describedBy, invalid, onChange, onBlur }: {
  setting: Setting; id: string; value: Draft; disabled: boolean; describedBy: string | undefined; invalid: boolean;
  onChange: (v: Draft) => void; onBlur: () => void;
}) {
  if (setting.kind === "bool") {
    return <Switch id={id} label={setting.label} checked={value === true} disabled={disabled} stateLabels={["فعال", "غیرفعال"]}
      onChange={next => onChange(next)} />;
  }
  if (setting.kind === "choice") {
    return <select id={id} className="set-input" value={typeof value === "string" ? value : ""} disabled={disabled}
      aria-describedby={describedBy} aria-invalid={invalid || undefined} onChange={e => onChange(e.target.value)} onBlur={onBlur}>
      {(setting.options ?? []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>;
  }
  if (setting.kind === "multichoice") {
    const chosen = new Set(Array.isArray(value) ? value : []);
    return <fieldset className="set-checks" aria-describedby={describedBy} disabled={disabled}>
      <legend className="sr-only">{setting.label}</legend>
      {(setting.options ?? []).map(o => <label key={o.value} className="set-check">
        <input type="checkbox" checked={chosen.has(o.value)} onChange={e => {
          const next = new Set(chosen);
          if (e.target.checked) next.add(o.value); else next.delete(o.value);
          onChange([...next]);
        }} />
        <span>{o.label}</span>
      </label>)}
    </fieldset>;
  }
  const numeric = setting.kind === "int" || setting.kind === "percent" || setting.kind === "money";
  return <span className="set-field">
    {/* عمداً `type="text"` و نه `type="number"`: صفحه‌کلید فارسی «۴۸» می‌فرستد و
        ورودی عددی مرورگر آن را دور می‌اندازد. تبدیل رقم در `normalizeDigits`. */}
    <input id={id} className={`set-input${numeric ? " num" : ""}`} type="text" inputMode={numeric ? "numeric" : "text"}
      value={typeof value === "string" ? value : ""} disabled={disabled} aria-describedby={describedBy} aria-invalid={invalid || undefined}
      onChange={e => onChange(e.target.value)} onBlur={onBlur} />
    {setting.unit ? <span className="set-unit">{setting.unit}</span> : null}
  </span>;
}
