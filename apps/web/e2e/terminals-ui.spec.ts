import {test, expect, type MockApi} from "./fixtures";

const term={id:"t1",code:"POS-01",name:"کارت‌خوان شعبه آزمایشی",kind:"card_terminal",feePercent:"0.235",settlementDays:1,canEdit:true};
function setup(api:MockApi, canEdit=true){
  api.defaults["GET /settlement-terms"]={terms:[{...term,canEdit}]};
  api.defaults["GET /device-drivers"]={drivers:[{code:"pending-sdk",label:"دستگاه در انتظار اتصال",deviceKind:"card_terminal",vendor:"آزمایشی",sdkDocUrl:null,notes:null,isImplemented:false,isActive:true}]};
  api.defaults["GET /terminal-drivers"]={terminals:[{accountId:"t1",accountCode:term.code,accountName:term.name,driverCode:null,canEdit}]};
}
test("terminal layout separates settlement and device readiness",async({page,api},info)=>{
  setup(api); await page.goto("/?page=settings&settings.tab=terminals");
  await expect(page.getByRole("heading",{name:"کارمزد و دوره تسویه",exact:true})).toBeVisible();
  await expect(page.getByText("هیچ درایوری هنوز پیاده نشده است.",{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  if(process.env.TERMINAL_EVIDENCE) await page.screenshot({path:`${process.env.TERMINAL_EVIDENCE}-${info.project.name}.png`,fullPage:true});
});

test("terminal read-only permissions disable settlement and device edits",async({page,api})=>{
  setup(api,false);
  api.handlers.set("GET /auth/can",async(route,url)=>{await route.fulfill({json:{verdict:url.searchParams.get("operation")==="settings.security"?"deny":"allow"}});});
  await page.goto("/?page=settings&settings.tab=terminals");
  await expect(page.getByLabel("دوره تسویه (روز)",{exact:true})).toBeDisabled();
  await expect(page.getByLabel("کارمزد (٪)",{exact:true})).toBeDisabled();
  await expect(page.getByRole("button",{name:"ذخیره شرایط",exact:true})).toBeDisabled();
  await expect(page.getByLabel("دستگاه",{exact:true})).toBeDisabled();
  await page.getByText("مستندات SDK دستگاه‌های شناخته‌شده — افزودن و ویرایش",{exact:true}).click();
  await expect(page.getByLabel("نام",{exact:true})).toBeDisabled();
  await expect(page.getByRole("button",{name:"افزودن دستگاه تازه"})).toHaveCount(0);
  expect(api.calls.filter(c=>/^(PATCH|PUT|POST) \/(settlement|device|terminal)/.test(c))).toEqual([]);
});

test("failed driver loading exposes read-only recovery instead of infinite loading",async({page,api})=>{
  setup(api);api.handlers.set("GET /device-drivers",async route=>{await route.abort();});
  await page.goto("/?page=settings&settings.tab=terminals");
  const retry=page.getByRole("button",{name:"تلاش دوباره برای دستگاه‌ها",exact:true});
  await expect(retry).toBeVisible();
  api.handlers.delete("GET /device-drivers");await retry.click();
  await expect(page.getByLabel("دستگاه",{exact:true})).toBeEnabled();
  await expect(page.locator('option[value="pending-sdk"]')).toBeDisabled();
  expect(api.calls.filter(c=>/^(PATCH|PUT|POST) \/(settlement|device|terminal)/.test(c))).toEqual([]);
});

test("terminal lost save response preserves draft and requires a read before another change",async({page,api})=>{
  setup(api);let writes=0;
  api.handlers.set("PATCH /settlement-terms/t1",async route=>{
    writes++;expect(route.request().postDataJSON()).toEqual({settlementDays:2,feePercent:"0.500",reason:"اصلاح قرارداد"});
    api.defaults["GET /settlement-terms"]={terms:[{...term,settlementDays:2,feePercent:"0.500"}]};
    await route.abort();
  });
  await page.goto("/?page=settings&settings.tab=terminals");
  await page.getByLabel("دوره تسویه (روز)",{exact:true}).fill("۲");
  // تشخیصی، نه رفع: در یک شکست متناوب WebKit مقدار نخستین fill در همان اقدام ننشست (trace run 38040563067). این خط شکست را به همان گام نسبت می‌دهد.
  await expect(page.getByLabel("دوره تسویه (روز)",{exact:true})).toHaveValue("۲");
  await page.getByLabel("کارمزد (٪)",{exact:true}).fill("۰.۵۰۰");
  await page.getByLabel("دلیل",{exact:false}).fill("اصلاح قرارداد");
  const save=page.getByRole("button",{name:"ذخیره شرایط",exact:true});await save.click();
  await expect(page.getByRole("alert")).toContainText("پیش از تغییر بعدی");await expect(save).toBeDisabled();
  await expect(page.getByLabel("کارمزد (٪)",{exact:true})).toHaveValue("۰.۵۰۰");
  await page.getByRole("button",{name:"تازه‌سازی شرایط",exact:true}).click();
  await expect(page.getByLabel("کارمزد (٪)",{exact:true})).toBeEnabled();await expect(save).toBeDisabled();
  expect(writes).toBe(1);
});

test("definite terminal validation rejection keeps editable inputs",async({page,api})=>{
  setup(api);api.handlers.set("PATCH /settlement-terms/t1",async route=>{await route.fulfill({status:400,json:{error:{code:"validation",message:"کارمزد معتبر نیست"}}});});
  await page.goto("/?page=settings&settings.tab=terminals");
  const fee=page.getByLabel("کارمزد (٪)",{exact:true});await fee.fill("-1");
  await page.getByRole("button",{name:"ذخیره شرایط",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("کارمزد معتبر نیست");
  await expect(fee).toBeEnabled();await expect(fee).toHaveValue("-1");
});

test("saving terminal terms preserves its name and permission from the partial API response",async({page,api})=>{
  setup(api);api.handlers.set("PATCH /settlement-terms/t1",async route=>{await route.fulfill({json:{id:"t1",settlementDays:2,feePercent:"0.500"}});});
  await page.goto("/?page=settings&settings.tab=terminals");
  await page.getByLabel("دوره تسویه (روز)",{exact:true}).fill("۲");
  const fee=page.getByLabel("کارمزد (٪)",{exact:true});await fee.fill("۰.۵۰۰");
  const save=page.getByRole("button",{name:"ذخیره شرایط",exact:true});await save.click();
  await expect(page.getByRole("status").filter({hasText:"ذخیره شد"})).toBeVisible();
  await expect(page.getByText(term.name,{exact:true})).toHaveCount(2);
  await expect(fee).toBeEnabled();await expect(save).toBeDisabled();
  await fee.fill("0.600");await expect(save).toBeEnabled();
});

test("refresh synchronizes pristine terminal inputs without enabling an old-value overwrite",async({page,api})=>{
  setup(api);await page.goto("/?page=settings&settings.tab=terminals");
  const days=page.getByLabel("دوره تسویه (روز)",{exact:true});
  const fee=page.getByLabel("کارمزد (٪)",{exact:true});
  await expect(fee).toHaveValue("0.235");
  api.defaults["GET /settlement-terms"]={terms:[{...term,settlementDays:3,feePercent:"0.750"}]};
  await page.getByRole("button",{name:"تازه‌سازی شرایط",exact:true}).click();
  await expect(days).toHaveValue("3");await expect(fee).toHaveValue("0.750");
  await expect(page.getByRole("button",{name:"ذخیره شرایط",exact:true})).toBeDisabled();
  expect(api.calls.filter(c=>c.startsWith("PATCH /settlement-terms"))).toEqual([]);
});

test("refresh preserves genuinely edited terminal drafts",async({page,api})=>{
  setup(api);await page.goto("/?page=settings&settings.tab=terminals");
  const days=page.getByLabel("دوره تسویه (روز)",{exact:true});
  const fee=page.getByLabel("کارمزد (٪)",{exact:true});
  await fee.fill("۰.۵۰۰");
  // تشخیصی، نه رفع: در یک شکست متناوب WebKit مقدار نخستین fill در همان اقدام ننشست (trace run 38040563067). این خط شکست را به همان گام نسبت می‌دهد.
  await expect(fee).toHaveValue("۰.۵۰۰");
  await page.getByLabel("دلیل",{exact:false}).fill("پیش‌نویس قرارداد");
  api.defaults["GET /settlement-terms"]={terms:[{...term,settlementDays:3,feePercent:"0.750"}]};
  await page.getByRole("button",{name:"تازه‌سازی شرایط",exact:true}).click();
  await expect(fee).toBeEnabled();await expect(fee).toHaveValue("۰.۵۰۰");await expect(days).toHaveValue("1");
  await expect(page.getByLabel("دلیل",{exact:false})).toHaveValue("پیش‌نویس قرارداد");
  await expect(page.getByRole("button",{name:"ذخیره شرایط",exact:true})).toBeEnabled();
  expect(api.calls.filter(c=>c.startsWith("PATCH /settlement-terms"))).toEqual([]);
});

/*
 * ریشهٔ شکست متناوب WebKit در خطوط ۴۲ و ۹۴: ورودیِ نخست، پیش از اجرای effectِ mount در TermRow.
 * آن effect با مقدارهای render نخست (closure کهنه) «ردیف دست‌نخورده است» نتیجه می‌گرفت و پیش‌نویس
 * را به مقدار سرور برمی‌گرداند. اینجا ورودی درست در microtask پس از commit (پیش از effectهای passive)
 * فرستاده می‌شود تا همان پنجره، بی وابستگی به زمان‌بندی موتور، قطعی شود.
 */
test("a value entered as soon as the terms row mounts is not reset by the initial draft sync",async({page,api})=>{
  setup(api);
  await page.addInitScript(()=>{
    const setValue=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!;
    const observer=new MutationObserver(()=>{
      const fee=document.querySelector<HTMLInputElement>('.terminal-fields input[inputmode="decimal"]');
      if(!fee) return;
      observer.disconnect();
      setValue.call(fee,"0.500");fee.dispatchEvent(new Event("input",{bubbles:true}));
    });
    observer.observe(document,{childList:true,subtree:true});
  });
  await page.goto("/?page=settings&settings.tab=terminals");
  const fee=page.getByLabel("کارمزد (٪)",{exact:true});
  await expect(fee).toBeEnabled();
  await expect(fee).toHaveValue("0.500");
  await expect(page.getByRole("button",{name:"ذخیره شرایط",exact:true})).toBeEnabled();
});
