import { test, expect, settings, fontsReady } from "./fixtures";
import type { Locator, Page } from "@playwright/test";

const NARROW_WIDTHS=[320,360,375,390,412] as const;
async function documentWidth(page:Page){
  return page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));
}
/** آیا جعبهٔ افقی عنصر کاملاً داخل جعبهٔ ظرفش است؟ ±۱ پیکسل برای گردکردن زیرپیکسلی. */
async function horizontallyInside(item:Locator,container:Locator){
  const [a,b]=[await item.boundingBox(),await container.boundingBox()];
  if(!a||!b) throw new Error("element is not rendered");
  return a.x>=b.x-1&&a.x+a.width<=b.x+b.width+1;
}

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

test("dashboard unposted-period notes wrap instead of widening the page",async({page,api})=>{
  // بارگذاری تازهٔ صفحه در پنج عرض باریک؛ فقط زمان کار بیشتر است، ادعایی کم نشده.
  test.setTimeout(120_000);
  // هر سه نوع یادداشت دوره، به‌علاوهٔ یک دوره با دکمهٔ بستن. در عرض ۳۲۰ یادداشت شیفت صفحه را به ۳۴۹ می‌رساند.
  const row={branchId:"b1",invoiceCount:12,payableAmount:"12340000",cogsAmount:"9000000"};
  api.defaults["GET /posting-batches/unposted"]={rows:[
    {...row,batchId:"p1",batchKind:"shift",channel:"pos",businessDate:"2026-09-16"},
    {...row,batchId:"p2",batchKind:"channel_day",channel:"web",businessDate:"2026-09-16"},
    {...row,batchId:"p3",batchKind:"channel_day",channel:"web",businessDate:"2026-09-15"},
  ]};
  await page.goto("/");
  await expect(page.getByText("با بستن شیفت صندوق بسته می‌شود",{exact:true})).toBeVisible();
  await expect(page.getByText("دوره امروز هنوز باز است",{exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"بستن دوره",exact:true})).toBeVisible();
  await fontsReady(page);
  const size=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));
  expect(size.scroll,"Dashboard must not scroll horizontally").toBeLessThanOrEqual(size.client);
  api.handlers.set("GET /auth/can",async route=>{await route.fulfill({json:{verdict:"deny",approver:null,reason:""}});});
  await page.reload();
  await expect(page.getByText("بستن دوره دسترسی حسابدار می‌خواهد",{exact:true})).toBeVisible();
  await fontsReady(page);
  const denied=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));
  expect(denied.scroll,"Dashboard must not scroll horizontally without period.close").toBeLessThanOrEqual(denied.client);
  // عرض‌های باریک صریح، مستقل از عرض پروژه؛ هر دو حالت (با و بی period.close) یادداشت‌های متفاوتی دارند.
  for(const verdict of ["deny","allow"] as const){
    api.handlers.set("GET /auth/can",async route=>{await route.fulfill({json:{verdict,approver:null,reason:""}});});
    for(const width of NARROW_WIDTHS){
      await page.setViewportSize({width,height:900});
      await page.goto("/");
      await expect(page.getByText("با بستن شیفت صندوق بسته می‌شود",{exact:true})).toBeVisible();
      await expect(verdict==="allow"?page.getByRole("button",{name:"بستن دوره",exact:true}):page.getByText("بستن دوره دسترسی حسابدار می‌خواهد",{exact:true})).toBeVisible();
      await fontsReady(page);
      const narrow=await documentWidth(page);
      expect(narrow.client,"viewport width").toBe(width);
      expect(narrow.scroll,`Dashboard must not scroll horizontally at ${width}px (${verdict})`).toBeLessThanOrEqual(narrow.client);
    }
  }
});

