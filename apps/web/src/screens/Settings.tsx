/**
 * تنظیمات — ناحیه «متوسط» ADR-002.
 *
 * شیشه روی کارت گروه (لایه کنترلی، خوانده می‌شود)، سطح **مات** روی هر
 * ردیف فرم. دلیلش همان دلیل صندوق است: عددی که تایپ می‌شود و
 * دکمه‌ای که فشرده می‌شود باید پرتضاد باشند، و ورودی نیمه‌شفاف زیر نور
 * مغازه خوانده نمی‌شود.
 *
 * **هیچ چیزی در این فایل درباره تنظیمات hardcode نیست.** برچسب، نوع
 * ویجت، گزینه‌ها، بازه مجاز و اینکه این کاربر اجازه تغییرش را دارد یا
 * نه — همه از پاسخ `GET /settings` می‌آیند. اگر فردا تنظیمی اضافه شود،
 * این صفحه بدون یک خط تغییر نشانش می‌دهد. اگر لازم می‌شد اینجا فهرستی
 * از کلیدها بنویسیم، یعنی فراداده‌ای در دیتابیس کم است.
 */
import { useEffect, useState } from "react";
import { Glass, Solid } from "../components/Glass.tsx";
import { Accounts } from "./Accounts.tsx";
import { PostingRules } from "./PostingRules.tsx";
import { Health } from "./Health.tsx";
import { Terminals } from "./Terminals.tsx";
import { Permissions } from "./Permissions.tsx";
import { Opening } from "./Opening.tsx";
import { Devices } from "./Devices.tsx";
import { Appearance } from "./Appearance.tsx";
import { Staff } from "./Staff.tsx";
import { TwoFactor } from "./TwoFactor.tsx";
import { api, ApiError } from "../lib/api.ts";
import { admin, type SettlementTerm } from "../lib/admin.ts";
import { isZeroFee } from "../lib/settlement.ts";
import {
  describeValue,
  fromInput,
  toInput,
  type SettingKind,
  type SettingMeta,
} from "../lib/settings-value.ts";

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

interface Group {
  key: string;
  title: string;
  subtitle: string | null;
  settings: Setting[];
}

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

function SettingKeys({ onOpenTerminals }: { onOpenTerminals: () => void }) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openGroup, setOpenGroup] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .get<{ groups: Group[] }>("/settings")
      .then((r) => {
        if (!alive) return;
        setGroups(r.groups);
        setOpenGroup(r.groups[0]?.key ?? null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setLoadError(e instanceof ApiError ? e.message : "ارتباط با سرور برقرار نشد");
      });
    return () => {
      alive = false;
    };
  }, []);

  function replace(next: Setting) {
    setGroups(
      (gs) =>
        gs?.map((g) => ({
          ...g,
          settings: g.settings.map((s) => (s.key === next.key ? next : s)),
        })) ?? null,
    );
  }

  if (loadError !== null) {
    return (
      <Glass as="section" className="pad">
        <h1 style={{ fontSize: "1.35rem" }}>تنظیمات</h1>
        {/* پیام واقعی سرور، نه یک «خطایی رخ داد» عمومی. */}
        <p className="muted" style={{ marginBottom: 0 }}>
          <span className="dot dot--crit" aria-hidden="true">●</span> {loadError}
        </p>
      </Glass>
    );
  }

  if (groups === null) {
    return (
      <Glass as="section" className="pad">
        <p className="muted" style={{ margin: 0 }}>در حال بارگذاری تنظیمات…</p>
      </Glass>
    );
  }

  return (
    <div className="stack" style={{ gap: "var(--s-4)" }}>
      <Glass as="section" live className="pad">
        <h1 style={{ fontSize: "1.35rem" }}>تنظیمات</h1>
        <p className="muted" style={{ margin: 0 }}>
          هر چیزی که اینجا عوض می‌شود بلافاصله روی کل سیستم اثر می‌گذارد و با نام شما
          در سابقه ثبت می‌شود.
        </p>
      </Glass>

      {groups.map((g) => (
        <Glass key={g.key} as="section" refract={false} className="pad set-group">
          <button
            type="button"
            className="set-group-head"
            aria-expanded={openGroup === g.key}
            onClick={() => setOpenGroup((k) => (k === g.key ? null : g.key))}
          >
            <span className="stack" style={{ gap: 2, textAlign: "start" }}>
              <strong>{g.title}</strong>
              {g.subtitle ? <span className="muted small">{g.subtitle}</span> : null}
            </span>
            <span className="set-count">{g.settings.length}</span>
          </button>

          {openGroup === g.key ? (
            <div className="stack" style={{ gap: "var(--s-3)", marginTop: "var(--s-4)" }}>
              {g.settings.map((s) => (
                <Row key={s.key} setting={s} onSaved={replace} />
              ))}
            </div>
          ) : null}
        </Glass>
      ))}

      <SettlementGroup
        open={openGroup === TERMINALS_GROUP}
        onToggle={() => setOpenGroup((k) => (k === TERMINALS_GROUP ? null : TERMINALS_GROUP))}
        onOpenTerminals={onOpenTerminals}
      />
    </div>
  );
}

