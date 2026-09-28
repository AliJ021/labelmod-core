/**
 * زمینهٔ امضای لیبل مد (docs/DESIGN_SYSTEM.md، «جلوهٔ امضا»).
 *
 *   auth       ورود و قفل: نور فلزی آرام که فقط اینجا حرکت می‌کند.
 *   workspace  صفحه‌های داده: همان نور، **ساکن**. هیچ انیمیشن بی‌پایانی
 *              پشت عدد مالی نیست.
 *
 * بدون WebGL: جلوه با گرادیان و transform ساخته می‌شود؛ حالت عملکرد،
 * کاهش شفافیت و کاهش حرکت آن را کامل برمی‌دارند (glass.css).
 */
export function Backdrop({ variant }: { variant: "auth" | "workspace" }) {
  return <div className={`mesh mesh--${variant}`} aria-hidden="true">
    <i />
    <i />
    <i />
  </div>;
}
