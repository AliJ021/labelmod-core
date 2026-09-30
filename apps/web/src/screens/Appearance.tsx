import { useState } from "react";
import { Solid } from "../components/Glass.tsx";
import { PageHeader } from "../components/ui/PageHeader.tsx";
import { Field } from "../components/ui/Controls.tsx";
import { getPerf, setPerf, type Perf } from "../lib/theme.ts";

/**
 * ترجیح شخصی نمایش — فقط همین مرورگر؛ هیچ درخواستی به سرور نمی‌رود.
 * تغییر همان لحظه اعمال می‌شود (ذخیرهٔ جدا ندارد) و این رفتارِ پیشین است.
 */
export function Appearance() {
  const [perf, updatePerf] = useState<Perf>(getPerf);
  return <div className="settings-page">
    <PageHeader title="نمایش و عملکرد" context="این ترجیح فقط برای همین مرورگر ذخیره می‌شود و همان لحظه اعمال می‌شود." />
    <Solid as="section" className="settings-section" aria-label="ترجیح نمایش">
      <div className="settings-form">
        <Field label="حالت عملکرد" hint="با برداشتن جلوه‌های شیشه‌ای و حرکت زمینه، کار با دستگاه‌های ضعیف‌تر روان‌تر می‌شود. «مطابق سیستم» از تنظیم کاهش شفافیت دستگاه پیروی می‌کند.">
          <select value={perf} onChange={e => { const next = e.target.value as Perf; setPerf(next); updatePerf(next); }}>
            <option value="system">مطابق سیستم</option><option value="on">روشن</option><option value="off">خاموش</option>
          </select>
        </Field>
      </div>
    </Solid>
  </div>;
}
