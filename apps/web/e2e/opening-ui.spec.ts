import { test, expect, type MockApi } from "./fixtures";
import type { Page } from "@playwright/test";

function mockOpening(api: MockApi) {
  api.defaults["GET /tafsili"] = {rows:[{parentCode:"1103",parentName:"حساب‌های دریافتنی",code:"1103-00001",partyType:"customer",partyId:"synthetic-person",partyName:"شخص آزمایشی",debit:"3500000",credit:"500000",balance:"3000000"}]};
}

test("opening synthetic responsive evidence", async ({page,api},info) => {
  mockOpening(api); await page.goto("/?page=settings&settings.tab=opening");
  await expect(page.getByText("شخص آزمایشی",{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if(process.env.OPENING_EVIDENCE) await page.screenshot({path:`${process.env.OPENING_EVIDENCE}-${info.project.name}.png`,fullPage:true});
});

const entryId = "11111111-2222-4333-8444-555555555555";
const start = (page: Page) => page.goto("/?page=settings&settings.tab=opening");
async function balanced(page: Page, amount = "1200") {
  await page.getByLabel("موجودی صندوق (تومان)",{exact:true}).fill(amount);
  await page.getByLabel("مانده بستانکاران (تومان)",{exact:true}).fill(amount);
}
const review = (page: Page) => page.getByRole("button",{name:"بررسی و ثبت افتتاحیه",exact:true});
const confirm = (page: Page) => page.getByRole("button",{name:"تأیید و ثبت سند",exact:true});

test("opening review can cancel, then posts exact large amounts and Persian year once",async({page,api})=>{
  mockOpening(api);await start(page);await balanced(page,"۹٬۰۰۷٬۱۹۹٬۲۵۴٬۷۴۰٬۹۹۳");
  await page.getByLabel("سال مالی",{exact:true}).fill("۱۴۰۵");
  await review(page).click();await expect(page.getByRole("dialog",{name:"تأیید سند افتتاحیه"})).toBeVisible();
  expect(api.calls.filter(call=>call==="POST /opening-balance")).toEqual([]);
  await page.getByRole("button",{name:"بازگشت به ویرایش",exact:true}).click();
  await expect(page.getByLabel("موجودی صندوق (تومان)",{exact:true})).toHaveValue("۹٬۰۰۷٬۱۹۹٬۲۵۴٬۷۴۰٬۹۹۳");
  api.handlers.set("POST /opening-balance",async route=>{
    expect(route.request().postDataJSON()).toEqual({branchId:"b1",fiscalYear:1405,legs:[{leg:"cash",amount:"90071992547409930"},{leg:"payable",amount:"90071992547409930"}]});
    await route.fulfill({json:{entryId}});
  });
  await review(page).click();await confirm(page).click();
  await expect(page.getByText("سند افتتاحیه ثبت شد",{exact:true})).toBeVisible();
  await expect(review(page)).toBeDisabled();
  expect(api.calls.filter(call=>call==="POST /opening-balance")).toHaveLength(1);
});

test("opening rejects negative, malformed amounts and non-integer or out-of-range years before confirmation",async({page,api})=>{
  mockOpening(api);await start(page);await balanced(page);
  for (const value of ["-1200","۱٫۵","abc"]) {
    await page.getByLabel("موجودی بانک (تومان)",{exact:true}).fill(value);
    await expect(page.getByText("مبلغ باید عدد صحیحِ نامنفی به تومان باشد.",{exact:true})).toBeVisible();
    await expect(review(page)).toBeDisabled();
  }
  await page.getByLabel("موجودی بانک (تومان)",{exact:true}).fill("");
  for(const value of ["۱۲۹۹","۱۵۰۱","1405.5","1e3",""]) {
    await page.getByLabel("سال مالی",{exact:true}).fill(value);await expect(review(page)).toBeDisabled();
  }
  await page.getByLabel("سال مالی",{exact:true}).fill("۱۴۰۵");await expect(review(page)).toBeEnabled();
  expect(api.calls.filter(call=>call==="POST /opening-balance")).toHaveLength(0);
});

test("opening read retry works and read-only permission disables financial form",async({page,api})=>{
  mockOpening(api);api.handlers.set("GET /tafsili",async route=>{await route.fulfill({status:503,json:{error:{code:"temporary",message:"خواندن تفصیلی ممکن نیست"}}});});
  api.handlers.set("GET /auth/can",async(route,url)=>{await route.fulfill({json:{verdict:url.searchParams.get("operation")==="settings.security"?"deny":"allow",approver:null,reason:""}});});
  await start(page);await expect(page.getByText("خواندن تفصیلی ممکن نیست",{exact:true})).toBeVisible();
  api.handlers.delete("GET /tafsili");await page.getByRole("button",{name:"تلاش دوباره",exact:true}).click();
  await expect(page.getByText("فقط مشاهده",{exact:true})).toBeVisible();
  await expect(page.getByLabel("موجودی صندوق (تومان)",{exact:true})).toBeDisabled();
  await expect(review(page)).toBeDisabled();expect(api.calls.filter(call=>call==="POST /opening-balance")).toHaveLength(0);
});

test("opening success survives a failed following tafsili read",async({page,api})=>{
  mockOpening(api);await start(page);await balanced(page);
  api.handlers.set("POST /opening-balance",async route=>{
    api.handlers.set("GET /tafsili",async next=>{await next.fulfill({status:503,json:{error:{code:"temporary",message:"خواندن تفصیلی ممکن نیست"}}});});
    await route.fulfill({json:{entryId}});
  });
  await review(page).click();await confirm(page).click();
  await expect(page.getByText("سند افتتاحیه ثبت شد",{exact:true})).toBeVisible();
  await expect(page.getByText("خواندن تفصیلی ممکن نیست",{exact:true})).toBeVisible();
  api.handlers.delete("GET /tafsili");await page.getByRole("button",{name:"تلاش دوباره",exact:true}).click();
  await expect(page.getByText("شخص آزمایشی",{exact:true})).toBeVisible();await expect(review(page)).toBeDisabled();
  expect(api.calls.filter(call=>call==="POST /opening-balance")).toHaveLength(1);
});

test("opening unknown write stays blocked after read and reload, storing no amounts or personal data",async({page,api})=>{
  mockOpening(api);await start(page);await balanced(page);
  api.handlers.set("POST /opening-balance",async route=>{await route.abort();});
  await review(page).click();await confirm(page).click();
  await expect(page.getByText("نتیجهٔ ثبت نیازمند بررسی است",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"بازخوانی اطلاعات",exact:true}).click();
  await expect(review(page)).toBeDisabled();
  page.on("dialog",dialog=>dialog.accept());await page.reload();
  await expect(page.getByText("نتیجهٔ ثبت نیازمند بررسی است",{exact:true})).toBeVisible();
  await expect(review(page)).toBeDisabled();
  expect(await page.evaluate(()=>Object.entries(sessionStorage).filter(([key])=>key.startsWith("labelmod.opening.")))).toEqual([["labelmod.opening.b1.1405","uncertain"]]);
  expect(api.calls.filter(call=>call==="POST /opening-balance")).toHaveLength(1);
});

test("opening known-success reload permits deliberate review without automatic replacement",async({page,api})=>{
  mockOpening(api);api.defaults["POST /opening-balance"]={entryId};
  await start(page);await balanced(page);await review(page).click();await confirm(page).click();
  await expect(page.getByText("سند افتتاحیه ثبت شد",{exact:true})).toBeVisible();await expect(review(page)).toBeDisabled();
  expect(await page.evaluate(()=>sessionStorage.getItem("labelmod.opening.b1.1405"))).toBeNull();
  await page.reload();await balanced(page,"2400");await expect(review(page)).toBeEnabled();await review(page).click();
  await expect(page.getByRole("dialog",{name:"تأیید سند افتتاحیه"})).toBeVisible();
  await expect(confirm(page)).toBeEnabled();
  expect(api.calls.filter(call=>call==="POST /opening-balance")).toHaveLength(1);
});

test("opening definitive rejection preserves amounts and removes only the submission lock",async({page,api})=>{
  mockOpening(api);await start(page);await balanced(page);
  api.handlers.set("POST /opening-balance",async route=>{await route.fulfill({status:409,json:{error:{code:"rejected",message:"سال مالی بسته است"}}});});
  await review(page).click();await confirm(page).click();
  await expect(page.getByText("سال مالی بسته است",{exact:true})).toBeVisible();
  await expect(page.getByLabel("موجودی صندوق (تومان)",{exact:true})).toHaveValue("1200");await expect(review(page)).toBeEnabled();
  expect(await page.evaluate(()=>sessionStorage.getItem("labelmod.opening.b1.1405"))).toBeNull();
});

test("opening draft navigation requires discard confirmation",async({page,api})=>{
  mockOpening(api);api.defaults["GET /accounts"]={accounts:[]};await start(page);await balanced(page);
  page.once("dialog",dialog=>dialog.dismiss());
  const select=page.getByRole("combobox",{name:"بخش تنظیمات"});
  if(await select.isVisible()) await select.selectOption("accounts");
  else await page.getByRole("tab",{name:"کدینگ حساب",exact:true}).click();
  await expect(page.getByLabel("موجودی صندوق (تومان)",{exact:true})).toHaveValue("1200");
});
