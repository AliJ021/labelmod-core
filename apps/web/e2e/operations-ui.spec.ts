import {test, expect, type MockApi} from "./fixtures";

const backup = {id:"11111111-1111-4111-8111-111111111111",createdAt:"2026-10-10T08:30:00Z",bytes:10485760,serverMajor:16};
function health(api: MockApi) {
  api.defaults["GET /health/alerts"] = {alerts:[
    {code:"outbox_dead",severity:"critical",title:"پیام‌های نیازمند رسیدگی",count:2,detail:"ارسال پیام‌ها پس از چند تلاش متوقف شده است."},
    {code:"backup_age",severity:"warn",title:"زمان آخرین پشتیبان‌گیری",count:1,detail:"بیش از یک روز از آخرین نسخهٔ پشتیبان گذشته است."},
    {code:"stock_integrity",severity:"critical",title:"کنترل موجودی انبار",count:0,detail:"مغایرتی در کنترل موجودی دیده نشد."},
  ]};
  api.defaults["GET /health/dead-letters"] = {messages:[{id:"901",topic:"web.instore_push",attempts:5,createdAt:"2026-10-10T06:30:00Z",age:"2 ساعت",lastError:"ارتباط با سایت قطع شد؛ تنظیمات اتصال و وضعیت سایت بررسی شود."}]};
}
for (const screen of ["health","backups"]) test(`operations screen ${screen} stays readable at viewport width`, async ({page,api}, info) => {
  health(api);
  api.defaults["GET /backups"]={available:true,backups:[{id:backup.id,valid:true,manifest:backup},{id:"invalid-backup",valid:false,manifest:null}],jobs:[{id:"job-previous",backupId:backup.id,phase:"rolled_back",createdAt:backup.createdAt,updatedAt:backup.createdAt}],needsRecovery:false};
  await page.goto(`/?page=settings&settings.tab=${screen}`);
  await expect(page.getByText(screen === "health" ? "پیام‌های نیازمند رسیدگی" : "بازگشت به نسخهٔ قبل انجام شد")).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  if (process.env.OPERATIONS_EVIDENCE) await page.screenshot({path:`${process.env.OPERATIONS_EVIDENCE}-${screen}-${info.project.name}.png`,fullPage:true});
});

test("health read failure can recover without writes and a stale refresh prevents requeue", async ({page,api}) => {
  health(api);
  api.handlers.set("GET /health/alerts", async route => {await route.abort();});
  await page.goto("/?page=settings&settings.tab=health");
  await expect(page.getByRole("alert")).toContainText("ارتباط با سرور برقرار نشد");
  api.handlers.delete("GET /health/alerts");
  await page.getByRole("button",{name:"تلاش دوباره",exact:true}).click();
  await page.getByLabel("دلیل اجرای مجدد",{exact:true}).fill("اتصال بررسی شد");
  const send=page.getByRole("button",{name:"دوباره بفرست",exact:true});
  await expect(send).toBeEnabled();
  api.handlers.set("GET /health/alerts", async route => {await route.abort();});
  await page.getByRole("button",{name:"بررسی دوباره",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("اطلاعات از آخرین بررسی است");
  await expect(send).toBeDisabled();
  await expect(page.getByLabel("دلیل اجرای مجدد",{exact:true})).toHaveValue("اتصال بررسی شد");
  expect(api.calls.filter(c=>c.startsWith("POST /health"))).toEqual([]);
  api.handlers.delete("GET /health/alerts");
  api.handlers.set("POST /health/dead-letters/901/requeue",async route=>{
    expect(route.request().postDataJSON()).toEqual({reason:"اتصال بررسی شد"});
    api.defaults["GET /health/dead-letters"]={messages:[]};
    await route.fulfill({json:{id:"901",status:"pending",attempts:0}});
  });
  await page.getByRole("button",{name:"بررسی دوباره",exact:true}).click();
  await expect(send).toBeEnabled(); await send.click();
  await expect(page.getByText("پیام متوقف‌شده‌ای وجود ندارد.",{exact:true})).toBeVisible();
  expect(api.calls.filter(c=>c.startsWith("POST /health"))).toHaveLength(1);
});

test("backup confirmation receives focus and cancelled credentials are cleared; failed refresh locks restore",async({page,api})=>{
  api.defaults["GET /backups"]={available:true,backups:[{id:backup.id,valid:true,manifest:backup}],jobs:[],needsRecovery:false};
  await page.goto("/?page=settings&settings.tab=backups");
  const inspect=page.getByRole("button",{name:"بررسی برای بازیابی",exact:true});
  await inspect.click();
  await expect(page.getByRole("heading",{name:"تأیید بازیابی همین بکاپ",exact:true})).toBeFocused();
  await page.getByLabel("رمز فعلی من",{exact:true}).fill("synthetic-password");
  await page.getByLabel("کد عامل دوم",{exact:true}).fill("123456");
  await page.getByRole("button",{name:"انصراف",exact:true}).click();
  await inspect.click();
  await expect(page.getByLabel("رمز فعلی من",{exact:true})).toHaveValue("");
  await expect(page.getByLabel("کد عامل دوم",{exact:true})).toHaveValue("");
  api.handlers.set("GET /backups",async route=>{await route.abort();});
  await page.getByRole("button",{name:"تازه‌سازی تاریخچه",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("آخرین پاسخ تأییدشده");
  await expect(inspect).toBeDisabled();
  await expect(page.getByRole("button",{name:"ساخت بکاپ تازه",exact:true})).toBeDisabled();
  expect(api.calls.filter(c=>c.startsWith("POST /backups"))).toEqual([]);
});