test("manager report tables scroll inside their card instead of widening the page",async({page,api})=>{
  // بارگذاری تازهٔ صفحه در پنج عرض باریک؛ فقط زمان کار بیشتر است، ادعایی کم نشده.
  test.setTimeout(120_000);
  // بی داده جدولی ساخته نمی‌شود؛ سرریز فقط با سطر واقعی دیده می‌شد (scrollWidth ۴۳۵ در عرض ۳۷۵).
  const d="2026-09-10";
  api.defaults["GET /reports/compare"]={rows:[{channel:"pos",invoiceCount:3,netAmount:"3000000",profitAmount:"500000",prevInvoiceCount:2,prevNetAmount:"2000000",prevProfitAmount:"300000",deltaAmount:"1000000",deltaPercent:50,direction:"up"}]};
  api.defaults["GET /reports/hourly"]={rows:[{businessDate:d,hourOfDay:10,channel:"pos",invoiceCount:2,itemQty:"3",netAmount:"2000000"}]};
  api.defaults["GET /reports/basket"]={rows:[{businessDate:d,channel:"pos",invoiceCount:2,knownCustomers:1,anonymousCount:1,itemQty:"3",lineCount:3,netAmount:"2000000",qtyPerInvoice:"1.5"}]};
  api.defaults["GET /reports/customer-basket"]={rows:[{customerId:"c1",fullName:"مشتری آزمایشی با نام بلند",mobile:"09120000000",invoiceCount:2,itemQty:"3",netAmount:"2000000",lastPurchase:d}]};
  await page.goto("/?page=reports&reports.tab=manager");
  await expect(page.getByRole("heading",{name:"خرید هر مشتری"})).toBeVisible();
  await expect(page.getByRole("cell",{name:"مشتری آزمایشی با نام بلند"})).toBeVisible();
  await fontsReady(page);
  const size=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));
  expect(size.scroll,"Manager report must not scroll the page horizontally").toBeLessThanOrEqual(size.client);
  // در عرض‌های باریک، جدول «تحلیل سبد» (۸ ستون) از کارت پهن‌تر است: سند نباید بلغزد، ولی ظرف خود جدول باید
  // واقعاً اسکرول شود و آخرین ستون («فروش خالص»، چپ‌ترین در RTL) با اسکرول در دسترس بماند — نه اینکه بریده شود.
  for(const width of NARROW_WIDTHS){
    await page.setViewportSize({width,height:900});
    await page.goto("/?page=reports&reports.tab=manager");
    await expect(page.getByRole("heading",{name:"تحلیل سبد"})).toBeVisible();
    await expect(page.getByRole("cell",{name:"مشتری آزمایشی با نام بلند"})).toBeVisible();
    await fontsReady(page);
    const narrow=await documentWidth(page);
    expect(narrow.client,"viewport width").toBe(width);
    expect(narrow.scroll,`Manager report must not scroll the page horizontally at ${width}px`).toBeLessThanOrEqual(narrow.client);

    const box=page.getByRole("heading",{name:"تحلیل سبد"}).locator("xpath=..").locator(".scroll-x");
    await expect(box).toHaveCount(1);
    const row=box.getByRole("row").nth(1);
    const first=row.getByRole("cell").first(), last=row.getByRole("cell").last();
    const before=await box.evaluate(el=>{const css=getComputedStyle(el);return{overflowX:css.overflowX,direction:css.direction,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,scrollLeft:el.scrollLeft};});
    expect(before.overflowX,"table container must scroll, not clip").toMatch(/^(auto|scroll)$/);
    expect(before.direction).toBe("rtl");
    expect(before.scrollWidth,`table wider than its card at ${width}px`).toBeGreaterThan(before.clientWidth);
    expect(before.scrollLeft).toBe(0);
    expect(await horizontallyInside(last,box),"far column is out of view before scrolling").toBe(false);
    expect(await horizontallyInside(first,box),"first column is in view before scrolling").toBe(true);

    // RTL-safe: جهت انتهای محتوا از خودِ مرورگر پرسیده می‌شود (منفی در مدل استاندارد RTL، مثبت در مدل قدیمی).
    const moved=await box.evaluate(el=>{
      const max=el.scrollWidth-el.clientWidth;
      el.scrollLeft=-max;
      if(el.scrollLeft===0) el.scrollLeft=max;
      return{max,scrollLeft:el.scrollLeft};
    });
    expect(Math.abs(moved.scrollLeft),"container scrolled to its far end").toBeGreaterThanOrEqual(moved.max-1);
    expect(await horizontallyInside(last,box),`far column reachable after scrolling at ${width}px`).toBe(true);
    await expect(last).toContainText("200");
    expect(await horizontallyInside(first,box),"first column scrolled out of view").toBe(false);
    const after=await documentWidth(page);
    expect(after.scroll,"inner scroll never widens the page").toBeLessThanOrEqual(after.client);
  }
});

