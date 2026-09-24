import { test, expect, product, openCatalog, settings } from "./fixtures";
import type { MockApi } from "./fixtures";
const invoice = { id:"draft1",number:null,branchId:"b1",warehouseId:"w1",shiftId:"s1",customerId:null,
  status:"draft",channel:"pos",grossAmount:"200000",discountAmount:"0",netAmount:"200000",taxAmount:"0",
  shippingAmount:"0",payableAmount:"200000",paidAmount:"0",receivedAmount:"0",recipientId:null,gift:null,
  occurredAt:"2026-09-24T00:00:00Z",lines:[{id:"l1",lineNo:1,variationId:"v1",productName:"شلوار کتان",
    sku:"TEST",qty:"1",unitPrice:"200000",netAmount:"200000",discountAmount:"0",listPrice:null,priceOverrideReason:null,discountReason:null}] };
function pos(api:MockApi) {
  api.defaults["GET /payment-methods"]={methods:[{code:"cash",name:"نقد",kind:"cash",requiresRef:false},{code:"card",name:"کارت‌خوان",kind:"card_reader",requiresRef:true}]};
  api.defaults["GET /shifts/current"]={id:"s1",branchId:"b1",status:"open",openingCash:"0",openedAt:"2026-09-24T00:00:00Z"};
  api.defaults["GET /gift-options"]={wraps:[],colors:[],flowers:[]};
  api.defaults["GET /invoices/draft1"]=invoice;
}
test("name search groups products then selects color and size, including a variant without barcode",async({page,api})=>{
  pos(api); api.defaults["GET /pos/products"]={products:[{id:"p1",name:"شلوار کتان",code:"P1",variationCount:3}]};
  api.defaults["GET /pos/products/p1/variations"]={variations:[
    {id:"v1",sku:"NAVY-M",barcode:null,color:"سرمه‌ای",size:"M",price:"200000",available:"4"},
    {id:"v2",sku:"NAVY-L",barcode:null,color:"سرمه‌ای",size:"L",price:"200000",available:"0"},
    {id:"v3",sku:"RED-M",barcode:null,color:"قرمز",size:"M",price:null,available:"2"},
  ]};
  api.defaults["POST /invoices"]=invoice;
  let scanned:Record<string,unknown>|undefined;
  api.handlers.set("POST /invoices/draft1/scan",async route=>{
    scanned=route.request().postDataJSON();await route.fulfill({json:{invoice,replayed:false}});
  });
  await page.goto("/");await page.getByRole("tab",{name:"صندوق",exact:true}).click();
  const panel=page.getByRole("region",{name:"افزودن کالا با نام"});
  await panel.getByRole("searchbox").fill("شلوار");
  await expect(panel.getByRole("button",{name:/شلوار کتان/})).toHaveCount(1);
  await expect(panel.getByRole("group",{name:"انتخاب سایز"})).toHaveCount(0);
  await panel.getByRole("button",{name:/شلوار کتان/}).click();
  await panel.getByRole("button",{name:"سرمه‌ای",exact:true}).click();
  await expect(panel.getByRole("button",{name:/سایز L/})).toBeDisabled();
  await panel.getByRole("button",{name:/سایز M/}).click();
  await expect.poll(()=>scanned).toMatchObject({variationId:"v1",qty:"1"});
  expect(scanned).not.toHaveProperty("barcode");expect(scanned).not.toHaveProperty("unitPrice");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await panel.getByRole("button",{name:"قرمز",exact:true}).click();
  await expect(panel.getByRole("button",{name:/بدون قیمت/})).toBeDisabled();
});
test("split payment preserves failed input, then displays server totals and methods",async({page,api})=>{
  pos(api);let attempts=0;
  const payments:Array<{id:string;name:string;amount:string}>=[];
  api.handlers.set("GET /invoices/draft1/payments",async route=>{await route.fulfill({json:{payments}});});
  api.handlers.set("POST /invoices/draft1/payments",async route=>{
    attempts++;const data=route.request().postDataJSON();
    if(attempts===1){await route.fulfill({status:503,json:{error:{code:"unavailable",message:"خطای موقت آزمون"}}});return;}
    payments.push({id:"p"+attempts,name:data.methodCode==="cash"?"نقد":"کارت‌خوان",amount:data.amount});
    const receivedAmount=payments.reduce((sum,p)=>sum+BigInt(p.amount),0n).toString();
    await route.fulfill({json:{invoice:{...invoice,receivedAmount},receivedAmount,paymentId:"p"+attempts,replayed:false}});
  });
  await page.addInitScript(()=>localStorage.setItem("labelmod_open_cart",JSON.stringify({invoiceId:"draft1",shiftId:"s1"})));
  await page.goto("/");await page.getByRole("tab",{name:"صندوق",exact:true}).click();
  await page.getByRole("button",{name:"کارت‌خوان",exact:true}).click();
  const amount=page.getByLabel("مبلغ (تومان) — خالی یعنی همه مانده");
  await amount.fill("12000");await page.getByLabel("شماره پیگیری",{exact:true}).fill("TEST-123");
  await page.getByRole("button",{name:"دریافت وجه",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("خطای موقت آزمون");
  await expect(amount).toHaveValue("12000");await expect(page.getByLabel("شماره پیگیری",{exact:true})).toHaveValue("TEST-123");
  await page.getByRole("button",{name:"دریافت وجه",exact:true}).click();
  await expect(amount).toHaveValue("");await expect(page.getByText(/مانده:/)).toContainText("8٬000");
  await page.getByRole("button",{name:"نقد",exact:true}).click();
  await page.getByRole("button",{name:"دریافت وجه",exact:true}).click();
  await expect.poll(()=>payments).toEqual([{id:"p2",name:"کارت‌خوان",amount:"120000"},{id:"p3",name:"نقد",amount:"80000"}]);
  await expect(page.getByRole("button",{name:"نهایی‌کردن فاکتور",exact:true})).toBeEnabled();
});
test("catalog shows stock and previews correctly sized labels; changing selection invalidates preview",async({page,api})=>{
  let body:Record<string,unknown>|undefined;
  api.handlers.set("POST /labels",async route=>{body=route.request().postDataJSON();await route.fulfill({contentType:"text/html",body:'<!doctype html><html lang="fa"><body><p>TEST LABEL</p></body></html>'});});
  await openCatalog(page);await page.getByRole("button",{name:"باز کردن",exact:true}).click();
  const panel=page.getByRole("region",{name:"موجودی و چاپ بارکد"});
  await expect(panel.getByText(/جمع موجودی/)).toContainText("12");
  await expect(panel.getByRole("button",{name:"پیش‌نمایش لیبل‌های انتخاب‌شده"})).toBeDisabled();
  await page.getByRole("checkbox",{name:"انتخاب TR-1405-NAVY-XL"}).check();
  await panel.getByRole("button",{name:"پیش‌نمایش لیبل‌های انتخاب‌شده"}).click();
  await expect(panel.getByRole("button",{name:"چاپ لیبل بارکد",exact:true})).toBeVisible();
  expect(body).toEqual({items:[{variationId:"v1",count:1}],layout:"roll",rollWidthMm:50,rollHeightMm:30});
  await expect(page.frameLocator('iframe[title="پیش‌نمایش چاپ بارکد"]').getByText("TEST LABEL")).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.getByRole("checkbox",{name:"انتخاب TR-1405-NAVY-XL"}).uncheck();
  await expect(panel.getByRole("button",{name:"چاپ لیبل بارکد",exact:true})).toHaveCount(0);
  expect(api.calls).toContain("GET /products/"+product.id+"/stock-matrix");
});
test("personal PIN is discoverable and accepts Persian digits with confirmation",async({page,api})=>{
  let submitted:Record<string,unknown>|undefined;
  api.handlers.set("POST /auth/pin",async route=>{submitted=route.request().postDataJSON();await route.fulfill({json:{ok:true,hasPin:true}});});
  await page.goto("/");await settings(page,"pin","PIN من — ساخت و تغییر");
  await page.getByLabel("رمز عبور فعلی",{exact:true}).fill("test-password");
  await page.getByLabel("PIN جدید",{exact:true}).fill("۱۲۳۴");
  const save=page.getByRole("button",{name:"ساخت PIN",exact:true});await expect(save).toBeDisabled();
  await page.getByLabel("تکرار PIN جدید",{exact:true}).fill("۱۲۳۴");await save.click();
  await expect(page.getByRole("status")).toContainText("PIN ذخیره شد.");
  expect(submitted).toEqual({pin:"1234",currentPassword:"test-password"});
  await expect(page.getByLabel("رمز عبور فعلی",{exact:true})).toHaveValue("");
  await expect(page.getByRole("button",{name:"تغییر PIN",exact:true})).toBeVisible();
});
test("SMS enrollment remains pending until code confirmation",async({page,api})=>{
  api.defaults["GET /auth/2fa"]={enabled:false,hasPending:false,recoveryCodesRemaining:0,webauthnCount:0,smsEnabled:false};
  api.defaults["GET /auth/2fa/webauthn"]={credentials:[]};
  api.defaults["POST /auth/2fa/sms/enroll"]={queued:true,expiresIn:120,maskedMobile:"0912••••000"};
  api.handlers.set("POST /auth/2fa/sms/confirm",async route=>{
    expect(route.request().postDataJSON()).toEqual({code:"123456"});
    api.defaults["GET /auth/2fa/sms/status"]={enabled:true,maskedMobile:"0912••••000"};
    api.defaults["GET /auth/2fa"]={enabled:false,hasPending:false,recoveryCodesRemaining:0,webauthnCount:0,smsEnabled:true};
    await route.fulfill({json:{enabled:true}});
  });
  await page.goto("/");await settings(page,"twofactor","ورود دومرحله‌ای");
  const panel=page.getByRole("region",{name:"ورود دومرحله‌ای پیامکی"});
  await panel.getByLabel("رمز عبور فعلی برای تنظیم پیامک").fill("test-password");
  await panel.getByLabel("موبایل دریافت کد ورود").fill("09120000000");
  await panel.getByRole("button",{name:"ارسال کد تأیید شماره"}).click();
  await expect(panel.getByText("هنوز شماره‌ای تأیید نشده است.")).toBeVisible();
  await panel.getByLabel("کد تأیید پیامک",{exact:true}).fill("۱۲۳۴۵۶");
  await panel.getByRole("button",{name:"تأیید و فعال‌سازی پیامک"}).click();
  await expect(panel.getByRole("status")).toContainText("ورود دومرحله‌ای پیامکی فعال شد.");
});

test("login offers SMS after password and sends the code to the SMS verification route",async({page,api})=>{
  const me=api.defaults["GET /auth/me"];let loggedIn=false;
  api.handlers.set("GET /auth/me",async route=>{await route.fulfill(loggedIn?{json:me}:{status:401,json:{error:{code:"no_session",message:"وارد شوید"}}});});
  api.defaults["POST /auth/login"]={needsSecondFactor:true,fullName:"کاربر آزمون",methods:["sms"],expiresAt:"2099-01-01T00:00:00Z"};
  api.defaults["POST /auth/2fa/sms/request"]={queued:true,expiresIn:120,maskedMobile:"0912••••000"};
  api.handlers.set("POST /auth/2fa/sms",async route=>{
    expect(route.request().postDataJSON()).toMatchObject({code:"123456"});
    loggedIn=true;await route.fulfill({json:{ok:true}});
  });
  await page.goto("/");
  await page.getByLabel("نام کاربری",{exact:true}).fill("test-user");
  await page.getByLabel("رمز عبور",{exact:true}).fill("test-password");
  await page.getByRole("button",{name:"ورود",exact:true}).click();
  await page.getByRole("button",{name:"ارسال کد ورود با پیامک"}).click();
  await expect(page.getByRole("status")).toContainText("0912••••000");
  await page.getByLabel("کد شش‌رقمی",{exact:true}).fill("۱۲۳۴۵۶");
  await page.getByRole("button",{name:"ورود",exact:true}).click();
  await expect(page.getByRole("tab",{name:"صندوق",exact:true})).toBeVisible();
});
