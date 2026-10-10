import { test, expect, type MockApi } from "./fixtures";

const accounts = [
  {code:"4",parentCode:null,name:"درآمدها",level:"group",nature:"credit",type:"revenue",isPostable:false,isActive:true,hasChildren:true,hasEntries:false},
  {code:"4101",parentCode:"4",name:"فروش پوشاک",level:"moin",nature:"credit",type:"revenue",isPostable:true,isActive:true,hasChildren:false,hasEntries:true},
  {code:"4102",parentCode:"4",name:"فروش اینترنتی",level:"moin",nature:"credit",type:"revenue",isPostable:true,isActive:false,hasChildren:false,hasEntries:false},
];
const rule={id:1,eventType:"sale_shift",leg:"revenue",side:"credit",accountCode:"4101",accountName:"فروش پوشاک",accountType:"revenue",accountNature:"credit",partyType:null,description:"درآمد فروش کالا",isActive:true,allowAccountOverride:false,entryCount:8};
function mock(api:MockApi) {
  api.defaults["GET /accounts"]={accounts};
  api.defaults["GET /posting-rules"]={rules:[rule],accounts:[{code:"4101",name:"فروش پوشاک",type:"revenue"},{code:"4103",name:"درآمد فروش شعبه",type:"revenue"},{code:"1101",name:"صندوق",type:"asset"}]};
}
for(const screen of ["accounts","mapping"]) test(`account configuration ${screen} visual evidence`,async({page,api},info)=>{
  mock(api); await page.goto(`/?page=settings&settings.tab=${screen}`);
  await expect(page.getByText(screen==="accounts"?"فروش پوشاک":"درآمد فروش کالا",{exact:true})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if(process.env.ACCOUNTS_EVIDENCE)await page.screenshot({path:`${process.env.ACCOUNTS_EVIDENCE}-${screen}-${info.project.name}.png`,fullPage:true});
});

test("account restrictions, dirty cancel and failed refresh preserve the editor", async ({page,api}) => {
  mock(api); await page.goto("/?page=settings&settings.tab=accounts");
  await page.locator(".acct-tree > li").filter({hasText:"فروش پوشاک"}).getByRole("button",{name:"ویرایش",exact:true}).click();
  await expect(page.getByLabel("ماهیت",{exact:true})).toBeDisabled();
  await expect(page.getByLabel("نوع",{exact:true})).toBeDisabled();
  await page.getByLabel("نام حساب",{exact:true}).fill("نام ویرایش‌شده");
  page.once("dialog",dialog=>dialog.dismiss());
  await page.getByRole("button",{name:"انصراف",exact:true}).click();
  await expect(page.getByLabel("نام حساب",{exact:true})).toHaveValue("نام ویرایش‌شده");
  api.handlers.set("GET /accounts",async route=>{await route.fulfill({status:503,json:{error:{code:"unavailable",message:"خواندن موقتاً ممکن نیست"}}});});
  await page.getByRole("button",{name:"بررسی دوباره",exact:true}).click();
  await expect(page.getByText("خواندن موقتاً ممکن نیست",{exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"ذخیره",exact:true})).toBeDisabled();
  await expect(page.getByLabel("نام حساب",{exact:true})).toHaveValue("نام ویرایش‌شده");
  api.handlers.delete("GET /accounts");
  await page.getByRole("button",{name:"تلاش دوباره",exact:true}).click();
  await expect(page.getByRole("button",{name:"ذخیره",exact:true})).toBeEnabled();
  expect(api.calls.filter(call=>/^(PUT|PATCH)/.test(call))).toEqual([]);
});

test("accounts parent cannot become postable and unknown save needs read reconciliation",async({page,api})=>{
  mock(api); await page.goto("/?page=settings&settings.tab=accounts");
  await page.locator(".acct-tree > li").filter({hasText:"درآمدها"}).getByRole("button",{name:"ویرایش",exact:true}).click();
  await expect(page.getByLabel("قابل ثبت",{exact:true})).toBeDisabled();
  await page.getByLabel("نام حساب",{exact:true}).fill("درآمدهای شعبه");
  api.handlers.set("PUT /accounts/4",async route=>{await route.abort();});
  await page.getByRole("button",{name:"ذخیره",exact:true}).click();
  await expect(page.getByText(/نتیجهٔ ذخیره هنوز روشن نیست/)).toBeVisible();
  await expect(page.getByRole("button",{name:"ذخیره",exact:true})).toBeDisabled();
  await page.getByRole("button",{name:"بررسی دوباره",exact:true}).click();
  await expect(page.getByRole("button",{name:"ذخیره",exact:true})).toBeEnabled();
  await expect(page.getByLabel("نام حساب",{exact:true})).toHaveValue("درآمدهای شعبه");
  expect(api.calls.filter(call=>call==="PUT /accounts/4")).toHaveLength(1);
});

test("mapping requires matching account type and audit reason, saves exactly once",async({page,api})=>{
  mock(api);await page.goto("/?page=settings&settings.tab=mapping");
  const target=page.getByLabel("حساب مقصد",{exact:true}),save=page.getByRole("button",{name:"ذخیره نگاشت",exact:true});
  await expect(target.locator("option[value='1101']")).toHaveCount(0);
  await target.selectOption("4103");await expect(save).toBeDisabled();
  await page.getByLabel("دلیل تغییر",{exact:true}).fill("انتقال به حساب شعبه");
  api.handlers.set("PUT /posting-rules/sale_shift/revenue/credit",async route=>{
    expect(route.request().postDataJSON()).toEqual({accountCode:"4103",reason:"انتقال به حساب شعبه"});
    api.defaults["GET /posting-rules"]={...(api.defaults["GET /posting-rules"] as object),rules:[{...rule,accountCode:"4103",accountName:"درآمد فروش شعبه"}]};
    await route.fulfill({json:{ok:true}});
  });
  await save.click();await expect(page.getByText(/به حساب 4103 تغییر کرد/)).toBeVisible();
  await expect(save).toBeDisabled();await expect(page.getByLabel("دلیل تغییر",{exact:true})).toHaveValue("");
  expect(api.calls.filter(call=>call.startsWith("PUT /posting-rules"))).toHaveLength(1);
});

test("mapping read retries and uncertain write preserve draft without resubmission",async({page,api})=>{
  mock(api);api.handlers.set("GET /posting-rules",async route=>{await route.fulfill({status:503,json:{error:{code:"unavailable",message:"خواندن موقتاً ممکن نیست"}}});});
  await page.goto("/?page=settings&settings.tab=mapping");
  await expect(page.getByRole("button",{name:"تلاش دوباره",exact:true})).toBeVisible();
  api.handlers.delete("GET /posting-rules");await page.getByRole("button",{name:"تلاش دوباره",exact:true}).click();
  await page.getByLabel("حساب مقصد",{exact:true}).selectOption("4103");
  await page.getByLabel("دلیل تغییر",{exact:true}).fill("اصلاح حساب مقصد");
  api.handlers.set("PUT /posting-rules/sale_shift/revenue/credit",async route=>{await route.abort();});
  const save=page.getByRole("button",{name:"ذخیره نگاشت",exact:true});await save.click();
  await expect(page.getByText(/نتیجهٔ ذخیره هنوز روشن نیست/)).toBeVisible();await expect(save).toBeDisabled();
  await page.getByRole("button",{name:"بررسی دوباره",exact:true}).click();await expect(save).toBeEnabled();
  await expect(page.getByLabel("حساب مقصد",{exact:true})).toHaveValue("4103");
  await expect(page.getByLabel("دلیل تغییر",{exact:true})).toHaveValue("اصلاح حساب مقصد");
  expect(api.calls.filter(call=>call.startsWith("PUT /posting-rules"))).toHaveLength(1);
});

test("read-only accounting permissions expose records but disable changes",async({page,api})=>{
  mock(api);api.handlers.set("GET /auth/can",async(route,url)=>{
    const op=url.searchParams.get("operation");
    await route.fulfill({json:{verdict:op==="settings.security"||op==="ledger.mapping"?"deny":"allow",approver:null,reason:""}});
  });
  await page.goto("/?page=settings&settings.tab=accounts");
  await expect(page.getByText(/فقط مشاهده؛/)).toBeVisible();
  await expect(page.getByRole("button",{name:"ویرایش",exact:true}).first()).toBeDisabled();
  await page.goto("/?page=settings&settings.tab=mapping");
  await expect(page.getByLabel("حساب مقصد",{exact:true})).toBeDisabled();
  expect(api.calls.filter(call=>/^(PUT|PATCH)/.test(call))).toEqual([]);
});

for (const screen of ["accounts", "mapping"]) test(`${screen} accepted write with denied verification cannot be submitted again`, async ({page,api}) => {
  mock(api); await page.goto(`/?page=settings&settings.tab=${screen}`);
  const read = screen === "accounts" ? "GET /accounts" : "GET /posting-rules";
  const write = screen === "accounts" ? "PUT /accounts/4" : "PUT /posting-rules/sale_shift/revenue/credit";
  const label = screen === "accounts" ? "ذخیره" : "ذخیره نگاشت";
  if (screen === "accounts") {
    await page.locator(".acct-tree > li").filter({hasText:"درآمدها"}).getByRole("button",{name:"ویرایش",exact:true}).click();
    await page.getByLabel("نام حساب",{exact:true}).fill("درآمدهای شعبه");
  } else {
    await page.getByLabel("حساب مقصد",{exact:true}).selectOption("4103");
    await page.getByLabel("دلیل تغییر",{exact:true}).fill("اصلاح حساب مقصد");
  }
  api.handlers.set(write, async route => {
    api.handlers.set(read, async next => {await next.fulfill({status:403,json:{error:{code:"forbidden",message:"دسترسی خواندن رد شد"}}});});
    await route.fulfill({json:{ok:true}});
  });
  const save=page.getByRole("button",{name:label,exact:true});await save.click();
  await expect(page.getByText(/نتیجهٔ ذخیره هنوز روشن نیست/)).toBeVisible();await expect(save).toBeDisabled();
  expect(api.calls.filter(call=>call===write)).toHaveLength(1);
});
