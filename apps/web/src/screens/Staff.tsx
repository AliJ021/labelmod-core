import { useUrlFlag } from "../lib/use-url-state.ts";
/**
 * پرسنل — ساخت، نقش، رمز، PIN، فعال و غیرفعال.
 *
 * تا امروز تنها راه ساختن کاربر، `cli/create-user.ts` روی سرور بود.
 *
 * ── سه چیزی که این صفحه عمداً می‌کند ──────────────────────────────
 *
 * **رمز را یک بار، بزرگ، و با هشدار نشان می‌دهد.** هیچ‌جا ذخیره‌اش
 * نمی‌کند و با بستن کادر برای همیشه می‌رود. اگر گم شود، تنها راه رمز
 * تازه است — و همان درست است.
 *
 * **«حذف» ندارد.** فاکتور پارسال به `created_by` ارجاع می‌دهد.
 * غیرفعال‌کردن یعنی نمی‌تواند وارد شود؛ ردّ حسابرسی‌اش می‌ماند.
 *
 * **نقش‌ها را کامل می‌فرستد، نه تفاضلی.** فهرستی که تیک خورده، فهرست
 * نهایی است. تفاضلی‌بودن یعنی «برداشتن نقش» مسیر جدا و فراموش‌شدنی
 * خودش را لازم داشته باشد.
 */
