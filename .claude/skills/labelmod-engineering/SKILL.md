---
name: labelmod-engineering
description: نقشهٔ راه کار مهندسی در Label Mod Core — کدام سند برای طراحی رابط، الگوی صفحه، قواعد مالی، امنیت، مهاجرت، آزمون، ماتریس مرورگر و مرز استقرار مرجع است. Use when starting any UI, design-system, feature, migration or test task in this repository, before writing code.
---

# کار مهندسی در لیبل مد

این Skill چیزی را تکرار نمی‌کند؛ فقط می‌گوید کجا بخوانی. `CLAUDE.md` بر همه مقدم است و
**هرجا راحتی و صحت مالی تعارض دارند، صحت برنده است.**

| کار | اول بخوان |
|---|---|
| هر تغییر رابط | `.claude/rules/design.md` ← `docs/DESIGN_SYSTEM.md` ← `docs/UI_PATTERNS.md` |
| ویژگی تازه | `docs/FEATURE_DEVELOPMENT_RULES.md` (۱۲ پرسش؛ پاسخ در توضیح PR) |
| primitive یا الگوی بصری | UI Kit زنده: `pnpm --filter @labelmod/web dev` و سپس `/dev/ui-kit` |
| منطق مالی، پول، سند، انبار | `CLAUDE.md` «قواعد غیرقابل مذاکره»، `.claude/rules/sql.md`، `docs/ADR-006-costing.md` |
| API | `.claude/rules/api.md`، `docs/SECURITY.md` |
| مهاجرت | مهاجرت اجراشده ویرایش نمی‌شود؛ شمارهٔ بعدی را از `db/migrations/` بخوان؛ `ADD CONSTRAINT` دو مرحله‌ای |
| امنیت | `docs/SECURITY.md`، `docs/SECURITY-FINDINGS-HANDOFF-2026-09-26.md` — ردیف باز را «بسته» ننویس |
| استقرار | `docs/DEPLOYMENT.md` — آمادهٔ ادغام ≠ آمادهٔ تولید |

## آزمون، متناسب با تغییر

- رابط: `pnpm --filter @labelmod/web test` (واحد: توکن، جهت، پالت، ناوبری، عدد مالی) و
  `pnpm --filter @labelmod/web build`؛ مرورگر: `pnpm --filter @labelmod/web test:e2e` —
  ۲ موتور (Chromium و **WebKit**) × ۲ تم × ۶ عرض = ۲۴ پروژه، چهار Shard در CI.
- مالی: `ops/db.sh test` روی دیتابیس یک‌بارمصرف؛ API با نقش مالک **و** `LMC_TEST_DB_ROLE=app`.
- ریشه: `pnpm lint`، `pnpm typecheck`، `pnpm audit --prod --audit-level high`.

## هرگز

- آزمون را حذف، Skip یا ضعیف نکن؛ retry یا timeout سراسری را بالا نبر؛ `sleep` دلخواه نگذار.
- WebKit یا عرضی را از ماتریس برندار؛ کرش WebKit را بی‌شاهد canonical «flake» نخوان.
- `seed` روی دیتابیس اصلی؛ بازنویسی سند قطعی یا حسابرسی؛ فعال‌سازی `Bardia` یا `recovery_admin`.
- صفحه‌ای را پیش از تأیید بصری مالک و بازبینی مستقل با نظام طراحی تازه بازطراحی نکن.
