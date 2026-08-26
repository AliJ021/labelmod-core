# انتقال پروژه به Claude Code

راهنمای یک‌بارمصرف برای راه‌اندازی روی دستگاه خودتان.

## چرا این کار درست است

هر سه محدودیتی که در سندباکس ابری با آن‌ها جنگیدیم، روی دستگاه شما وجود
ندارند: `npm` باز است، `git` به GitHub می‌رسد، و PostgreSQL خاموش نمی‌شود.
ضمناً Claude Code مستقیم به فایل‌ها دسترسی دارد، پس دیگر رفت‌وبرگشت فایل
tar لازم نیست.

## ۰. پیش‌نیاز حساب

Claude Code به حساب **Pro، Max، Team یا Enterprise** نیاز دارد.
**پلن رایگان Claude.ai شامل Claude Code نمی‌شود.**

## ۱. نصب Claude Code

**macOS / Linux / WSL**
```bash
curl -fsSL https://claude.ai/install.sh | bash
```

**ویندوز — PowerShell**
```powershell
irm https://claude.ai/install.ps1 | iex
```

روی ویندوز، نصب [Git for Windows](https://git-scm.com/downloads/win) توصیه
می‌شود تا Claude Code از Git Bash استفاده کند؛ بدون آن به PowerShell
برمی‌گردد.

بررسی نصب:
```bash
claude --version
claude doctor        # تشخیص کامل نصب و تنظیمات
```

## ۲. پیش‌نیازهای پروژه

- **Node.js 22+** — [nodejs.org](https://nodejs.org)
- **Docker Desktop** — برای PostgreSQL
- **Git**

## ۳. راه‌اندازی مخزن

```bash
tar xzf labelmod-core.tar.gz
cd labelmod

ops/install-hooks.sh                 # هوک pre-push

git remote add origin https://github.com/AliJ021/labelmod-core.git
git branch -M main
git push -u origin main
```

## ۴. بالا آوردن دیتابیس

```bash
cp .env.example .env                 # رمز را عوض کنید
docker compose up -d db

export DATABASE_URL='postgres://labelmod:<همان رمز>@localhost:5432/labelmod'

ops/db.sh migrate
ops/db.sh seed
ops/db.sh test                       # باید ۵۶ ادعا پاس شود
```

اگر `ops/db.sh test` سبز نشد، **هیچ کار دیگری نکنید** تا علتش پیدا شود.

> روی ویندوز بدون WSL، `DATABASE_URL` را در PowerShell این‌طور ست کنید:
> `$env:DATABASE_URL='postgres://…'`
> و اسکریپت‌های `.sh` را از Git Bash اجرا کنید، نه از PowerShell.

## ۵. شروع Claude Code

```bash
cd labelmod
claude
```

در اولین نشست، این‌ها را بزنید:

| دستور | چه می‌کند |
|---|---|
| `/context` | تأیید اینکه `CLAUDE.md` و `.claude/rules/` بارگذاری شده‌اند |
| `/memory` | مرور و ویرایش فایل‌های حافظه |

زیر **Memory files** باید `CLAUDE.md` و سه فایل `.claude/rules/` را ببینید.
اگر نبودند، از پوشه اشتباهی `claude` را اجرا کرده‌اید.

## ۶. آنچه context را منتقل می‌کند

گفت‌وگوی ما منتقل نمی‌شود — ولی همه تصمیماتش در مخزن است:

| فایل | نقش |
|---|---|
| `CLAUDE.md` | هر نشست خودکار خوانده می‌شود. قواعد غیرقابل مذاکره، دستورها، گلوگاه‌ها |
| `.claude/rules/sql.md` | فقط هنگام کار روی `db/**` بارگذاری می‌شود |
| `.claude/rules/design.md` | فقط هنگام کار روی UI |
| `.claude/rules/api.md` | فقط هنگام کار روی API و Worker |
| `docs/ADR-001` `ADR-002` `SECURITY.md` | استدلال پشت تصمیم‌ها |

قواعد مسیرمحور فقط وقتی وارد context می‌شوند که Claude فایل مربوطه را
بخواند — یعنی نشست UI با قواعد SQL شلوغ نمی‌شود.

**`/init` نزنید.** فایل موجود دست‌نویس است و تصمیماتی دارد که Claude از
روی کد نمی‌تواند حدس بزند.

## ۷. اولین کار پیشنهادی

```
لایه API را بساز: Fastify + Kysely روی توابع SQL موجود.
اول فقط احراز هویت و endpoint کاتالوگ. قبل و بعدش ops/db.sh test بزن.
```

## عیب‌یابی

**Claude قواعد را رعایت نمی‌کند** → `/context` بزنید و ببینید فایل‌ها
بارگذاری شده‌اند یا نه. اگر نبودند، مسیر اجرا اشتباه است.

**`ops/db.sh` روی ویندوز اجرا نمی‌شود** → از Git Bash یا WSL استفاده کنید.

**`docker compose` پیدا نمی‌شود** → Docker Desktop باید در حال اجرا باشد.

**تست همزمانی رد می‌شود** → مطمئن شوید نقش دیتابیس اجازه `CREATE DATABASE`
دارد؛ `ops/db.sh test` برای هر اجرا یک دیتابیس موقت می‌سازد.
