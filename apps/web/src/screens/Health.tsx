/**
 * سلامت سیستم — زنگ‌های خطر و صف پیامِ خطادار.
 *
 * ── چرا این صفحه وجود دارد ──────────────────────────────────────────
 *
 * هشت زنگ خطر از قبل بودند و درست کار می‌کردند. آنچه نبود، **دیده
 * شدنشان** بود: همه فقط با اجرای دستی `ops/deploy.sh status` روی سرور
 * دیده می‌شدند. زنگی که کسی نبیندش، زنگ نیست.
 *
 * و «پیام‌های نرفته» بدتر بود: دیده می‌شد ولی هیچ راهی برای زنده‌کردنش
 * جز یک `UPDATE` دستی در psql نبود.
 *
 * ── فهرست زنگ‌ها اینجا نوشته نشده ───────────────────────────────────
 *
 * از `GET /health/alerts` می‌آید و آن هم از `platform.health_alerts()`.
 * عنوان، شدت و جزئیات هر زنگ در دیتابیس است، پس زنگ تازه‌ای که فردا
 * اضافه شود بدون یک خط تغییر در این صفحه دیده می‌شود — همان قاعده‌ای
 * که صفحهٔ تنظیمات دارد.
 */
import { useEffect, useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { ApiError } from "../lib/api.ts";
import { admin, type DeadLetter, type HealthAlert } from "../lib/admin.ts";

function message(e: unknown): string {
  return e instanceof ApiError ? e.message : "ارتباط با سرور برقرار نشد";
}

export function Health() {
  const [alerts, setAlerts] = useState<HealthAlert[] | null>(null);
  const [dead, setDead] = useState<DeadLetter[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [a, d] = await Promise.all([admin.healthAlerts(), admin.deadLetters()]);
    setAlerts(a.alerts);
    setDead(d.messages);
  };

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        await load();
      } catch (e: unknown) {
        if (alive) setError(message(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function requeue(m: DeadLetter, reason: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await admin.requeueDeadLetter(m.id, reason);
      await load();
      setNote(`پیام ${m.topic} به صف برگشت.`);
    } catch (e: unknown) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  if (error !== null && alerts === null) {
    return (
      <Solid as="section" className="pad">
        <p className="pos-alert" role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> {error}
        </p>
      </Solid>
    );
  }

  if (alerts === null) {
    return (
      <Solid as="section" className="pad">
        <p className="muted">در حال بررسی سلامت سیستم…</p>
      </Solid>
    );
  }

  const live = alerts.filter((a) => a.count > 0);

  return (
    <div className="stack" style={{ gap: "var(--s-4)" }}>
      {error !== null ? (
        <p className="solid pos-alert" role="alert">
          <span className="dot dot--crit" aria-hidden="true">●</span> {error}
        </p>
      ) : null}
      {note !== null ? (
        <p className="solid pos-alert" role="status">
          <span className="dot dot--good" aria-hidden="true">●</span> {note}
        </p>
      ) : null}

      <Solid as="section" className="pad">
        <h2 style={{ marginTop: 0, marginBottom: "var(--s-1)" }}>زنگ‌های خطر</h2>
        {live.length === 0 ? (
          <p className="muted" style={{ marginTop: 0 }}>
            <span className="dot dot--good" aria-hidden="true">●</span> هر هشت زنگ
            خاموش‌اند.
          </p>
        ) : (
          <p className="muted small" style={{ marginTop: 0 }}>
            زنگ خاموش در فهرست پایین هم دیده می‌شود، تا معلوم باشد بررسی شده و
            نتیجه‌اش صفر بوده — نه اینکه اصلاً بررسی نشده.
          </p>
        )}

        <ul className="term-list">
          {alerts.map((a) => (
            <li className="term-row" key={a.code}>
              <div className="term-id" style={{ minWidth: "26ch" }}>
                <strong>
                  <span
                    className={
                      a.count === 0
                        ? "dot dot--good"
                        : a.severity === "critical"
                          ? "dot dot--crit"
                          : "dot dot--warn"
                    }
                    aria-hidden="true"
                  >
                    ●
                  </span>{" "}
                  {a.title}
                </strong>
                <span className="muted small" dir="ltr">
                  {a.code}
                </span>
              </div>
              <div className="term-field">
                <span>تعداد</span>
                <strong>{a.count.toLocaleString("fa-IR")}</strong>
              </div>
              <div className="term-field">
                <span>جزئیات</span>
                <span>{a.detail}</span>
              </div>
            </li>
          ))}
        </ul>
      </Solid>

      <Solid as="section" className="pad">
        <h2 style={{ marginTop: 0, marginBottom: "var(--s-1)" }}>پیام‌های نرفته</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          پیامی که پس از سقف تلاش نرفت. زنده‌کردنش شمار تلاش را صفر می‌کند — وگرنه
          اولین شکستِ بعدی همان لحظه دوباره می‌کشتش. دلیلش در دفتر حسابرسی
          می‌نشیند.
        </p>

        {dead.length === 0 ? (
          <p className="muted">
            <span className="dot dot--good" aria-hidden="true">●</span> صف مرده خالی
            است.
          </p>
        ) : (
          <ul className="term-list">
            {dead.map((m) => (
              <DeadRow key={m.id} msg={m} busy={busy} onRequeue={requeue} />
            ))}
          </ul>
        )}
      </Solid>
    </div>
  );
}

function DeadRow({
  msg,
  busy,
  onRequeue,
}: {
  msg: DeadLetter;
  busy: boolean;
  onRequeue: (m: DeadLetter, reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");

  return (
    <li className="term-row">
      <div className="term-id" style={{ minWidth: "18ch" }}>
        <strong dir="ltr">{msg.topic}</strong>
        <span className="muted small">
          {msg.attempts.toLocaleString("fa-IR")} تلاش · {msg.age}
        </span>
      </div>

      <label className="term-field term-reason">
        <span>دلیل اجرای مجدد</span>
        <input
          type="text"
          value={reason}
          disabled={busy}
          placeholder="اجباری است"
          onChange={(e) => setReason(e.target.value)}
        />
      </label>

      <button
        type="button"
        disabled={busy || reason.trim().length < 3}
        onClick={() => void onRequeue(msg, reason.trim())}
      >
        دوباره بفرست
      </button>

      <p className="acct-hint muted small">
        {msg.lastError === null ? "خطایی ثبت نشده." : `آخرین خطا: ${msg.lastError}`}
      </p>
    </li>
  );
}
