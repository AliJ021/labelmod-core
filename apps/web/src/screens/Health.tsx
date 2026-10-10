import { useCallback, useEffect, useRef, useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { ResultState } from "../components/ResultState.tsx";
import { PageHeader, SectionHeader } from "../components/ui/PageHeader.tsx";
import { StatusBadge } from "../components/ui/Status.tsx";
import { Button, Field } from "../components/ui/Controls.tsx";
import { Ltr } from "../components/ui/Bidi.tsx";
import { ApiError } from "../lib/api.ts";
import { admin, type DeadLetter } from "../lib/admin.ts";
import { useLatestQuery } from "../lib/use-latest-query.ts";

const message = (e: unknown) => e instanceof ApiError ? e.message : "ارتباط با سرور برقرار نشد";

export function Health() {
  const [version, refresh] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const load = useCallback(async (signal: AbortSignal) => {
    const [a, d] = await Promise.all([admin.healthAlerts(signal), admin.deadLetters(signal)]);
    return {alerts: a.alerts, dead: d.messages};
  }, []);
  const query = useLatestQuery({key: "health", version, load});
  const [previous, setPrevious] = useState<Awaited<ReturnType<typeof load>> | null>(null);
  useEffect(() => { if (query.data) setPrevious(query.data); }, [query.data]);
  const data = query.data ?? previous;
  const blocked = busy || query.loading || !!query.error;
  async function requeue(m: DeadLetter, reason: string) {
    if (working.current || blocked) return;
    working.current = true; setBusy(true); setError(null); setNote(null);
    try {
      await admin.requeueDeadLetter(m.id, reason);
      setNote("پیام " + m.id + " به صف برگشت.");
      refresh(v => v + 1);
    } catch (e) { setError(message(e)); }
    finally { working.current = false; setBusy(false); }
  }
  const live = data?.alerts.filter(a => a.count > 0) ?? [];
  return <div className="operations-screen">
    <PageHeader title="سلامت سیستم" context="هشدارهای عملیاتی و پیام‌های متوقف‌شده را بررسی و پیگیری کنید."
      actions={<Button disabled={query.loading || busy} onClick={() => refresh(v => v + 1)}>بررسی دوباره</Button>} />
    {error && <p className="solid pad" role="alert">{error}</p>}
    {note && <p className="solid pad" role="status">{note}</p>}
    {!data ? <Solid className="pad"><ResultState kind={query.error ? "error" : "loading"}
      title={query.error ? message(query.error) : "در حال بررسی سلامت سیستم…"}
      {...(query.error ? {actionLabel: "تلاش دوباره", onAction: () => refresh(v => v + 1)} : {})} /></Solid> : <>
      {query.error && <p className="solid pad" role="alert">{message(query.error)}؛ اطلاعات از آخرین بررسی است. برای ادامه، «بررسی دوباره» را بزنید.</p>}
      {query.loading && <p className="muted" role="status">در حال تازه‌سازی؛ نتیجهٔ آخرین بررسی نمایش داده می‌شود.</p>}
      <Solid as="section" className="pad operations-section">
        <SectionHeader title="زنگ‌های خطر" description="تعداد، موارد نیازمند رسیدگی در هر بررسی را نشان می‌دهد."
          actions={<StatusBadge state={live.length ? "attention" : data.alerts.length ? "completed" : "unknown"}
            label={live.length ? live.length.toLocaleString("fa-IR") + " هشدار فعال" : data.alerts.length ? "هشداری فعال نیست" : "بررسی ثبت نشده"} />} />
        {data.alerts.length ? <ul className="operations-list">{[...data.alerts].sort((a,b) => Number(b.count > 0)-Number(a.count > 0)).map(a =>
          <li className="operations-entry" key={a.code}>
            <div className="operations-entry-head"><strong>{a.title}</strong><StatusBadge state={a.count === 0 ? "completed" : a.severity === "critical" ? "attention" : "warning"}
              label={a.count === 0 ? "بدون مورد" : a.count.toLocaleString("fa-IR") + " مورد · " + (a.severity === "critical" ? "فوری" : "هشدار")} /></div>
            <p className="muted">{a.detail}</p><small className="muted">شناسهٔ بررسی: <Ltr>{a.code}</Ltr></small>
          </li>)}</ul> : <ResultState title="هنوز نتیجه‌ای برای بررسی‌ها ثبت نشده است." />}
      </Solid>
      <Solid as="section" className="pad operations-section">
        <SectionHeader title="پیام‌های نرفته" description="پس از رفع علت خطا، پیام را با ثبت دلیل به صف برگردانید. شمار تلاش از نو آغاز می‌شود و دلیل در سابقه ثبت می‌شود."
          actions={<StatusBadge state={data.dead.length ? "warning" : "completed"} label={data.dead.length.toLocaleString("fa-IR") + " پیام متوقف"} />} />
        {data.dead.length ? <ul className="operations-list">{data.dead.map(m => <DeadRow key={m.id} msg={m} busy={blocked} onRequeue={requeue} />)}</ul>
          : <ResultState title="پیام متوقف‌شده‌ای وجود ندارد." />}
      </Solid>
    </>}
  </div>;
}

function DeadRow({msg, busy, onRequeue}: {msg: DeadLetter; busy: boolean; onRequeue: (m: DeadLetter, reason: string) => Promise<void>}) {
  const [reason, setReason] = useState("");
  return <li className="operations-entry">
    <div className="operations-entry-head"><strong>پیام <Ltr>{msg.id}</Ltr></strong><StatusBadge state="failed" label="ارسال متوقف" /></div>
    <p className="muted small">{msg.attempts.toLocaleString("fa-IR")} تلاش · {msg.age}</p>
    <p className="operations-error">{msg.lastError === null ? "خطایی ثبت نشده." : "آخرین خطا: " + msg.lastError}</p>
    <small className="muted">موضوع فنی: <Ltr>{msg.topic}</Ltr></small>
    <form className="operations-requeue" onSubmit={e => {e.preventDefault(); if (!busy && reason.trim().length >= 3) void onRequeue(msg, reason.trim());}}>
      <Field label="دلیل اجرای مجدد" hint="حداقل ۳ نویسه؛ دلیل رفع مشکل یا بررسی انجام‌شده را بنویسید."><input value={reason} disabled={busy} required onChange={e => setReason(e.target.value)} /></Field>
      <Button type="submit" disabled={busy || reason.trim().length < 3}>دوباره بفرست</Button>
    </form>
  </li>;
}
