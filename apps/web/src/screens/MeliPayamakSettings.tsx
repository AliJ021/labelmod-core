import { useEffect, useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { api, ApiError } from "../lib/api.ts";

interface Credential {
  accountName: string;
  hasKey: boolean;
  revision: number;
  storageReady: boolean;
  canEdit: boolean;
}

export function MeliPayamakSettings() {
  const [value, setValue] = useState<Credential | null>(null);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    api.get<Credential>("/settings/melipayamak-credential").then((r) => {
      if (alive) { setValue(r); setName(r.accountName); }
    }).catch((e: unknown) => { if (alive) setError(e instanceof ApiError ? e.message : "دریافت تنظیم اتصال ممکن نشد"); });
    return () => { alive = false; };
  }, []);

  async function save() {
    if (!value) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const r = await api.put<Credential>("/settings/melipayamak-credential", {
        revision: value.revision, accountName: name,
        ...(key.trim() ? { apiKey: key.trim() } : {}), clearKey,
      });
      setValue(r); setName(r.accountName); setKey(""); setClearKey(false);
      setMessage("تنظیم اتصال ذخیره شد. این کار پیامکی ارسال نمی‌کند و ارسال را فعال نمی‌کند.");
    } catch (e) { setError(e instanceof ApiError ? e.message : "ذخیره انجام نشد"); }
    finally { setBusy(false); }
  }

  const disabled = busy || !value?.canEdit;
  return <Solid className="pad stack" style={{ gap: "var(--s-3)" }}>
    <h2 style={{ fontSize: "1.1rem", margin: 0 }}>اتصال ملی‌پیامک</h2>
    <p className="muted small" style={{ margin: 0 }}>
      API کلیددار ملی‌پیامک. نام حساب فقط برای شناسایی پنل است؛ احراز هویت با کلید انجام می‌شود.
      سرویس‌دهنده و شمارهٔ فرستنده را از تنظیمات همین گروه انتخاب کنید.
    </p>
    {error ? <p role="alert">{error}</p> : null}
    {value ? <form className="stack" style={{ gap: "var(--s-3)" }} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <p className="small" style={{ margin: 0 }}>{value.hasKey ? "کلید ذخیره شده است؛ مقدار آن نمایش داده نمی‌شود." : "هنوز کلیدی ذخیره نشده است."}</p>
      {!value.storageReady ? <p role="status">ذخیرهٔ امن کلید روی سرور آماده نیست؛ برای آماده‌سازی با مدیر سرور تماس بگیرید.</p> : null}
      <label className="stack">نام حساب / نام کاربری پنل (اختیاری)
        <input className="set-input" value={name} maxLength={100} autoComplete="off" disabled={disabled}
          onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="stack">کلید API جدید ملی‌پیامک
        <input className="set-input" type="password" value={key} maxLength={2048} autoComplete="new-password"
          disabled={disabled || !value.storageReady || clearKey} onChange={(e) => setKey(e.target.value)} />
      </label>
      <p className="muted small" style={{ margin: 0 }}>برای نگه‌داشتن کلید فعلی، این کادر را خالی بگذارید. ذخیرهٔ کلید به معنی تأیید اتصال یا تحویل پیامک نیست.</p>
      {value.hasKey ? <label><input type="checkbox" checked={clearKey} disabled={disabled}
        onChange={(e) => { setClearKey(e.target.checked); if (e.target.checked) setKey(""); }} /> حذف کلید ذخیره‌شده (ارسال ملی‌پیامک متوقف می‌شود)</label> : null}
      <button className="btn btn-primary" type="submit" disabled={disabled}>{busy ? "در حال ذخیره…" : "ذخیرهٔ اتصال ملی‌پیامک"}</button>
      {message ? <p role="status">{message}</p> : null}
    </form> : !error ? <p className="muted">در حال دریافت تنظیم اتصال…</p> : null}
  </Solid>;
}