/**
 * کلید گروهِ «کارمزد و دوره تسویه» در آکاردئون تنظیمات.
 *
 * عمداً دو نقطه دارد: `group_key` در دیتابیس شناسه‌ای بدون نقطه‌دونقطه
 * است، پس این مقدار هرگز با گروهی که از سرور می‌آید یکی نمی‌شود.
 */
const TERMINALS_GROUP = "terminals:settlement";

/**
 * کارمزد و دوره تسویه، **به‌ازای هر پایانه** — اینجا فقط دیده می‌شود.
 *
 * ── چرا اینجا هست ────────────────────────────────────────────────────
 *
 * این دو عدد در `platform.setting` نیستند و نباید بروند: کارت‌خوان
 * فروشگاه و درگاه سایت دو قرارداد جدا با PSP دارند و یک کلید سراسری
 * فقط **یک** عدد نگه می‌دارد — یعنی نرخ یکی روی سند دیگری بنشیند، هر
 * روز، بی‌آنکه چیزی قرمز شود.
 *
 * ولی کسی که دنبال «کارمزد» می‌گردد اول همین فهرست را می‌بیند. نبودنش
 * اینجا یعنی به این نتیجه برسد که از تنظیمات عوض نمی‌شود و سراغ کد
 * برود. پس سطرش هست، مقدارِ واقعیِ هر پایانه را نشان می‌دهد، و راه
 * تغییر را می‌گوید.
 *
 * ── چه چیزی اینجا hardcode است و چه چیزی نیست ────────────────────────
 *
 * فقط **وجود** این گروه و عنوانش — مثل فهرست `TABS`، یک تصمیم صفحه‌ای.
 * پایانه‌ها، مقدارها، شمارشگر و «آیا این کاربر می‌تواند عوضش کند»
 * همه از `GET /settlement-terms` می‌آیند. پایانه تازه‌ای که فردا در
 * `treasury.account` ساخته شود، بدون یک خط تغییر اینجا دیده می‌شود.
 */
function SettlementGroup({
  open,
  onToggle,
  onOpenTerminals,
}: {
  open: boolean;
  onToggle: () => void;
  onOpenTerminals: () => void;
}) {
  const [terms, setTerms] = useState<SettlementTerm[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    admin
      .settlementTerms()
      .then((r) => alive && setTerms(r.terms))
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof ApiError ? e.message : "ارتباط با سرور برقرار نشد");
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Glass as="section" refract={false} className="pad set-group">
      <button type="button" className="set-group-head" aria-expanded={open} onClick={onToggle}>
        <span className="stack" style={{ gap: 2, textAlign: "start" }}>
          <strong>کارمزد و دوره تسویه</strong>
          <span className="muted small">
            به‌ازای هر پایانه — کارت‌خوان فروشگاه و درگاه سایت یک قرارداد ندارند
          </span>
        </span>
        <span className="set-count">{terms === null ? "…" : terms.length}</span>
      </button>

      {open ? (
        <div className="stack" style={{ gap: "var(--s-3)", marginTop: "var(--s-4)" }}>
          {error !== null ? (
            <p className="muted" style={{ margin: 0 }}>
              <span className="dot dot--crit" aria-hidden="true">●</span> {error}
            </p>
          ) : terms === null ? (
            <p className="muted" style={{ margin: 0 }}>در حال بارگذاری پایانه‌ها…</p>
          ) : terms.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>هیچ پایانه‌ای تعریف نشده است.</p>
          ) : (
            terms.map((t) => (
              <TermRow key={t.id} term={t} onOpenTerminals={onOpenTerminals} />
            ))
          )}
        </div>
      ) : null}
    </Glass>
  );
}

