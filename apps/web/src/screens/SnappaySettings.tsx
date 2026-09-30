import { useEffect, useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { Icon } from "../components/Icon.tsx";
import { PageHeader } from "../components/ui/PageHeader.tsx";
import { Button, Field } from "../components/ui/Controls.tsx";
import { StatusBadge } from "../components/ui/Status.tsx";
import { api, ApiError } from "../lib/api.ts";
import type { AccessState, Verdict } from "../lib/navigation.ts";

/**
 * اسنپ‌پی — ثبت **دستی** پرداخت تأییدشده. این صفحه درخواست پرداخت بانکی،
 * دریافت وجه یا کارمزد خودکار نمی‌سازد و ادعایش را هم نمی‌کند. رفتار ذخیره
 * همان است: یک انتخاب، یک `PUT /snappay/config`؛ سرور حساب و دامنه را می‌سنجد.
 *
 * خواندن `settings.view` می‌خواهد و نوشتن `settings.security` (B1-02). فرم
 * تغییر فقط با `write === "allow"` صریح ساخته می‌شود؛ «در حال بررسی»، «بررسی
 * نشد» و «رد» همه فقط‌خواندنی‌اند و هیچ‌کدام PUT نمی‌فرستند. سرور همچنان دروازه است.
 */
export function SnappaySettings({ write, writeState }: { write: Verdict; writeState: AccessState }) {
  const [accounts, setAccounts] = useState<Array<{ id: string; name: string; bankName: string }>>([]);
  const [selected, setSelected] = useState("");
  const [saved, setSaved] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const canWrite = write === "allow";
  const message = (e: unknown) => e instanceof ApiError ? e.message : "ارتباط با سرور برقرار نشد.";
  useEffect(() => {
    // درخواست خواندن با Unmount لغو می‌شود (B1-04)؛ پاسخ یا خطای دیرهنگام به صفحه نمی‌رسد
    // و لغو خودش خطای کاربر نیست.
    const controller = new AbortController();
    api.get<{ accounts: typeof accounts; accountId: string; enabled: boolean }>("/snappay/config", { signal: controller.signal })
      .then(r => { setAccounts(r.accounts); setSelected(r.accountId); setSaved(r.accountId); setEnabled(r.enabled); setLoaded(true); setBusy(false); })
      .catch((e: unknown) => { if (controller.signal.aborted) return; setError(message(e)); setLoaded(true); setBusy(false); });
    return () => controller.abort();
  }, []);
  async function save() {
    if (!canWrite) return;
    setBusy(true); setError(""); setNote("");
    try { await api.put("/snappay/config", { accountId: selected }); setEnabled(!!selected); setSaved(selected); setNote("تنظیم اسنپ‌پی ذخیره شد."); }
    catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }
  const dirty = canWrite && selected !== saved;
  const current = accounts.find(a => a.id === saved);
  return <div className="settings-page">
    <PageHeader title="اسنپ‌پی"
      context="فقط پرداختی را ثبت کنید که تأیید آن را از اسنپ‌پی گرفته‌اید. این گزینه درخواست پرداخت بانکی، دریافت وجه بانک یا محاسبهٔ خودکار کارمزد انجام نمی‌دهد."
      meta={<>وضعیت: <StatusBadge state={!loaded ? "pending" : enabled ? "active" : "cancelled"} label={!loaded ? "در حال بررسی…" : enabled ? "آمادهٔ ثبت دستی" : "غیرفعال"} /></>} />
    <Solid as="section" className="settings-section" aria-label="تنظیم اسنپ‌پی">
      <div className="settings-form">
        {canWrite ? <>
          <Field label="حساب واسط و بانک تسویه" hint="فهرست فقط حساب‌های فعالِ درگاه با بانک تسویه و نگاشت دفتر معتبر را نشان می‌دهد. شمارهٔ پیگیری در هر پرداخت اجباری است؛ می‌توان بقیهٔ فاکتور را نقد یا با کارت‌خوان پرداخت کرد.">
            <select value={selected} disabled={busy} onChange={e => { setSelected(e.target.value); setNote(""); }}>
              <option value="">غیرفعال — حسابی انتخاب نشده</option>{accounts.map(a => <option key={a.id} value={a.id}>{a.name} ← {a.bankName}</option>)}
            </select>
          </Field>
          <div className="settings-actions">
            <Button variant="primary" busy={busy && loaded} busyLabel="در حال ذخیره…" disabled={busy} onClick={() => void save()}>ذخیرهٔ تنظیم اسنپ‌پی</Button>
            {dirty ? <StatusBadge state="draft" label="ذخیره‌نشده" quiet /> : null}
          </div>
        </> : <>
          {/* فقط‌خواندنی: مقدار فعلی متن است، نه کنترل غیرفعال؛ چیزی برای انتخاب یا ارسال نیست. */}
          <dl className="settings-readonly">
            <dt>حساب واسط و بانک تسویه</dt>
            <dd>{!loaded ? "در حال بارگذاری…" : saved === "" ? "غیرفعال — حسابی انتخاب نشده" : current ? `${current.name} ← ${current.bankName}` : "حساب انتخاب‌شده در فهرست حساب‌های معتبر نیست"}</dd>
          </dl>
          <p className="set-lock" role="status"><Icon name="lock" size="sm" /> {write === "deny"
            ? "فقط مشاهده — تغییر این تنظیم به مجوز «تنظیمات امنیتی» نیاز دارد."
            : writeState === "loading" ? "در حال بررسی مجوز تغییر…" : "مجوز تغییر بررسی نشد؛ تا بررسی نشود این تنظیم فقط دیده می‌شود."}</p>
        </>}
        {error && <p className="field-error" role="alert">{error}</p>}{note && <p className="set-msg" role="status">{note}</p>}
      </div>
    </Solid>
  </div>;
}
