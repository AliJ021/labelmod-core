import { createContext, useContext, type ReactNode } from "react";

/**
 * بخش‌های درون یک ناحیه (تنظیمات، برداشت و پاداش) سرصفحهٔ ناحیه را بالای خود دارند (طرح ۱۰)؛
 * پس سرصفحهٔ بخش h2 است، نه h1 دوم. ناحیه این زمینه را روشن می‌کند، نه هر بخش.
 */
const NestedHeader = createContext(false);
export function NestedPageHeaders({ children }: { children: ReactNode }) {
  return <NestedHeader.Provider value={true}>{children}</NestedHeader.Provider>;
}

/** سرصفحهٔ هر الگوی صفحه: عنوان، زمینه، کنش اصلی. فقط یک h1 در هر صفحه. */
export function PageHeader({ title, context, meta, actions, eyebrow }: {
  title: string; context?: ReactNode; meta?: ReactNode; actions?: ReactNode; eyebrow?: string;
}) {
  const nested = useContext(NestedHeader);
  const H = nested ? "h2" : "h1";
  return <header className={nested ? "page-header page-header--nested" : "page-header"}>
    <div className="page-header-text">
      {eyebrow && !nested ? <p className="page-eyebrow">{eyebrow}</p> : null}
      <H className="page-title">{title}</H>
      {/* طرح ۱۰: زمینه و تازگی در یک سطر زیر عنوان؛ در عرض تنگ می‌شکند. */}
      {context || meta ? <div className="page-sub">
        {context ? <p className="page-context">{context}</p> : null}
        {meta ? <div className="page-meta">{meta}</div> : null}
      </div> : null}
    </div>
    {actions ? <div className="page-actions">{actions}</div> : null}
  </header>;
}

/** سرعنوان بخش داخل یک سطح. */
export function SectionHeader({ title, id, description, actions, level = 2 }: {
  title: string; id?: string; description?: ReactNode; actions?: ReactNode; level?: 2 | 3;
}) {
  // درون ناحیه‌ای که سرصفحهٔ بخشش h2 است، بخش‌ها یک پله پایین‌تر می‌روند تا سلسله‌مراتب بشکند نه تکرار شود.
  const nested = useContext(NestedHeader);
  const H = nested ? (level === 2 ? "h3" : "h4") : level === 2 ? "h2" : "h3";
  return <div className="section-header">
    <div>
      <H className="section-title" id={id}>{title}</H>
      {description ? <p className="section-description">{description}</p> : null}
    </div>
    {actions ? <div className="section-actions">{actions}</div> : null}
  </div>;
}
