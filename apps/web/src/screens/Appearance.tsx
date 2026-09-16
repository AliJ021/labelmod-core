import { useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { getPerf, setPerf, type Perf } from "../lib/theme.ts";

export function Appearance() {
  const [perf, updatePerf] = useState<Perf>(getPerf);
  return <Solid className="pad preference-card">
    <div><h2>نمایش و عملکرد</h2><p className="muted">این ترجیح برای همین مرورگر ذخیره می‌شود.</p></div>
    <label className="preference-row">
      <span><strong>حالت عملکرد</strong><span className="muted small">با کاهش جلوه‌های شیشه‌ای، کار با دستگاه‌های ضعیف‌تر روان‌تر می‌شود.</span></span>
      <select value={perf} onChange={(e) => { const next = e.target.value as Perf; setPerf(next); updatePerf(next); }}>
        <option value="system">مطابق سیستم</option><option value="on">روشن</option><option value="off">خاموش</option>
      </select>
    </label>
  </Solid>;
}
