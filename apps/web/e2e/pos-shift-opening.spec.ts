/**
 * پیوستگی نقد میان دو شیفت (مهاجرت ۱۲۰، تصمیم مالک ۲۰۲۶/۱۱/۱۵): اختلاف رد نمی‌شود، با دلیل
 * پذیرفته می‌شود.
 *
 * فرم از الگوهای نظام طراحی است (`Field`، `Note`، `SafeAction`) نه کلاس‌های قدیمی ورود.
 * صندوق‌دار کور می‌شمارد: سرور عدد مورد انتظار را نمی‌گوید و صفحه هم نشانش نمی‌دهد. وقتی سرور
 * `opening_cash_mismatch` می‌دهد، کادر دلیل ظاهر می‌شود و بی دلیل دکمه بسته است؛ درخواست دوم
 * همان مبلغ را به‌علاوهٔ دلیل می‌فرستد.
 */
import { test, expect } from "./fixtures";

const shift = "44444444-4444-4444-8444-444444444444";
const actor = "22222222-2222-4222-8222-222222222222";

test("موجودی اول ناهم‌خوان: کادر دلیل، و بی دلیل باز نمی‌شود", async ({ page, api }) => {
  api.defaults["GET /payment-methods"] = { methods: [{ code: "cash", name: "نقد", kind: "cash", requiresRef: false }] };
  api.defaults["GET /gift-options"] = { wraps: [], colors: [], flowers: [] };
  api.defaults["GET /pos/products"] = { products: [], exactVariationId: null };
  api.defaults["GET /shifts/current"] = null;
  const bodies: Array<Record<string, unknown>> = [];
  api.handlers.set("POST /shifts", async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    if (body.openingNote === undefined) {
      await route.fulfill({ status: 422, json: { error: { code: "opening_cash_mismatch",
        message: "موجودی اول شیفت با شمارش پایان شیفت قبل نمی‌خواند. دوباره بشمارید، یا اگر درست است دلیل اختلاف را بنویسید.",
        correlationId: "req-1" } } });
      return;
    }
    await route.fulfill({ status: 201, json: { id: shift, userId: actor, branchId: "b1", status: "open", openingCash: body.openingCash,
      openedAt: "2026-11-15T07:00:00Z", closedAt: null, countedCash: null, expectedCash: null, variance: null,
      openingExpected: "50000000", openingVariance: "-30000000", openingNote: body.openingNote } });
  });

  await page.goto("/?page=pos&pos.branch=b1&pos.warehouse=w1");
  await expect(page.getByRole("heading", { name: "شیفت باز نیست" })).toBeVisible();
  const reason = page.getByLabel("دلیل اختلاف");
  await expect(reason, "پیش از پاسخ سرور، کادر دلیل نیست").toHaveCount(0);

  await page.getByLabel("موجودی اولیه (تومان)").fill("2000000");
  await page.getByRole("button", { name: "باز کردن شیفت" }).click();

  // اختلاف حالت فرم است، نه خطا: یادداشت هشدار و کادر دلیل، بی نوار خطا.
  const note = page.locator(".page-note[data-tone=warn]");
  await expect(note).toContainText("با شمارش پایان شیفت قبل نمی‌خواند");
  await expect(note, "عدد مورد انتظار نشان داده نمی‌شود (شمارش کور)").not.toContainText("5,000,000");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(reason).toBeVisible();
  const submit = page.getByRole("button", { name: "باز کردن با ثبت اختلاف" });
  await expect(submit, "بی دلیل بسته است").toBeDisabled();
  await reason.fill("شمارش آخر شب اشتباه بود");
  await expect(submit).toBeEnabled();

  // اثر دفتری دارد، پس از الگوی «عمل مالی ایمن» می‌گذرد: خلاصه، پیامد، تأیید.
  await submit.click();
  const dialog = page.getByRole("dialog", { name: "باز کردن شیفت با ثبت اختلاف" });
  await expect(dialog).toContainText("شمارش آخر شب اشتباه بود");
  await expect(dialog).toContainText("مغایرت صندوق");
  // تصمیم مالک (۲۰۲۶/۱۱/۱۵): تا صفحهٔ سند دستی/معکوس ساخته نشده، راه اصلاح حسابدار است، نه ابزاری که نیست.
  await expect(dialog).toContainText("اصلاحش با حسابدار است");
  await expect(dialog).not.toContainText("سند معکوس");
  expect(bodies, "پیش از تأیید هیچ درخواست دومی نرفته").toHaveLength(1);
  await dialog.getByRole("button", { name: "باز کردن شیفت" }).click();

  await expect(page.getByRole("heading", { name: "شیفت باز نیست" })).toHaveCount(0);
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toEqual({ branchId: "b1", openingCash: "20000000" });
  expect(bodies[1]).toEqual({ branchId: "b1", openingCash: "20000000", openingNote: "شمارش آخر شب اشتباه بود" });
  await api.settled();
});