/**
 * زمان‌بندی rAF در دست آزمون است، نه در دست مسابقه: فراخوان‌ها نگه داشته و فقط با __rafFlush اجرا می‌شوند.
 * فقط همین یک مسیر در برنامه rAF دارد (app.tsx، switchZone)؛ تعداد اجراشده هم سنجیده می‌شود تا ادعا تهی نباشد.
 */
async function holdAnimationFrames(page:Page){
  await page.addInitScript(()=>{
    const native=window.requestAnimationFrame.bind(window);
    let held:FrameRequestCallback[]|null=null;
    const w=window as unknown as {__rafHold:()=>void;__rafFlush:()=>number};
    w.__rafHold=()=>{held=[];};
    w.__rafFlush=()=>{const queue=held??[];held=null;for(const cb of queue)cb(performance.now());return queue.length;};
    window.requestAnimationFrame=cb=>{if(held){held.push(cb);return 0;}return native(cb);};
  });
}
async function switchToTreasuryWithHeldFrame(page:Page){
  await page.goto("/");
  await expect(page.getByRole("heading",{name:"امروز"})).toBeVisible();
  const nav=page.getByRole("tablist",{name:"بخش‌ها",exact:true});
  const phone=page.viewportSize()!.width<900;
  // گوشی: خزانه در برگهٔ مودال «بیشتر» است و مقصدش پیوند است، نه زبانه.
  if(phone) await page.getByRole("button",{name:"بخش‌های بیشتر",exact:true}).click();
  const target=phone?page.getByRole("dialog",{name:"همهٔ بخش‌ها"}).getByRole("link",{name:"خزانه و چک",exact:true}):nav.getByRole("tab",{name:"خزانه و چک",exact:true});
  await expect(target).toBeVisible();
  await page.evaluate(()=>(window as unknown as {__rafHold:()=>void}).__rafHold());
  await target.click();
  const sub=page.getByRole("tablist",{name:"بخش‌های خزانه",exact:true});
  await expect(sub).toBeVisible();
  return sub;
}
const flushFrames=(page:Page)=>page.evaluate(()=>(window as unknown as {__rafFlush:()=>number}).__rafFlush());

test("zone switch moves focus to the workspace when nothing newer took focus", async ({page}) => {
  await holdAnimationFrames(page);
  await switchToTreasuryWithHeldFrame(page);
  expect(await flushFrames(page)).toBeGreaterThanOrEqual(1);
  await expect(page.locator("main#workspace-content")).toBeFocused();
});

test("a late zone-switch focus never steals a newer sub-tab focus", async ({page}) => {
  await holdAnimationFrames(page);
  const sub=await switchToTreasuryWithHeldFrame(page);
  const tabs=sub.getByRole("tab");
  await sub.locator('[aria-selected="true"]').focus();
  await sub.locator('[aria-selected="true"]').press("End");
  await expect(tabs.last()).toBeFocused();
  expect(await flushFrames(page)).toBeGreaterThanOrEqual(1);
  await expect(tabs.last()).toBeFocused();
  await expect(page.locator("main#workspace-content")).not.toBeFocused();
});
