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
import { useCallback, useEffect, useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { ApiError } from "../lib/api.ts";
import { admin, type Device, type LiveSession } from "../lib/admin.ts";

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

function when(iso: string | null): string {
  if (iso === null) return "—";
  try {
    return new Intl.DateTimeFormat("fa-IR", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 16);
  }
}

export function Devices() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [sessions, setSessions] = useState<LiveSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [labelFor, setLabelFor] = useState<string | null>(null);
  const [label, setLabel] = useState("");

  const load = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([admin.devices(), admin.sessions()]);
      setDevices(d.devices);
      setSessions(s.sessions);
      setError(null);
    } catch (err) {
      setError(message(err));
      setDevices([]);
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(key: string, fn: () => Promise<string>) {
    if (busy !== null) return; // دو بار زدن دکمه، دو عملیات نمی‌سازد
    setBusy(key);
    setError(null);
    try {
      setNote(await fn());
      await load();
    } catch (err) {
      setError(message(err));
      setNote(null);
    } finally {
      setBusy(null);
    }
  }

  const pending = (devices ?? []).filter((d) => !d.isApproved);
  const trusted = (devices ?? []).filter((d) => d.isApproved);

  return (
    <div className="stack" style={{ gap: "var(--s-4)" }}>
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
      <Solid as="section" className="pad stack">
        <h3 style={{ fontSize: ".95rem", margin: 0 }}>در انتظار تأیید</h3>
        <p className="muted small" style={{ margin: 0 }}>
          دستگاهی که یک بار وارد شده ولی هنوز تأیید نشده. تا تأیید نشود،
          صندوق‌دار روی آن نمی‌تواند قفل صفحه را با PIN باز کند — هر بار باید
          رمز کامل بزند.
        </p>

        {devices === null ? (
          <p className="muted" style={{ margin: 0 }}>
            در حال بارگذاری…
          </p>
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
                  <span className="muted small num">{d.fingerprint}</span>
                </div>

                {labelFor === d.id ? (
                  <form
                    className="row"
                    style={{ gap: "var(--s-2)", flexWrap: "wrap" }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      const name = label.trim();
                      void run(d.id, async () => {
                        await admin.approveDevice(d.id, name === "" ? {} : { label: name });
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
                    <button type="submit" className="btn btn--primary" disabled={busy !== null}>
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
                    onClick={() => {
                      setLabelFor(d.id);
                      setLabel(d.label);
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
      <Solid as="section" className="pad stack">
        <h3 style={{ fontSize: ".95rem", margin: 0 }}>دستگاه‌های مورد اعتماد</h3>
        <p className="muted small" style={{ margin: 0 }}>
          ابطال، همان لحظه همه نشست‌های زنده روی آن دستگاه را می‌بندد و راز
          ثبت‌نامش را پاک می‌کند. برای تبلتی که گم شده، همین کافی است.
        </p>

        {devices === null ? null : trusted.length === 0 ? (
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
                  <span className="muted small">
                    {d.enrolled ? (
                      <>
                        <span className="dot dot--good" aria-hidden="true">
                          ●
                        </span>{" "}
                        ثبت‌نام کامل — PIN روی این دستگاه کار می‌کند
                      </>
                    ) : (
                      <>
                        <span className="dot dot--warn" aria-hidden="true">
                          ●
                        </span>{" "}
                        در انتظار اولین ورود کامل — تا آن موقع PIN باز نمی‌کند
                      </>
                    )}
                    {" · "}
                    <span className="num">{d.activeSessions}</span> نشست زنده
                  </span>
                </div>
                <button
                  type="button"
                  className="btn"
                  disabled={busy !== null}
                  onClick={() => {
                    if (
                      !globalThis.confirm(
                        `اعتماد «${d.label}» برداشته شود و ${d.activeSessions} نشست زنده‌اش بسته شود؟`,
                      )
                    ) {
                      return;
                    }
                    void run(d.id, async () => {
                      const r = await admin.revokeDevice(d.id, "ابطال از صفحه دستگاه‌ها");
                      return `«${d.label}» باطل شد و ${r.sessionsRevoked} نشست بسته شد.`;
                    });
                  }}
                >
                  ابطال دستگاه
                </button>
              </li>
            ))}
          </ul>
        )}
      </Solid>

      {/* ── نشست‌های زنده ──────────────────────────────────────────── */}
      <Solid as="section" className="pad stack">
        <h3 style={{ fontSize: ".95rem", margin: 0 }}>نشست‌های باز</h3>
        <p className="muted small" style={{ margin: 0 }}>
          «همه نشست‌ها» را وقتی بزنید که گوشی یا حساب کسی از دست رفته باشد.
          خودش نمی‌تواند این کار را بکند — دستگاه دستش نیست.
        </p>

        {sessions === null ? null : sessions.length === 0 ? (
          <p className="empty">نشست بازی نیست.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="grid">
              <thead>
                <tr>
                  <th>کاربر</th>
                  <th>دستگاه</th>
                  <th>ورود با</th>
                  <th>IP</th>
                  <th>آخرین فعالیت</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {s.fullName}
                      <span className="muted small"> ({s.username})</span>
                    </td>
                    <td>{s.deviceLabel ?? "—"}</td>
                    <td>
                      {AUTH_METHOD[s.authMethod] ?? s.authMethod}
                      {s.pinUnlocked ? (
                        <>
                          {" "}
                          <span className="dot dot--warn" aria-hidden="true">
                            ●
                          </span>{" "}
                          <span className="small">بازشده با PIN</span>
                        </>
                      ) : null}
                    </td>
                    <td className="num">{s.ip ?? "—"}</td>
                    <td>{when(s.lastSeenAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy !== null}
                        onClick={() => {
                          if (
                            !globalThis.confirm(
                              `همه نشست‌های «${s.fullName}» بسته شود؟`,
                            )
                          ) {
                            return;
                          }
                          void run(s.id, async () => {
                            const r = await admin.revokeUserSessions(
                              s.userId,
                              "ابطال از صفحه دستگاه‌ها",
                            );
                            return `${r.revoked} نشست «${s.fullName}» بسته شد.`;
                          });
                        }}
                      >
                        همه نشست‌ها
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Solid>
    </div>
  );
}
