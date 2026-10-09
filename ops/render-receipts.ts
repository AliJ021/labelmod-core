// Reproducible synthetic visual fixtures; run from the repository with Node type stripping.
// PLAYWRIGHT_EDGE=1 uses an installed Edge for local Windows development.
/* global document:readonly, innerWidth:readonly */
import { createRequire } from 'node:module';
import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { invoicePage } from '../apps/api/src/sales/invoice-page.ts';
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const output = resolve(process.argv[2] ?? 'docs/print-previews/receipt-v2');
await mkdir(output, { recursive: true });
const lines = [
  { productName:'مانتو کتان بلند با آستین پفی و جیب‌های دوخت دستی مدل تابستانه ۱۴۰۵',color:'سرمه‌ای',size:'M',qty:'1.000',unitPrice:48900000n,discountAmount:4890000n,netAmount:44010000n },
  { productName:'شلوار پارچه‌ای رگولار',color:'مشکی',size:'36',qty:'2.000',unitPrice:12345675n,discountAmount:0n,netAmount:24691350n },
  { productName:'شال نخی',color:null,size:null,qty:'1.000',unitPrice:3500000n,discountAmount:0n,netAmount:3500000n },
];
const base = {number:'F-1405-000123',occurredAt:new Date('2026-10-02T15:40:00Z'),shopName:'فروشگاه لیبل مد',customerName:'سارا محمدی',lines,netAmount:72201350n,taxAmount:0n,shippingAmount:0n,payableAmount:72201350n,paidAmount:70000000n,returnWindowHours:48,website:'labelmod.ir'};
const fixtures = {
  standard:base,
  proforma:{...base,documentKind:'proforma',number:'11111111-2222-4333-8444-555555555555',paidAmount:0n},
  zero100:{...base,lines:[{...lines[0],discountAmount:48900000n,netAmount:0n}],netAmount:0n,payableAmount:0n,paidAmount:0n},
  debtor:{...base,shippingAmount:1000000n,taxAmount:100000n,payableAmount:73301350n,paidAmount:20000000n},
  longnames:{...base,customerName:'Elizabeth / مشتری با نام خانوادگی بسیار بلند',lines:[{...lines[0],productName:'Oversized-Waterproof-Collection-2026 مدل ویژه کت بلند پارچه‌ای با جیب‌های دوخت دستی',color:'آبی روشن',netAmount:44010000n}],netAmount:44010000n,payableAmount:44010000n,paidAmount:0n,exchangeAmount:44010000n},
  rows32:{...base,lines:Array.from({length:32},(_,i)=>({...lines[i%3],productName:`${lines[i%3].productName} — ${i+1}`}))},
};
fixtures.rows32.netAmount = fixtures.rows32.lines.reduce((n,l)=>n+l.netAmount,0n);
fixtures.rows32.payableAmount = fixtures.rows32.netAmount;
fixtures.rows32.paidAmount = fixtures.rows32.netAmount;
const browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EDGE==='1'?{channel:'msedge'}:{})});
try {
  const page = await browser.newPage({viewport:{width:303,height:1100},deviceScaleFactor:2});
  const checks=[];
  for (const [name,data] of Object.entries(fixtures)) {
    const html=invoicePage(data,'Asia/Tehran');
    await writeFile(resolve(output,`${name}.html`),html);
    for(const mode of ['print','screen']) {
      await page.setViewportSize({width:mode==='print'?303:390,height:1100});
      await page.emulateMedia({media:mode});
      await page.setContent(html); await page.evaluate(()=>document.fonts.ready);
      await page.locator('.logo').evaluate(img=>img.decode());
      const check=await page.evaluate(()=>({
        latin:!/[۰-۹٠-٩]/.test(document.body.innerText),
        horizontalOverflow:document.documentElement.scrollWidth>innerWidth,
        escapedCells:[...document.querySelectorAll('td,th,dd')].filter(el=>el.scrollWidth>el.clientWidth+1).map(el=>el.innerText),
      }));
      if(!check.latin||check.horizontalOverflow||check.escapedCells.length)throw new Error(`${name}/${mode}: ${JSON.stringify(check)}`);
      if(mode==='print') await page.setViewportSize({width:303,height:Math.ceil(await page.locator('.sheet').evaluate(el=>el.getBoundingClientRect().bottom))+1});
      await page.screenshot({path:resolve(output,`${name}-${mode}.png`),fullPage:true});
      checks.push({name,mode,...check});
    }
  }
  await writeFile(resolve(output,'checks.json'),JSON.stringify(checks,null,2));
  console.log(`${checks.length} visual checks passed; ${output}`);
} finally { await browser.close(); }