function TermRow({
  term,
  onOpenTerminals,
}: {
  term: SettlementTerm;
  onOpenTerminals: () => void;
}) {
  const zeroFee = isZeroFee(term.feePercent);

  return (
    <Solid className="set-row">
      <div className="set-row-head">
        <div className="stack" style={{ gap: 2, minWidth: 0 }}>
          <span className="set-label">{term.name}</span>
          <code className="set-key">{term.code}</code>
        </div>
        {!term.canEdit ? (
          <span className="pill set-lock">
            <span aria-hidden="true">🔒</span> دسترسی ندارید
          </span>
        ) : null}
      </div>

      {zeroFee ? (
        // رنگ به‌تنهایی حامل معنا نیست: آیکون و متن هم هست.
        <p className="set-help">
          <span aria-hidden="true">⚠</span> کارمزد صفر است. اگر قرارداد PSP کارمزد دارد،
          دفتر کل مبلغ را درآمد می‌بیند و بانک کمتر واریز می‌کند — تفاوتش جایی ثبت
          نمی‌شود.
        </p>
      ) : null}

      <div className="set-foot">
        <span className="small muted">
          کارمزد: {term.feePercent}٪ · دوره تسویه: {term.settlementDays} روز
        </span>
        <button type="button" className="btn" onClick={onOpenTerminals}>
          تغییر در زبانه پایانه‌ها
        </button>
      </div>
    </Solid>
  );
}

function Row({ setting, onSaved }: { setting: Setting; onSaved: (s: Setting) => void }) {
  const [draft, setDraft] = useState<string | boolean | string[]>(() => initial(setting));
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const dirty = JSON.stringify(draft) !== JSON.stringify(initial(setting));
  const needsReason = setting.requiresApproval;

  async function save() {
    const parsed = fromInput(setting, draft);
    if (!parsed.ok) {
      setStatus({ kind: "error", message: parsed.error });
      return;
    }
    if (needsReason && reason.trim() === "") {
      setStatus({ kind: "error", message: "برای این تنظیم، نوشتن دلیل اجباری است" });
      return;
    }

    setStatus({ kind: "saving" });
    try {
      const out = await api.patch<{ value: unknown; updatedAt: string }>(
        `/settings/${setting.key}`,
        needsReason ? { value: parsed.value, reason: reason.trim() } : { value: parsed.value },
      );
      onSaved({ ...setting, value: out.value, updatedAt: out.updatedAt });
      setReason("");
      setStatus({ kind: "saved" });
    } catch (e: unknown) {
      // پیام نگهبان دیتابیس عمداً فارسی و برای کاربر نوشته شده؛
      // همان را نشان می‌دهیم، نه یک «خطا» عمومی.
      setStatus({ kind: "error", message: e instanceof ApiError ? e.message : "ذخیره نشد" });
    }
  }

  return (
    <Solid className="set-row">
      <div className="set-row-head">
        <div className="stack" style={{ gap: 2, minWidth: 0 }}>
          <label className="set-label" htmlFor={`f-${setting.key}`}>
            {setting.label}
          </label>
          <code className="set-key">{setting.key}</code>
        </div>
        {!setting.canEdit ? (
          // رنگ به‌تنهایی حامل معنا نیست: آیکون و متن هم هست.
          <span className="pill set-lock">
            <span aria-hidden="true">🔒</span>
            {setting.isEditable ? "دسترسی ندارید" : "قفل‌شده"}
          </span>
        ) : null}
      </div>

      {setting.help ? <p className="set-help">{setting.help}</p> : null}

      <Field
        setting={setting}
        value={draft}
        disabled={!setting.canEdit || status.kind === "saving"}
        onChange={(v) => {
          setDraft(v);
          setStatus({ kind: "idle" });
        }}
      />

      {setting.canEdit && dirty && needsReason ? (
        <label className="set-reason">
          <span className="small muted">دلیل تغییر — اجباری، در سابقه ثبت می‌شود</span>
          <input
            className="set-input"
            type="text"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            placeholder="مثلاً: ابلاغیه جدید سازمان امور مالیاتی"
          />
        </label>
      ) : null}

      <div className="set-foot">
        <span className="small muted">
          مقدار فعلی: {describeValue(setting, setting.value)}
          {setting.unit ? ` ${setting.unit}` : ""}
          {setting.updatedBy ? ` · آخرین تغییر: ${setting.updatedBy}` : ""}
        </span>

        <span className="row" style={{ gap: "var(--s-2)" }}>
          {status.kind === "error" ? (
            <span className="set-msg set-msg--crit">
              <span aria-hidden="true">⚠</span> {status.message}
            </span>
          ) : null}
          {status.kind === "saved" ? (
            <span className="set-msg set-msg--good">
              <span aria-hidden="true">✓</span> ذخیره شد
            </span>
          ) : null}

          {setting.canEdit ? (
            <button
              type="button"
              className="btn btn--primary set-save"
              disabled={!dirty || status.kind === "saving"}
              onClick={() => void save()}
            >
              {status.kind === "saving" ? "در حال ذخیره…" : "ذخیره"}
            </button>
          ) : null}
        </span>
      </div>
    </Solid>
  );
}

