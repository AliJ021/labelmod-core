/**
 * کارت شعبه بالای منو و نام کاربر پایین آن (طرح ۱۰). هر دو فقط نمایش‌اند:
 * انتخاب شعبه کار صفحه‌هاست (صندوق، گزارش)، و منوی حساب همان دکمهٔ نوار بالاست.
 * شعبه از `/branches` دامنهٔ خود کاربر می‌آید؛ تا نرسیده یا با خطا، کارت چیزی
 * ادعا نمی‌کند و پنهان می‌ماند.
 */
import { useCallback } from "react";
import { useLatestQuery } from "../../lib/use-latest-query.ts";
import { pos } from "../../lib/pos.ts";
import { formatCount } from "../../lib/format.ts";
import { Icon } from "../Icon.tsx";

export function ShellBranch() {
  const load = useCallback((signal: AbortSignal) => pos.branches({ signal }), []);
  const q = useLatestQuery({ key: "shell-branch", load });
  const branches = q.error ? [] : q.data?.branches ?? [];
  if (branches.length === 0) return null;
  return <div className="shell-branch">
    <span className="shell-branch-icon" aria-hidden="true"><Icon name="register" size="sm" /></span>
    <span className="shell-branch-text">
      <strong>{branches[0]!.name}</strong>
      <small>{branches.length > 1 ? `${formatCount(branches.length)} شعبه در دامنهٔ شما` : "فروشگاه پوشاک"}</small>
    </span>
  </div>;
}

export function ShellUser({ name }: { name: string }) {
  const initial = name.trim().charAt(0);
  return <div className="shell-user">
    <span className="shell-user-avatar" aria-hidden="true">{initial}</span>
    <span className="shell-user-text"><strong>{name}</strong><small>کاربر واردشده</small></span>
  </div>;
}

/** مسیر صفحه در نوار بالا: «گروه › بخش». بخش جاری `aria-current="page"` دارد. */
export function ShellTrail({ group, label }: { group: string; label: string }) {
  return <nav className="shell-trail" aria-label="مسیر صفحه">
    <span>{group}</span>
    <Icon name="chevron" size="sm" />
    <span aria-current="page">{label}</span>
  </nav>;
}
