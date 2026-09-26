import { test, expect, settings, fontsReady } from "./fixtures";

test("invoice center restores URL filters and browser navigation and prints only posted documents", async ({page,api}) => {
  const row={id:"i1",number:null,status:"draft",branchId:"b1",branchName:"شعبه آزمون",shiftId:"s1",creatorName:"صندوق‌دار آزمون",finalizerName:null,customerName:null,occurredAt:"2026-09-26T08:00:00Z",payableAmount:"1000000",receivedAmount:"0",paymentMethods:"",canResume:false,needsReview:true};
  api.defaults["GET /invoices"]={rows:[row],total:1,pageSize:50};
  api.defaults["GET /invoices/i1/overview"]={invoice:{...row,lines:[]},payments:[]};
  await page.goto("/?page=invoices&invoices.status=draft&invoices.search=نمونه");
  await expect(page.getByRole("heading",{name:"فاکتورها",exact:true})).toBeVisible();
  await expect(page.getByRole("combobox",{name:"وضعیت",exact:true})).toHaveValue("draft");
  await expect(page.locator("main").getByRole("searchbox")).toHaveValue("نمونه");
  await expect(page.getByText("نیازمند رسیدگی",{exact:false})).toBeVisible();
  await expect(page.getByRole("link",{name:"چاپ فاکتور",exact:true})).toHaveCount(0);
  await page.getByRole("button",{name:"جزئیات",exact:true}).click();
  await expect(page).toHaveURL(/invoices.id=i1/);
  await expect(page.getByRole("heading",{name:"فاکتور پیش‌نویس"})).toBeVisible();
  await page.goBack();await expect(page.getByRole("heading",{name:"فاکتورها",exact:true})).toBeVisible();
  await page.reload();await expect(page.locator("main").getByRole("searchbox")).toHaveValue("نمونه");
  await expect(page.getByRole("button",{name:"جزئیات",exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await fontsReady(page);await page.screenshot({path:test.info().outputPath("invoice-center.png"),fullPage:true});
});

test("feature search only offers permitted destinations; personal PIN stays reachable",async({page,api})=>{
  api.handlers.set("GET /auth/can",async route=>{await route.fulfill({json:{verdict:"deny",approver:null,reason:"آزمون محدودیت"}});});
  await page.goto("/");const field=page.getByRole("searchbox",{name:"پیداکردن بخش یا ابزار"});
  await field.fill("بارکد");await expect(page.getByText("بخشی با این نام پیدا نشد.")).toBeVisible();
  await field.fill("PIN");const link=page.getByRole("link",{name:"ساخت و تغییر PIN",exact:true});await expect(link).toHaveAttribute("href","/?page=settings&settings.tab=pin");
  await link.click();await expect(page).toHaveURL(/settings.tab=pin/);await expect(page.getByRole("heading",{name:/PIN/})).toBeVisible();
});

test("SnappPay configuration preserves a server rejection and its independent report reads authoritative totals",async({page,api})=>{
  api.defaults["GET /snappay/config"]={accountId:"",enabled:false,accounts:[{id:"a1",name:"واسط اسنپ‌پی",bankName:"بانک آزمون"}]};
  let attempts=0;
  api.handlers.set("PUT /snappay/config",async route=>{
    attempts++;if(attempts===1) await route.fulfill({status:422,json:{error:{code:"invalid",message:"حساب بانک غیرفعال شد"}}});
    else await route.fulfill({json:{ok:true}});
  });
  await page.goto("/");await settings(page,"snappay","اسنپ‌پی");
  const account=page.getByRole("combobox",{name:"حساب واسط و بانک تسویه"});await account.selectOption("a1");
  await page.getByRole("button",{name:"ذخیرهٔ تنظیم اسنپ‌پی"}).click();await expect(page.getByRole("alert")).toContainText("بانک غیرفعال");await expect(account).toHaveValue("a1");
  await page.getByRole("button",{name:"ذخیرهٔ تنظیم اسنپ‌پی"}).click();await expect(page.getByRole("status")).toContainText("ذخیره شد");
  api.defaults["GET /reports/snappay"]={rows:[],total:0,received:"1200000",refunded:"200000",net:"1000000"};
  await page.goto("/?page=reports&reports.tab=snappay");await expect(page.getByRole("heading",{name:"گردش اسنپ‌پی"})).toBeVisible();
  await expect(page.getByText("خالص:",{exact:false})).toContainText("100٬000");
  expect(api.calls.filter(c=>c.startsWith("GET /reports/cash-reconciliation"))).toHaveLength(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});
