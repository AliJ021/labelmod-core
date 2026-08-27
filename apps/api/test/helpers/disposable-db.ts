/**
 * دیتابیس یک‌بارمصرف برای تست یکپارچه.
 *
 * همان تصمیمی که ops/db.sh test گرفته: هر اجرا روی یک دیتابیس تازه.
 *
 * چرا پاک‌کردن داده کافی نیست — و این را با شکست تست فهمیدیم:
 * identity.auth_attempt عمداً تغییرناپذیر است، پس DELETE رویش خطا
 * می‌دهد؛ و چون user_id به app_user ارجاع دارد، کاربر تست هم قابل حذف
 * نیست. یعنی هر تلاشی برای «تمیزکاری» یا باید نگهبان را ضعیف کند یا
 * آشغال جا بگذارد. انداختن کل دیتابیس هیچ‌کدام را نمی‌خواهد.
 *
 * مهاجرت از خودِ ops/db.sh اجرا می‌شود، نه از یک مسیر موازی: دو مسیر
 * مهاجرت یعنی روزی یکی از دیگری عقب می‌ماند.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../../../..");

export interface DisposableDb {
  url: string;
  drop(): void;
}

/** نام دیتابیس را در رشته اتصال عوض می‌کند، بدون دست‌زدن به بقیه. */
function swapDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

function psql(adminUrl: string, command: string): void {
  execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-q", "-d", adminUrl, "-c", command], {
    stdio: "pipe",
    env: { ...process.env, PGCLIENTENCODING: "UTF8" },
  });
}

/**
 * دیتابیس تازه می‌سازد، مهاجرت و داده مرجع را بار می‌کند و رشته اتصالش
 * را برمی‌گرداند. اگر psql در دسترس نباشد، null برمی‌گرداند تا تست
 * skip شود نه اینکه سبز وانمود کند.
 */
export function createDisposableDb(adminUrl: string): DisposableDb | null {
  const name = `labelmod_apitest_${randomBytes(6).toString("hex")}`;
  const url = swapDatabase(adminUrl, name);

  try {
    psql(adminUrl, `CREATE DATABASE "${name}"`);
  } catch {
    return null;
  }

  try {
    for (const step of ["migrate", "seed"]) {
      execFileSync("bash", [path.join(REPO_ROOT, "ops/db.sh"), step], {
        cwd: REPO_ROOT,
        stdio: "pipe",
        env: { ...process.env, DATABASE_URL: url, PGCLIENTENCODING: "UTF8" },
      });
    }
  } catch (err) {
    psql(adminUrl, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    throw err;
  }

  return {
    url,
    drop() {
      try {
        psql(adminUrl, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } catch {
        // انداختن دیتابیس تست نباید نتیجه تست را عوض کند
      }
    },
  };
}
