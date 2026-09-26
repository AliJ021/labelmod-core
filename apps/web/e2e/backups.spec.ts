import { test, expect, settings } from "./fixtures";

test("backup connection absence is explicit and offers no pretend restore",async({page,api})=>{
  api.defaults["GET /backups"]={available:false,backups:[],jobs:[],needsRecovery:false};
  await page.goto("/");await settings(page,"backups","پشتیبان‌گیری و بازیابی");
  await expect(page.getByText("سرویس مستقل بکاپ هنوز متصل نشده است.")).toBeVisible();
  await expect(page.getByRole("button",{name:"ساخت بکاپ تازه"})).toHaveCount(0);
});

test("restore requires exact backup confirmation and factors; ambiguous retries keep their operation ID",async({page,api})=>{
  const backup={id:"11111111-1111-4111-8111-111111111111",createdAt:"2026-09-26T08:30:00.000Z",bytes:1024000,serverMajor:16};
  api.defaults["GET /backups"]={available:true,backups:[{id:backup.id,valid:true,manifest:backup}],jobs:[],needsRecovery:false};
  const requests:Array<Record<string,unknown>>=[];
  api.handlers.set("POST /backups/restore",async route=>{
    requests.push(route.request().postDataJSON());
    if(requests.length===1) await route.abort("connectionreset");
    else await route.fulfill({status:202,json:{id:requests[0]!.operationId,phase:"queued"}});
  });
  await page.goto("/?page=settings&settings.tab=backups");
  await page.getByRole("button",{name:"بررسی برای بازیابی"}).click();
  const submit=page.getByRole("button",{name:"تأیید و شروع بازیابی"});
  await expect(submit).toBeDisabled();
  await page.getByLabel("رمز فعلی من").fill("test-only-password");await page.getByLabel("کد عامل دوم",{exact:true}).fill("۱۲۳۴۵۶");
  await expect(submit).toBeDisabled();await page.getByRole("checkbox").check();await submit.click();
  await expect(page.getByRole("alert")).toContainText("ارتباط قطع شد");
  await expect(page.getByLabel("رمز فعلی من")).toHaveValue("");await expect(page.getByLabel("کد عامل دوم",{exact:true})).toHaveValue("");
  await page.getByLabel("رمز فعلی من").fill("test-only-password");await page.getByLabel("کد عامل دوم",{exact:true}).fill("654321");await submit.click();
  await expect(page.getByRole("status").filter({hasText:"درخواست بازیابی ثبت شد"})).toBeVisible();
  expect(requests).toHaveLength(2);expect(requests[1]!.operationId).toBe(requests[0]!.operationId);
  expect(requests[0]).toMatchObject({backupId:backup.id,confirmedTimestamp:backup.createdAt,code:"123456",factorKind:"totp"});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});

test("incomplete recovery prevents another restore and denied download is absent",async({page,api})=>{
  const backup={id:"11111111-1111-4111-8111-111111111111",createdAt:"2026-09-26T08:30:00.000Z",bytes:1024,serverMajor:16};
  api.handlers.set("GET /auth/can",async(route,url)=>{await route.fulfill({json:{verdict:url.searchParams.get("operation")==="backup.download"?"deny":"allow"}});});
  api.defaults["GET /backups"]={available:true,backups:[{id:backup.id,valid:true,manifest:backup}],jobs:[{id:"job-1",backupId:backup.id,phase:"manual_recovery",createdAt:backup.createdAt,updatedAt:backup.createdAt}],needsRecovery:true};
  await page.goto("/?page=settings&settings.tab=backups");
  await expect(page.getByRole("button",{name:"بررسی برای بازیابی"})).toBeDisabled();
  await expect(page.getByRole("link",{name:"دانلود بکاپ"})).toHaveCount(0);
  await expect(page.getByText("رسیدگی مدیر سامانه لازم است",{exact:true})).toBeVisible();
});