import { useEffect, useRef, useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { PasswordDialog } from "../components/PasswordDialog.tsx";
import { ResultState } from "../components/ResultState.tsx";
import { Ltr } from "../components/ui/Bidi.tsx";
import { Button, Field } from "../components/ui/Controls.tsx";
import { DataTable, type Column } from "../components/ui/DataTable.tsx";
import { PageHeader, SectionHeader } from "../components/ui/PageHeader.tsx";
import { SafeAction } from "../components/ui/SafeAction.tsx";
import { Skeleton } from "../components/ui/Skeleton.tsx";
import { StatusBadge } from "../components/ui/Status.tsx";
import { ApiError } from "../lib/api.ts";
import { formatCount } from "../lib/format.ts";
import { pos, type Branch } from "../lib/pos.ts";
import {
  people,
  type AppUser,
  type Role,
  type RoleAssignment,
} from "../lib/people.ts";

function message(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "ارتباط با سرور برقرار نشد.";
}

export function Staff({ currentUserId, onOwnPassword }: { currentUserId: string; onOwnPassword: () => void }) {
  /** `null` یعنی هنوز خوانده نشده — فهرست خالی فقط پس از پاسخ سرور «خالی» است. */
  const [users, setUsers] = useState<AppUser[] | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [includeInactive, setIncludeInactive] = useUrlFlag("staff.inactive");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  /**
   * عملیات ثبت شد ولی خواندن دوبارهٔ فهرست شکست خورد: فهرست روی صفحه قدیمی است.
   * این شکستِ عملیات نیست، پس پیام موفقیت می‌ماند؛ ولی کنش‌های ردیف تا به‌روزرسانی
   * بسته‌اند تا کسی روی دادهٔ کهنه تصمیم نگیرد.
   */
  const [stale, setStale] = useState(false);

  const [busy, setBusy] = useState(false);
  /** قفل همگام: دو کلیک پشت‌سرهم پیش از رندر بعدی هم دو درخواست نمی‌سازند. */
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  /** رمز تازه — روی صفحه می‌ماند تا کاربر ببندش. هیچ‌جا ذخیره نمی‌شود. */
  const [secret, setSecret] = useState<{ title: string; password: string } | null>(null);

  const [creating, setCreating] = useState(false);
  const [username, setUsername] = useState("");
  const [fullName, setFullName] = useState("");
  const [mobile, setMobile] = useState("");
  const [newRole, setNewRole] = useState("cashier");
  const [newBranch, setNewBranch] = useState("");

  const [editing, setEditing] = useState<AppUser | null>(null);
  const [passwordUser, setPasswordUser] = useState<AppUser | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = async () => {
    setUsers((await people.users(includeInactive)).users);
  };
  /** خواندن دوباره پس از یک تغییر موفق — هرگز throw نمی‌کند و خطایش را شکست عملیات جلوه نمی‌دهد. */
  const refresh = async () => {
    try {
      await reload();
      setStale(false);
    } catch {
      setStale(true);
    }
  };

  useEffect(() => {
    const controller = { aborted: false };
    setLoadError(null);
    void (async () => {
      try {
        const [{ roles: rs }, { branches: bs }, { users: us }] = await Promise.all([
          people.roles(),
          pos.branches(),
          people.users(includeInactive),
        ]);
        if (controller.aborted) return;
        setRoles(rs);
        setBranches(bs);
        setNewBranch((b) => b || (bs[0]?.id ?? ""));
        setUsers(us);
        setStale(false);
      } catch (err) {
        if (!controller.aborted) setLoadError(message(err));
      }
    })();
    return () => { controller.aborted = true; };
  }, [includeInactive, revision]);

  async function guarded(fn: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(message(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  // فرم تا موفقیت دست نمی‌خورد: خطای سرور (نام تکراری، موبایل نامعتبر) ورودی را پاک نمی‌کند.
  const create = () =>
    guarded(async () => {
      const out = await people.createUser({
        username: username.trim(),
        fullName: fullName.trim(),
        roles: [{ roleCode: newRole, branchId: newBranch === "" ? null : newBranch }],
        ...(mobile.trim() === "" ? {} : { mobile: mobile.trim() }),
      });
      setSecret({ title: `رمز ${username.trim()}`, password: out.password });
      setCreating(false);
      setUsername("");
      setFullName("");
      setMobile("");
      await refresh();
    });

  const saveRoles = (u: AppUser, next: RoleAssignment[]) =>
    guarded(async () => {
      await people.setRoles(u.id, next);
      setEditing(null);
      await refresh();
    });

  /**
   * آیا اثر نشسته است؟ — فقط خواندن؛ فهرست کامل (با غیرفعال‌ها) تا کاربرِ تازه غیرفعال هم پیدا شود.
   * نبودِ کاربر در پاسخ (مثلاً دامنهٔ دسترسی عوض شده) اثبات «انجام نشد» نیست: throw می‌شود تا
   * SafeAction نتیجه را نامعلوم نگه دارد و تأیید دوباره را باز نکند.
   */
  const readUser = async (id: string): Promise<AppUser> => {
    const found = (await people.users(true)).users.find((x) => x.id === id);
    if (!found) throw new Error("این کاربر در فهرست قابل‌دید شما نیست؛ وضعیت معلوم نشد.");
    return found;
  };
  const afterAction = (text: string) => {
    setNotice(text);
    setError(null);
    void refresh();
  };

  const columns: Column<AppUser>[] = [
    { key: "name", header: "نام", cell: (u) => <strong>{u.fullName}</strong> },
    { key: "username", header: "نام کاربری", cell: (u) => <Ltr>{u.username}</Ltr> },
    {
      key: "roles", header: "نقش", cell: (u) => <>
        {u.roles.map((r) => r.roleName).join("، ")}
        {u.roles.some((r) => r.branchId === null) ? <span className="muted small"> · همه شعبه‌ها</span> : null}
      </>,
    },
    {
      key: "pin", header: "PIN", cell: (u) =>
        // «دارد یا ندارد» — خودِ PIN هرگز از سرور نمی‌آید.
        u.hasPin ? <SafeAction trigger="برداشتن PIN" tone="destructive"
          title={`برداشتن PIN ${u.fullName}`}
          summary={<>PIN فعلی <strong>{u.fullName}</strong> برداشته می‌شود.</>}
          consequence="تا PIN تازه بسازد، باز کردن قفل صفحه فقط با رمز کامل ممکن است."
          confirmLabel="برداشتن PIN" pendingLabel="در حال برداشتن PIN…"
          disabled={busy || stale}
          run={() => people.setPin(u.id, null).then(() => undefined)}
          verify={async () => (await readUser(u.id)).hasPin === false}
          onDone={() => afterAction(`PIN ${u.fullName} برداشته شد.`)} />
          : <span className="muted">ندارد</span>,
    },
    { key: "sessions", header: "نشست باز", numeric: true, cell: (u) => formatCount(u.activeSessions) },
    {
      key: "status", header: "وضعیت", cell: (u) => u.isActive
        ? <StatusBadge state="completed" label="فعال" />
        : <StatusBadge state="cancelled" label="غیرفعال" />,
    },
  ];

  const header = <PageHeader title="پرسنل"
    context="ساخت کاربر، نقش و شعبه، رمز تازه و PIN. کاربر حذف نمی‌شود؛ غیرفعال می‌شود تا ردّ حسابرسی‌اش بماند."
    {...(users ? { meta: <span className="muted small">{formatCount(users.length)} کاربر{includeInactive ? " (با غیرفعال‌ها)" : ""}</span> } : {})}
    actions={<>
      <label className="row" style={{ gap: "var(--s-2)" }}>
        <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
        <span className="small">غیرفعال‌ها هم</span>
      </label>
      <Button variant="primary" onClick={() => setCreating((v) => !v)} aria-expanded={creating} disabled={users === null}>
        {creating ? "بستن فرم" : "کاربر تازه"}
      </Button>
    </>} />;

  if (loadError !== null && users === null) return <div className="settings-page">
    {header}
    <Solid as="section" className="settings-section">
      <ResultState kind="error" title={loadError} actionLabel="تلاش دوباره" onAction={() => setRevision((v) => v + 1)} />
    </Solid>
  </div>;

  return (
    <div className="settings-page">
      {header}
      {error ? <p className="solid pos-alert" role="alert"><span className="dot dot--crit" aria-hidden="true">●</span> {error}</p> : null}
      {loadError !== null ? <ResultState kind="error" title={loadError} actionLabel="تلاش دوباره" onAction={() => setRevision((v) => v + 1)} /> : null}
      {stale ? <ResultState kind="error" title="تغییر ثبت شد، ولی فهرست به‌روز نشد."
        description="فهرست روی صفحه ممکن است قدیمی باشد؛ کنش‌های ردیف تا به‌روزرسانی بسته‌اند."
        actionLabel="به‌روزرسانی فهرست" onAction={() => void refresh()} /> : null}

      {/*
        رمز روی صفحه، یک بار.

        عمداً بزرگ و قابل انتخاب است — روی کاغذ نوشته و دستی تایپ
        می‌شود. و عمداً کپی خودکار ندارد: کلیپ‌بورد را برنامه بعدی هم
        می‌خواند.
      */}
      {secret ? (
        <Solid as="section" className="settings-section" aria-label={secret.title}>
          <SectionHeader title={secret.title} level={3} />
          <p style={{ fontSize: "1.4rem", userSelect: "all", margin: 0, overflowWrap: "anywhere" }}>
            <Ltr>{secret.password}</Ltr>
          </p>
          <p className="small" role="alert" style={{ margin: 0 }}>
            <span className="dot dot--warn" aria-hidden="true">▲</span> این رمز فقط همین
            یک بار نشان داده می‌شود. آن را از راه امن به کاربر بدهید تا در مدیر رمزها نگه دارد.
          </p>
          <div><Button onClick={() => setSecret(null)}>دیدم، ببند</Button></div>
        </Solid>
      ) : null}

      {notice ? <p className="solid pos-alert" role="status">{notice}</p> : null}
      {passwordUser ? <PasswordDialog name={passwordUser.fullName} onCancel={() => setPasswordUser(null)} onApply={async (password) => {
        await people.resetPassword(passwordUser.id, password);
        setNotice(`رمز ${passwordUser.fullName} تغییر کرد و همهٔ نشست‌های او بسته شدند.`);
        setPasswordUser(null);
        void refresh();
      }} /> : null}

      {creating ? (
        <Solid as="section" className="settings-section" aria-labelledby="staff-new-title">
          <SectionHeader id="staff-new-title" title="کاربر تازه" level={3}
            description="رمز را سرور می‌سازد و یک بار نشان می‌دهد — شما رمز انتخاب نمی‌کنید." />
          <form
            className="settings-form"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <Field label="نام کاربری (انگلیسی)" hint="دست‌کم ۳ نویسه.">
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" dir="ltr" required minLength={3} />
            </Field>
            <Field label="نام کامل">
              <input value={fullName} onChange={(e) => setFullName(e.target.value)} required minLength={2} />
            </Field>
            <Field label="موبایل" optional>
              <input value={mobile} onChange={(e) => setMobile(e.target.value)} inputMode="numeric" autoComplete="off" />
            </Field>
            <Field label="نقش">
              <select value={newRole} onChange={(e) => setNewRole(e.target.value)}>
                {roles.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.name}
                  </option>
                ))}
              </select>
            </Field>
            {branches.length > 1 ? (
              <Field label="شعبه">
                <select value={newBranch} onChange={(e) => setNewBranch(e.target.value)}>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            <div className="settings-actions">
              <Button type="submit" variant="primary" busy={busy} busyLabel="در حال ساخت…"
                disabled={busy || username.trim().length < 3 || fullName.trim().length < 2}>
                ساخت کاربر
              </Button>
              <Button type="button" onClick={() => setCreating(false)} disabled={busy}>انصراف</Button>
            </div>
          </form>
        </Solid>
      ) : null}

      <Solid as="section" className="settings-section" aria-label="فهرست پرسنل">
        {users === null ? <Skeleton variant="row" lines={4} label="در حال دریافت فهرست پرسنل…" />
          : <DataTable caption="فهرست پرسنل" columns={columns} rows={users} rowKey={(u) => u.id} stack
            empty={{ title: includeInactive ? "هنوز کاربری ساخته نشده است." : "کاربر فعالی نیست.", description: "با «کاربر تازه» اولین کاربر را بسازید." }}
            rowActions={(u) => <div className="row" style={{ gap: "var(--s-2)", flexWrap: "wrap" }}>
              <button type="button" className="link" aria-expanded={editing?.id === u.id}
                onClick={() => setEditing(editing?.id === u.id ? null : u)} disabled={busy || stale}>
                نقش‌ها
              </button>
              <button type="button" className="link" disabled={busy || stale}
                onClick={() => {
                  if (u.id === currentUserId) onOwnPassword();
                  else { setNotice(null); setPasswordUser(u); }
                }}>
                رمز تازه
              </button>
              {/* خودِ کاربر دکمهٔ غیرفعال‌کردنش را نمی‌بیند: بیرون‌انداختن خود قاعدهٔ ایمنی است، نه دسترسی. */}
              {u.id === currentUserId ? null : <SafeAction
                trigger={u.isActive ? "غیرفعال" : "فعال"}
                tone={u.isActive ? "destructive" : "final"}
                title={u.isActive ? `غیرفعال‌کردن ${u.fullName}` : `فعال‌کردن ${u.fullName}`}
                summary={<><strong>{u.fullName}</strong> (<Ltr>{u.username}</Ltr>)</>}
                consequence={u.isActive
                  ? "دیگر نمی‌تواند وارد شود و همهٔ نشست‌های بازش همان لحظه بسته می‌شود. سوابق و اسنادش می‌مانند."
                  : "دوباره می‌تواند با رمز فعلی‌اش وارد شود."}
                confirmLabel={u.isActive ? "غیرفعال کن" : "فعال کن"}
                pendingLabel={u.isActive ? "در حال غیرفعال‌کردن…" : "در حال فعال‌کردن…"}
                disabled={busy || stale}
                run={() => people.updateUser(u.id, { isActive: !u.isActive }).then(() => undefined)}
                verify={async () => (await readUser(u.id)).isActive === !u.isActive}
                onDone={() => afterAction(u.isActive ? `${u.fullName} غیرفعال شد.` : `${u.fullName} فعال شد.`)} />}
            </div>} />}
      </Solid>

      {editing ? (
        <RoleEditor
          user={editing}
          roles={roles}
          branches={branches}
          busy={busy || stale}
          onSave={(next) => void saveRoles(editing, next)}
          onCancel={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * ویرایش نقش — فهرست **کامل**، نه تفاضلی.
 *
 * هر نقش یک تیک دارد و شعبه‌اش کنارش. آنچه ذخیره می‌شود همان چیزی
 * است که دیده می‌شود؛ «برداشتن» مسیر جدا ندارد.
 */
function RoleEditor({
  user,
  roles,
  branches,
  busy,
  onSave,
  onCancel,
}: {
  user: AppUser;
  roles: Role[];
  branches: Branch[];
  busy: boolean;
  onSave: (roles: RoleAssignment[]) => void;
  onCancel: () => void;
}) {
  const [picked, setPicked] = useState<Map<string, string | null>>(
    () => new Map(user.roles.map((r) => [r.roleCode, r.branchId])),
  );
  const defaultBranch = branches[0]?.id ?? null;

  const toggle = (code: string) => {
    const next = new Map(picked);
    if (next.has(code)) next.delete(code);
    else next.set(code, defaultBranch);
    setPicked(next);
  };

  return (
    <Solid className="pad stack" style={{ gap: "var(--s-3)" }}>
      <h3 style={{ margin: 0, fontSize: "1rem" }}>نقش‌های {user.fullName}</h3>
      <div className="stack" style={{ gap: "var(--s-2)" }}>
        {roles.map((r) => (
          // فهرست شعبه بیرون از label است: label فقط اولین کنترل را نام می‌دهد، پس
          // فهرست بی‌نام می‌ماند و مقدارش به نام چک‌باکس می‌چسبید («صندوق‌دار شعبه یک»).
          <div key={r.code} className="row" style={{ gap: "var(--s-2)" }}>
            <label className="row" style={{ gap: "var(--s-2)" }}>
              <input
                type="checkbox"
                checked={picked.has(r.code)}
                onChange={() => toggle(r.code)}
              />
              <span>{r.name}</span>
            </label>
            {picked.has(r.code) && branches.length > 1 ? (
              <select
                aria-label={`شعبهٔ نقش ${r.name}`}
                value={picked.get(r.code) ?? ""}
                onChange={(e) => {
                  const next = new Map(picked);
                  next.set(r.code, e.target.value === "" ? null : e.target.value);
                  setPicked(next);
                }}
              >
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        ))}
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        آنچه تیک خورده، فهرست نهایی است. کاربر بدون نقش نمی‌ماند.
      </p>
      <button
        type="button"
        className="btn btn--primary"
        disabled={busy || picked.size === 0}
        onClick={() =>
          onSave([...picked].map(([roleCode, branchId]) => ({ roleCode, branchId })))
        }
      >
        ذخیره نقش‌ها
      </button>
      <button type="button" className="btn btn--quiet" onClick={onCancel} disabled={busy}>
        انصراف
      </button>
    </Solid>
  );
}
