import { useEffect, useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { PageHeader } from "../components/ui/PageHeader.tsx";
import { Button, Field } from "../components/ui/Controls.tsx";
import { StatusBadge } from "../components/ui/Status.tsx";
import { api, ApiError } from "../lib/api.ts";

/**
 * اسنپ‌پی — ثبت **دستی** پرداخت تأییدشده. این صفحه درخواست پرداخت بانکی،
 * دریافت وجه یا کارمزد خودکار نمی‌سازد و ادعایش را هم نمی‌کند. رفتار ذخیره
 * همان است: یک انتخاب، یک `PUT /snappay/config`؛ سرور حساب و دامنه را می‌سنجد.
 */
export function SnappaySettings() {
  const [accounts, setAccounts] = useState<Array<{ id: string; name: string; bankName: string }>>([]);
  const [selected, setSelected] = useState("");
  const [saved, setSaved] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const message = (e: unknown) => e instanceof ApiError ? e.message : "ارتباط با سرور برقرار نشد.";
  useEffect(() => {
    let alive = true;
    void api.get<{ accounts: typeof accounts; accountId: string; enabled: boolean }>("/snappay/config")
      .then(r => { if (alive) { setAccounts(r.accounts); setSelected(r.accountId); setSaved(r.accountId); setEnabled(r.enabled); } })
      .catch(e => { if (alive) setError(message(e)); }).finally(() => { if (alive) { setBusy(false); setLoaded(true); } });
    return () => { alive = false; };
  }, []);
  async function save() {
    setBusy(true); setError(""); setNote("");
    try { await api.put("/snappay/config", { accountId: selected }); setEnabled(!!selected); setSaved(selected); setNote("تنظیم اسنپ‌پی ذخیره شد."); }
    catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }
  const dirty = selected !== saved;
  return <div className="settings-page">
    <PageHeader title="اسنپ‌پی"
      context="فقط پرداختی را ثبت کنید که تأیید آن را از اسنپ‌پی گرفته‌اید. این گزینه درخواست پرداخت بانکی، دریافت وجه بانک یا محاسبهٔ خودکار کارمزد انجام نمی‌دهد."
      meta={<>وضعیت: <StatusBadge state={!loaded ? "pending" : enabled ? "active" : "cancelled"} label={!loaded ? "در حال بررسی…" : enabled ? "آمادهٔ ثبت دستی" : "غیرفعال"} /></>} />
    <Solid as="section" className="settings-section" aria-label="تنظیم اسنپ‌پی">
      <div className="settings-form">
        <Field label="حساب واسط و بانک تسویه" hint="فهرست فقط حساب‌های فعالِ درگاه با بانک تسویه و نگاشت دفتر معتبر را نشان می‌دهد. شمارهٔ پیگیری در هر پرداخت اجباری است؛ می‌توان بقیهٔ فاکتور را نقد یا با کارت‌خوان پرداخت کرد.">
          <select value={selected} disabled={busy} onChange={e => { setSelected(e.target.value); setNote(""); }}>
            <option value="">غیرفعال — حسابی انتخاب نشده</option>{accounts.map(a => <option key={a.id} value={a.id}>{a.name} ← {a.bankName}</option>)}
          </select>
        </Field>
        <div className="settings-actions">
          <Button variant="primary" busy={busy && loaded} busyLabel="در حال ذخیره…" disabled={busy} onClick={() => void save()}>ذخیرهٔ تنظیم اسنپ‌پی</Button>
          {dirty ? <StatusBadge state="draft" label="ذخیره‌نشده" quiet /> : null}
        </div>
        {error && <p className="field-error" role="alert">{error}</p>}{note && <p className="set-msg" role="status">{note}</p>}
      </div>
    </Solid>
  </div>;
}
