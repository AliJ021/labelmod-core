/**
 * قاعده شمارنده WebAuthn — به‌شکل یک تابع خالص، پس سنجیدنی.
 *
 * مراسم واقعی WebAuthn به یک Authenticator واقعی نیاز دارد و در این
 * مخزن سنجیده نمی‌شود (`EXTERNAL VERIFICATION REQUIRED`). ولی قاعده‌ای
 * که تصمیم می‌گیرد «این کلید Clone شده است یا نه» **کد ماست**، نه
 * کتابخانه — و آن قاعده باید سنجیده شود.
 *
 * چرا اصلاً کد ماست: کتابخانه برای همین حالت `throw` می‌کند با پیام
 * انگلیسی، و لایه خطا آن را ۵۰۰ می‌کرد. یعنی نشانه کپی‌شدن یک کلید
 * امنیتی، شبیه خرابی سرور گزارش می‌شد — همان الگویی که در این پروژه
 * دو بار پیش‌تر اصلاح شده.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { counterRegressed } from "../src/auth/webauthn.ts";

describe("شمارنده کلید امنیتی", () => {
  test("Authenticatorی که نمی‌شمارد، رد نمی‌شود", () => {
    // اکثر Passkeyهای همگام‌شونده همیشه صفر می‌دهند. اگر این حالت رد
    // می‌شد، رایج‌ترین نوع Passkey اصلاً کار نمی‌کرد.
    assert.equal(counterRegressed(0, 0), false);
  });

  test("صعود عادی رد نمی‌شود", () => {
    assert.equal(counterRegressed(0, 1), false);
    assert.equal(counterRegressed(5, 6), false);
    assert.equal(counterRegressed(41, 9000), false);
  });

  test("درجا زدن رد می‌شود — همان پاسخ، دوباره", () => {
    // شمارنده‌ای که تکان نخورده یعنی این دقیقاً همان پاسخ قبلی است.
    assert.equal(counterRegressed(5, 5), true);
  });

  test("نزول رد می‌شود", () => {
    assert.equal(counterRegressed(5, 4), true);
  });

  test("صفر پس از یک عدد مثبت رد می‌شود", () => {
    // این کلید **می‌شمرد**. حالا صفر می‌دهد — یعنی یا کلید دیگری است
    // یا شمارنده‌اش دستکاری شده. سهل‌گیری اینجا یعنی هر کلیدِ شمارنده‌دار
    // را می‌شد با یک پاسخ صفر دور زد.
    assert.equal(counterRegressed(5, 0), true);
    assert.equal(counterRegressed(1, 0), true);
  });
});
