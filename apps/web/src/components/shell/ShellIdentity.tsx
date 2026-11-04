/**
 * کارت شعبه بالای منو و نام کاربر پایین آن (طرح ۱۰). هر دو فقط نمایش‌اند:
 * انتخاب شعبه کار صفحه‌هاست (صندوق، گزارش)، و منوی حساب همان دکمهٔ نوار بالاست.
 * شعبه از همان پاسخ `/branches` دامنهٔ خود کاربر است که صفحه‌ها می‌خوانند (`knownBranches`)؛
 * تا نرسیده یا با خطا، کارت چیزی ادعا نمی‌کند: قابش جا نگه می‌دارد و پنهان می‌ماند.
 */
import { useEffect, useState } from "react";
import { knownBranches, onBranches, pos, type Branch } from "../../lib/pos.ts";
import { formatCount } from "../../lib/format.ts";
import { Icon } from "../Icon.tsx";
import { AccountMenu } from "../HeaderTools.tsx";
import type { Me } from "../../lib/session.ts";

/** نشان و نام بالای نوار کناری (طرح ۱۰)؛ در گوشی همان نشان سربرگ می‌ماند. */
export function ShellBrand() {
  return <div className="shell-brand">
    <span className="shell-brand-mark" aria-hidden="true"><Icon name="layers" /></span>
    <span className="shell-brand-text"><strong>لیبل مد</strong><small lang="en">Label.mod</small></span>
  </div>;
}

export function ShellBranch() {
  const [branches, setBranches] = useState<Branch[]>(() => knownBranches() ?? []);
  useEffect(() => {
    const off = onBranches(setBranches);
    // اگر هنوز کسی شعبه را نخوانده، همان لحظهٔ بار شدن و هم‌زمان با درخواست‌های خود صفحه خوانده می‌شود.
    // درخواستِ تأخیری (۲٫۵ ثانیه) وسط جابه‌جایی صفحه می‌ماند و WebKit قطعش را خطای صفحه گزارش می‌کرد.
    const controller = new AbortController();
    if (knownBranches() === null) void pos.branches({ signal: controller.signal }).catch(() => {});
    return () => { off(); controller.abort(); };
  }, []);
  // جای کارت از اول نگه داشته می‌شود: کارتی که دیر برسد کل منو را پایین می‌راند (جابه‌جایی چیدمان).
  // تا شعبه نرسیده، همان قاب پنهان و بی‌متن است — نه نامی، نه ادعایی.
  if (branches.length === 0) return <div className="shell-branch" data-pending="" aria-hidden="true">
    <span className="shell-branch-icon" />
    <span className="shell-branch-text"><strong>{"\u00a0"}</strong><small>{"\u00a0"}</small></span>
  </div>;
  return <div className="shell-branch">
    <span className="shell-branch-icon" aria-hidden="true"><Icon name="store" size="sm" /></span>
    <span className="shell-branch-text">
      <strong>{branches[0]!.name}</strong>
      <small>{branches.length > 1 ? `${formatCount(branches.length)} شعبه در دامنهٔ شما` : "فروشگاه پوشاک"}</small>
    </span>
  </div>;
}

/**
 * پای نوار کناری (طرح ۱۰): کاربر با نوع نشست — خودش دکمهٔ حساب است — و خروج کنارش.
 * همان کنترل‌های نوار بالای گوشی‌اند؛ در دسکتاپ نوار بالا فقط قفل و تم دارد.
 */
export function ShellUser({ me, onPassword, onReauth, onLogout }: { me: Me; onPassword: () => void; onReauth: () => void; onLogout: () => void }) {
  const initial = me.fullName.trim().charAt(0);
  return <div className="shell-user">
    <AccountMenu me={me} onPassword={onPassword} onReauth={onReauth} variant="footer">
      <span className="shell-user-avatar" aria-hidden="true">{initial}{!me.elevated ? <span className="account-pin" /> : null}</span>
      <span className="shell-user-text" aria-hidden="true"><strong>{me.fullName}</strong><small>{me.elevated ? "نشست کامل" : "نشست PIN"}</small></span>
    </AccountMenu>
    <button type="button" className="icon-button shell-logout" aria-label="خروج" title="خروج" onClick={onLogout}><Icon name="logout" /></button>
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