function initial(s: Setting): string | boolean | string[] {
  if (s.kind === "bool") return s.value === true;
  if (s.kind === "multichoice") return Array.isArray(s.value) ? (s.value as string[]) : [];
  return toInput(s.kind, s.value);
}

function Field({
  setting,
  value,
  disabled,
  onChange,
}: {
  setting: Setting;
  value: string | boolean | string[];
  disabled: boolean;
  onChange: (v: string | boolean | string[]) => void;
}) {
  const id = `f-${setting.key}`;

  if (setting.kind === "bool") {
    return (
      <label className="set-switch">
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{value === true ? "فعال" : "غیرفعال"}</span>
      </label>
    );
  }

  if (setting.kind === "choice") {
    return (
      <select
        id={id}
        className="set-input"
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {(setting.options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }

  if (setting.kind === "multichoice") {
    const chosen = new Set(Array.isArray(value) ? value : []);
    return (
      <div className="set-checks" role="group" aria-label={setting.label}>
        {(setting.options ?? []).map((o) => (
          <label key={o.value} className="set-check">
            <input
              type="checkbox"
              checked={chosen.has(o.value)}
              disabled={disabled}
              onChange={(e) => {
                const next = new Set(chosen);
                if (e.target.checked) next.add(o.value);
                else next.delete(o.value);
                onChange([...next]);
              }}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    );
  }

  const numeric =
    setting.kind === "int" || setting.kind === "percent" || setting.kind === "money";
  return (
    <span className="set-field">
      <input
        id={id}
        className={`set-input ${numeric ? "num" : ""}`}
        // عمداً `type="text"` و نه `type="number"`: صفحه‌کلید فارسی
        // «۴۸» می‌فرستد و ورودی عددی مرورگر آن را دور می‌اندازد.
        // تبدیل رقم در `normalizeDigits` انجام می‌شود.
        type="text"
        inputMode={numeric ? "numeric" : "text"}
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      {setting.unit ? <span className="set-unit">{setting.unit}</span> : null}
    </span>
  );
}

/**
 * پوسته ناحیه تنظیمات — ده زیرتب.
 *
 * چرا زیرتب و نه ناحیه سطح‌بالا: نوار بالای صفحه را صندوق‌دار هم
 * می‌بیند، و سه تبِ تازه‌ای که اجازه بازکردنشان را ندارد فقط شلوغی
 * است. این سه پشت `settings.security`‌اند و جایشان همین‌جاست.
 *
 * فهرست زیرتب‌ها اینجا نوشته شده چون **صفحه‌اند، نه داده** — برخلاف
 * کلیدهای تنظیمات که از سرور می‌آیند. اگر روزی صفحه تازه‌ای اضافه شود،
 * یک ردیف اینجا اضافه می‌شود؛ ولی هیچ‌کدام از این چهار صفحه محتوایش را
 * hardcode نمی‌کند.
 */
const TABS = [
  { key: "keys", label: "تنظیمات" },
  { key: "appearance", label: "نمایش و عملکرد" },
  { key: "accounts", label: "کدینگ حساب" },
  { key: "mapping", label: "نگاشت حساب" },
  { key: "terminals", label: "پایانه‌ها" },
  { key: "permissions", label: "مجوزها" },
  { key: "opening", label: "افتتاحیه و تفصیلی" },
  { key: "devices", label: "دستگاه‌ها" },
  { key: "health", label: "سلامت سیستم" },
  { key: "staff", label: "پرسنل" },
  { key: "twofactor", label: "ورود دومرحله‌ای" },
] as const;

type Tab = (typeof TABS)[number]["key"];

export function Settings({ currentUserId, onOwnPassword }: { currentUserId: string; onOwnPassword: () => void }) {
  const [tab, setTab] = useState<Tab>("keys");

  return (
    <div className="stack" style={{ gap: "var(--s-4)" }}>
      <div className="subtabs" role="tablist" aria-label="بخش‌های تنظیمات">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={tab === t.key ? "on" : ""}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "keys" ? (
        <SettingKeys onOpenTerminals={() => setTab("terminals")} />
      ) : tab === "appearance" ? (
        <Appearance />
      ) : tab === "accounts" ? (
        <Accounts />
      ) : tab === "mapping" ? (
        <PostingRules />
      ) : tab === "terminals" ? (
        <Terminals />
      ) : tab === "permissions" ? (
        <Permissions />
      ) : tab === "staff" ? (
        <Staff currentUserId={currentUserId} onOwnPassword={onOwnPassword} />
      ) : tab === "twofactor" ? (
        <TwoFactor />
      ) : tab === "devices" ? (
        <Devices />
      ) : tab === "health" ? (
        <Health />
      ) : (
        <Opening />
      )}
    </div>
  );
}
