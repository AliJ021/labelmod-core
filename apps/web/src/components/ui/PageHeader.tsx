import type { ReactNode } from "react";

/** سرصفحهٔ هر الگوی صفحه: عنوان، زمینه، کنش اصلی. فقط یک h1 در هر صفحه. */
export function PageHeader({ title, context, meta, actions, eyebrow }: {
  title: string; context?: ReactNode; meta?: ReactNode; actions?: ReactNode; eyebrow?: string;
}) {
  return <header className="page-header">
    <div className="page-header-text">
      {eyebrow ? <p className="page-eyebrow">{eyebrow}</p> : null}
      <h1 className="page-title">{title}</h1>
      {context ? <p className="page-context">{context}</p> : null}
      {meta ? <div className="page-meta">{meta}</div> : null}
    </div>
    {actions ? <div className="page-actions">{actions}</div> : null}
  </header>;
}

/** سرعنوان بخش داخل یک سطح. */
export function SectionHeader({ title, id, description, actions, level = 2 }: {
  title: string; id?: string; description?: ReactNode; actions?: ReactNode; level?: 2 | 3;
}) {
  const H = level === 2 ? "h2" : "h3";
  return <div className="section-header">
    <div>
      <H className="section-title" id={id}>{title}</H>
      {description ? <p className="section-description">{description}</p> : null}
    </div>
    {actions ? <div className="section-actions">{actions}</div> : null}
  </div>;
}
