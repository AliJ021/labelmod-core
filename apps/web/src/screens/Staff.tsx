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
import { useCallback, useEffect, useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { ApiError } from "../lib/api.ts";
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

export function Staff() {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [includeInactive, setIncludeInactive] = useState(false);

  const [busy, setBusy] = useState(false);
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
  const [chosenPassword, setChosenPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const reload = useCallback(async () => {
    setUsers((await people.users(includeInactive)).users);
  }, [includeInactive]);

  useEffect(() => {
    void (async () => {
      try {
        const [{ roles: rs }, { branches: bs }] = await Promise.all([
          people.roles(),
          pos.branches(),
        ]);
        setRoles(rs);
        setBranches(bs);
        setNewBranch(bs[0]?.id ?? "");
        await reload();
      } catch (err) {
        setError(message(err));
      }
    })();
  }, [reload]);

  async function guarded(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

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
      await reload();
    });

  const toggleActive = (u: AppUser) =>
    guarded(async () => {
      await people.updateUser(u.id, { isActive: !u.isActive });
      await reload();
    });

  const resetPassword = (u: AppUser, password?: string) =>
    guarded(async () => {
      const out = await people.resetPassword(u.id, password);
      setSecret({ title: `رمز تازه ${u.username}`, password: out.password });
      setPasswordUser(null);
      setChosenPassword("");
      setConfirmPassword("");
      await reload();
    });

  const saveRoles = (u: AppUser, next: RoleAssignment[]) =>
    guarded(async () => {
      await people.setRoles(u.id, next);
      setEditing(null);
      await reload();
    });

  const setPin = (u: AppUser, pin: string | null) =>
    guarded(async () => {
      await people.setPin(u.id, pin);
      await reload();
    });

  return (
    <div className="stack" style={{ gap: "var(--s-3)" }}>
      {error ? (
        <p className="solid pos-alert" role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> {error}
        </p>
      ) : null}

      {/*
        رمز روی صفحه، یک بار.

        عمداً بزرگ و قابل انتخاب است — روی کاغذ نوشته و دستی تایپ
        می‌شود. و عمداً کپی خودکار ندارد: کلیپ‌بورد را برنامه بعدی هم
        می‌خواند.
      */}
      {secret ? (
        <Solid className="pad stack" style={{ gap: "var(--s-2)" }}>
          <h3 style={{ margin: 0, fontSize: "1rem" }}>{secret.title}</h3>
          <p className="num" style={{ fontSize: "1.4rem", userSelect: "all", margin: 0 }}>
            {secret.password}
          </p>
          <p className="small" role="alert" style={{ margin: 0 }}>
            <span className="dot dot--warn" aria-hidden="true">▲</span> این رمز فقط همین
            یک بار نشان داده می‌شود. آن را به کاربر بدهید و جایی ذخیره‌اش نکنید.
          </p>
          <button type="button" className="btn btn--quiet" onClick={() => setSecret(null)}>
            دیدم، ببند
          </button>
        </Solid>
      ) : null}

      {passwordUser ? (
        <Solid className="pad stack" style={{ gap: "var(--s-2)" }}>
          <h3 style={{ margin: 0, fontSize: "1rem" }}>
            تغییر رمز {passwordUser.fullName}
          </h3>
          <label className="auth-field">
            <span>رمز دلخواه (حداقل ۱۲ کاراکتر)</span>
            <input
              type="password"
              value={chosenPassword}
              onChange={(e) => setChosenPassword(e.target.value)}
              autoComplete="new-password"
              minLength={12}
              maxLength={256}
              dir="ltr"
            />
          </label>
          <label className="auth-field">
            <span>تکرار رمز دلخواه</span>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              minLength={12}
              maxLength={256}
              dir="ltr"
            />
          </label>
          {confirmPassword !== "" && chosenPassword !== confirmPassword ? (
            <p className="small" role="alert" style={{ margin: 0 }}>
              دو رمز یکسان نیستند.
            </p>
          ) : null}
          <div className="row" style={{ gap: "var(--s-2)" }}>
            <button
              type="button"
              className="btn btn--primary"
              disabled={
                busy
                || chosenPassword.length < 12
                || chosenPassword !== confirmPassword
              }
              onClick={() => void resetPassword(passwordUser, chosenPassword)}
            >
              ثبت رمز دلخواه
            </button>
            <button
              type="button"
              className="btn btn--quiet"
              disabled={busy}
              onClick={() => void resetPassword(passwordUser)}
            >
              پیشنهاد رمز امن
            </button>
            <button
              type="button"
              className="btn btn--quiet"
              disabled={busy}
              onClick={() => {
                setPasswordUser(null);
                setChosenPassword("");
                setConfirmPassword("");
              }}
            >
              انصراف
            </button>
          </div>
        </Solid>
      ) : null}

      <Solid className="pad">
        <div className="row between">
          <h2 style={{ margin: 0, fontSize: "1rem" }}>پرسنل</h2>
          <div className="row" style={{ gap: "var(--s-3)" }}>
            <label className="row" style={{ gap: "var(--s-2)" }}>
              <input
                type="checkbox"
                checked={includeInactive}
                onChange={(e) => setIncludeInactive(e.target.checked)}
              />
              <span className="small">غیرفعال‌ها هم</span>
            </label>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setCreating((v) => !v)}
            >
              {creating ? "انصراف" : "کاربر تازه"}
            </button>
          </div>
        </div>
      </Solid>

      {creating ? (
        <Solid className="pad">
          <form
            className="filters"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <label className="auth-field">
              <span>نام کاربری (انگلیسی)</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
                dir="ltr"
              />
            </label>
            <label className="auth-field">
              <span>نام کامل</span>
              <input value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </label>
            <label className="auth-field">
              <span>موبایل (اختیاری)</span>
              <input
                value={mobile}
                onChange={(e) => setMobile(e.target.value)}
                inputMode="numeric"
              />
            </label>
            <label className="auth-field">
              <span>نقش</span>
              <select value={newRole} onChange={(e) => setNewRole(e.target.value)}>
                {roles.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            {branches.length > 1 ? (
              <label className="auth-field">
                <span>شعبه</span>
                <select value={newBranch} onChange={(e) => setNewBranch(e.target.value)}>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <button
              type="submit"
              className="btn btn--primary"
              disabled={busy || username.trim().length < 3 || fullName.trim().length < 2}
            >
              ساخت
            </button>
          </form>
          <p className="muted small" style={{ margin: 0 }}>
            رمز را سرور می‌سازد و یک بار نشان می‌دهد — شما رمز انتخاب نمی‌کنید.
          </p>
        </Solid>
      ) : null}

      <Solid className="pad">
        <div className="grid-wrap">
          <table className="grid">
            <caption className="sr-only">فهرست پرسنل</caption>
            <thead>
              <tr>
                <th scope="col">نام</th>
                <th scope="col">نام کاربری</th>
                <th scope="col">نقش</th>
                <th scope="col">PIN</th>
                <th scope="col">نشست باز</th>
                <th scope="col">وضعیت</th>
                <th scope="col"> </th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.fullName}</td>
                  <td className="num" dir="ltr">{u.username}</td>
                  <td>
                    {u.roles.map((r) => r.roleName).join("، ")}
                    {u.roles.some((r) => r.branchId === null) ? (
                      <span className="muted small"> · همه شعبه‌ها</span>
                    ) : null}
                  </td>
                  <td>
                    {/* «دارد یا ندارد» — خودِ PIN هرگز از سرور نمی‌آید. */}
                    {u.hasPin ? (
                      <button
                        type="button"
                        className="link"
                        onClick={() => void setPin(u, null)}
                        disabled={busy}
                      >
                        برداشتن
                      </button>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="num">{u.activeSessions}</td>
                  <td>
                    {u.isActive ? (
                      <span className="small">
                        <span className="dot dot--good" aria-hidden="true">●</span> فعال
                      </span>
                    ) : (
                      <span className="small muted">
                        <span className="dot dot--crit" aria-hidden="true">■</span> غیرفعال
                      </span>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="link"
                      onClick={() => setEditing(editing?.id === u.id ? null : u)}
                      disabled={busy}
                    >
                      نقش‌ها
                    </button>
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        setPasswordUser(u);
                        setChosenPassword("");
                        setConfirmPassword("");
                      }}
                      disabled={busy}
                    >
                      رمز تازه
                    </button>
                    <button
                      type="button"
                      className="link"
                      onClick={() => void toggleActive(u)}
                      disabled={busy}
                    >
                      {u.isActive ? "غیرفعال" : "فعال"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Solid>

      {editing ? (
        <RoleEditor
          user={editing}
          roles={roles}
          branches={branches}
          busy={busy}
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
          <label key={r.code} className="row" style={{ gap: "var(--s-2)" }}>
            <input
              type="checkbox"
              checked={picked.has(r.code)}
              onChange={() => toggle(r.code)}
            />
            <span>{r.name}</span>
            {picked.has(r.code) && branches.length > 1 ? (
              <select
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
          </label>
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
