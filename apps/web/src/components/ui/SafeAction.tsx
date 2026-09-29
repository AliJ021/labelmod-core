import { useState, type ReactNode } from "react";
import { classifyFailure, mayConfirm, type ActionFailure, type SafeActionPhase } from "../../lib/safe-action.ts";
import { Icon } from "../Icon.tsx";
import { Ltr } from "./Bidi.tsx";
import { Button } from "./Controls.tsx";
import { Dialog } from "./Dialog.tsx";
import { StatusBadge } from "./Status.tsx";

/**
 * عمل مالی ایمن — خلاصه، پیامد، تأیید، در حال اجرا، نتیجه
 * (docs/UI_PATTERNS.md، «عمل مالی ایمن»).
 *
 * سه قاعده که این کامپوننت خودش اجبار می‌کند:
 *   ۱. کنش نهایی ظاهر خودش را دارد (`tone`) و از پیمایش جداست.
 *   ۲. در حال اجرا، بستن و تأیید دوباره ممکن نیست.
 *   ۳. نتیجهٔ **نامعلوم** دکمهٔ «ارسال دوباره» ندارد؛ فقط «بررسی وضعیت»
 *      که با `verify` از سرور می‌خواند. اگر سرور بگوید انجام نشده، تأیید
 *      دوباره با وضعیت معلوم مجاز است.
 */
export function SafeAction({ trigger, title, summary, consequence, confirmLabel, pendingLabel, tone = "final", run, verify, onDone, disabled = false, triggerVariant = "link" }: {
  trigger: string;
  title: string;
  summary: ReactNode;
  consequence: ReactNode;
  confirmLabel: string;
  pendingLabel: string;
  tone?: "final" | "destructive";
  run: () => Promise<void>;
  /** «آیا اثر نشسته است؟» — فقط خواندن. */
  verify: () => Promise<boolean>;
  onDone: (outcome: "done" | "verified") => void;
  disabled?: boolean;
  triggerVariant?: "link" | "button";
}) {
  const [phase, setPhase] = useState<SafeActionPhase>("idle");
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const locked = phase === "pending" || phase === "verifying";

  async function confirm() {
    if (!mayConfirm(phase)) return;
    setPhase("pending"); setFailure(null); setNote(null);
    try {
      await run();
      setPhase("done"); setOpen(false);
      onDone("done");
    } catch (err) {
      const f = classifyFailure(err);
      setFailure(f);
      setPhase(f.kind);
    }
  }

  async function check() {
    setPhase("verifying"); setNote(null);
    try {
      if (await verify()) { setPhase("done"); setOpen(false); onDone("verified"); return; }
      setFailure(null);
      setNote("سرور تأیید کرد که عملیات انجام نشده است. اکنون می‌توانید با اطمینان دوباره تأیید کنید.");
      setPhase("confirm");
    } catch {
      setPhase("unknown");
      setNote("وضعیت هنوز از سرور خوانده نشد. اتصال را بررسی کنید و دوباره «بررسی وضعیت» را بزنید.");
    }
  }

  const unknown = phase === "unknown" || phase === "verifying";
  // نامعلوم پس از بستن پنجره هم نامعلوم می‌ماند: دکمهٔ ردیف دیگر «اجرا» نیست.
  const triggerLabel = phase === "unknown" ? "نتیجه نامعلوم؛ بررسی وضعیت" : trigger;
  return <>
    <button type="button" className={triggerVariant === "link" ? "link" : "btn"} disabled={disabled || locked}
      onClick={() => { if (phase === "idle" || phase === "done") setPhase("confirm"); setOpen(true); }}>
      {triggerLabel}
    </button>
    <Dialog open={open} onClose={() => { if (locked) return; setOpen(false); if (phase !== "unknown") setPhase("idle"); }}
      title={title} dismissible={!locked} tone={tone} size="md"
      footer={unknown
        ? <Button variant="primary" busy={phase === "verifying"} busyLabel="در حال بررسی…" icon={<Icon name="refresh" size="sm" />} onClick={() => void check()}>بررسی وضعیت</Button>
        : <>
            <Button variant={tone === "destructive" ? "danger" : "primary"} busy={phase === "pending"} busyLabel={pendingLabel} onClick={() => void confirm()}>{confirmLabel}</Button>
            <Button variant="quiet" disabled={locked} onClick={() => { setOpen(false); setPhase("idle"); }}>انصراف</Button>
          </>}>
      <div className="safe-summary">{summary}</div>
      {unknown ? null : <p className="safe-consequence"><Icon name="info" size="sm" /><span>{consequence}</span></p>}
      {phase === "failed" && failure ? <div className="safe-outcome safe-outcome--failed" role="alert">
        <StatusBadge state="failed" label="انجام نشد" />
        <p>{failure.message}</p>
        {failure.reference ? <p className="field-hint">شناسهٔ پیگیری: <Ltr>{failure.reference}</Ltr></p> : null}
      </div> : null}
      {unknown && failure ? <div className="safe-outcome safe-outcome--unknown" role="alert">
        <StatusBadge state="unknown" label="نتیجه نامعلوم" />
        <p>{failure.message}</p>
        <p className="field-hint">دوباره تأیید نکنید؛ اگر عملیات انجام شده باشد، بررسی وضعیت آن را نشان می‌دهد.</p>
        {failure.reference ? <p className="field-hint">شناسهٔ پیگیری: <Ltr>{failure.reference}</Ltr></p> : null}
      </div> : null}
      {note ? <p className="safe-note" role="status">{note}</p> : null}
    </Dialog>
  </>;
}
