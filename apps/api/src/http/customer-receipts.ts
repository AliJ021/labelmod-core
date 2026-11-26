import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { sql } from "kysely";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/client.ts";
import type { HandlerContext, OutboxMessage } from "../worker/handlers.ts";
import { SmsError, toLocalMobile } from "../worker/sms.ts";
import { otpText } from "../worker/sms-copy.ts";
import { toTomanExact } from "../sales/invoice-page.ts";

const authCookie="__Host-lm-receipt", pendingCookie="__Host-lm-receipt-code", formCookie="__Host-lm-receipt-form";
const cookieOptions={httpOnly:true,secure:true,sameSite:"strict",path:"/"} as const;
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
function codeFor(id:string,master:string) {
  return String(createHmac("sha256",Buffer.from(master,"hex")).update("labelmod/customer-receipt/v1/"+id).digest().readUInt32BE(0)%1000000).padStart(6,"0");
}
const html=(s:string)=>s.replace(/[&<>"']/g,c=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" })[c]!);
function page(reply:FastifyReply,body:string) {
  return reply.type("text/html; charset=utf-8").header("Cache-Control","private, no-store")
    .header("Referrer-Policy","no-referrer").header("X-Robots-Tag","noindex, nofollow")
    .header("Content-Security-Policy","default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
    .send('<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>رسیدهای من | لیبل مد</title><style>body{font:16px/1.9 Tahoma,sans-serif;max-width:36rem;margin:6vh auto;padding:1rem}input,button{font:inherit;padding:.45rem}label{display:grid;gap:.3rem;margin-block:1rem}li{margin-block:.4rem}</style><main><h1>رسیدهای من</h1>'+body+'</main></html>');
}
export async function receiptMobile(db:Db,req:FastifyRequest) {
  const token=req.cookies[authCookie];
  if(!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const r=await sql<{mobile:string}>`SELECT mobile FROM platform.receipt_access WHERE session_hash=${hash(token)} AND session_until>clock_timestamp()`.execute(db);
  return r.rows[0]?.mobile??null;
}
export async function deliverReceiptOtp(ctx:HandlerContext,msg:OutboxMessage) {
  const master=ctx.smsCredentialKey;
  if(!master) throw new SmsError("کلید امن ورود مشتری تنظیم نشده است");
  const id=String(msg.payload["id"]);
  if (!ctx.settings.smsEnabled || ctx.settings.provider==="log") return {done:true as const,note:"ارسال کد ورود خاموش است"};
  const row=(await sql<{mobile:string}>`UPDATE platform.receipt_access SET sending_at=clock_timestamp() WHERE id=${id}::uuid AND sending_at IS NULL AND sent_at IS NULL
    AND created_at>now()-interval '2 minutes' AND attempts<3 AND session_hash IS NULL RETURNING mobile`.execute(ctx.db)).rows[0];
  if (!row) return {done:true as const,note:"کد رسید قابل ارسال نیست"};
  const code=codeFor(id,master);
  try {await ctx.sms.send(row.mobile,otpText(code),{purpose:"otp",args:[code]});}
  catch(error){
    if(error instanceof SmsError && !error.uncertain) await sql`UPDATE platform.receipt_access SET sending_at=NULL WHERE id=${id}::uuid AND sent_at IS NULL`.execute(ctx.db);
    throw error;
  }
  await sql`UPDATE platform.receipt_access SET sent_at=now() WHERE id=${id}::uuid`.execute(ctx.db);
  return {done:true as const,note:"کد مشاهدهٔ رسید ارسال شد"};
}
export function registerCustomerReceipts(app:FastifyInstance,db:Db,master:string|undefined) {
  app.register(async scoped=>{
    scoped.addContentTypeParser("application/x-www-form-urlencoded",{parseAs:"string",bodyLimit:1024},(_,s,done)=>done(null,Object.fromEntries(new URLSearchParams(String(s)))));
    const formToken=(reply:FastifyReply)=>{const n=randomBytes(24).toString("hex");reply.setCookie(formCookie,n,{...cookieOptions,maxAge:600});return '<input type="hidden" name="nonce" value="'+n+'">';};
    const valid=(req:FastifyRequest)=>{const n=(req.body as {nonce?:string})?.nonce;return typeof n==="string" && /^[0-9a-f]{48}$/.test(n) && n===req.cookies[formCookie];};
    scoped.get("/customer-receipts",async(req,reply)=>{
      const mobile=await receiptMobile(db,req);
      if (!mobile) return page(reply,'<form method="post" action="customer-receipts/start">'+formToken(reply)+'<label>موبایلی که هنگام خرید دادید<input name="mobile" type="tel" required maxlength="20" autocomplete="tel"></label><button>دریافت کد ورود</button></form>');
      const rows=await sql<{id:string;number:string;amount:string;day:string}>`SELECT i.id,sales.invoice_display_number(i.id) AS number,
        i.payable_amount::text AS amount,platform.business_date(i.occurred_at)::text AS day FROM sales.invoice i JOIN sales.customer c ON c.id=i.customer_id
        WHERE c.mobile_normalized=${mobile} AND i.status IN ('finalized','paid','partially_returned','returned') ORDER BY i.occurred_at DESC,i.id DESC LIMIT 100`.execute(db);
      return page(reply,'<p>آخرین رسیدهای خرید شما</p><ul>'+rows.rows.map(r=>'<li><a href="customer-receipts/view/'+r.id+'">فاکتور '+html(r.number)+'</a> · '+html(toTomanExact(BigInt(r.amount)))+' تومان</li>').join('')+'</ul><form method="post" action="customer-receipts/logout">'+formToken(reply)+'<button>خروج</button></form>');
    });
    scoped.post("/customer-receipts/start",{config:{rateLimit:{max:8,timeWindow:"10 minutes"}}},async(req,reply)=>{
      if(!valid(req))return page(reply.code(403),'صفحهٔ رسیدها را دوباره باز کنید.');
      if(!master)return page(reply.code(503),'ورود پیامکی آماده نیست.');
      const mobile=toLocalMobile(String((req.body as {mobile?:string}).mobile??""));
      const result=mobile ? await db.transaction().execute(async tx=>{
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${mobile},106))`.execute(tx);
        const r=await sql<{id:string}>`INSERT INTO platform.receipt_access(mobile) SELECT ${mobile}
          WHERE (SELECT count(*) FROM platform.receipt_access WHERE mobile=${mobile} AND created_at>now()-interval '1 hour')<3
          AND NOT EXISTS(SELECT FROM platform.receipt_access WHERE mobile=${mobile} AND created_at>now()-interval '60 seconds')
          AND EXISTS(SELECT FROM sales.customer WHERE mobile_normalized=${mobile}) RETURNING id`.execute(tx);
        const id=r.rows[0]?.id;
        if(id)await sql`INSERT INTO platform.outbox_message(topic,payload) VALUES('customer.receipt_otp',jsonb_build_object('id',${id}::uuid))`.execute(tx);
        return id;
      }):undefined;
      // همان پاسخ برای شمارهٔ ناشناخته و درخواست محدودشده؛ کد قبلی تا پایان مهلت کار می‌کند.
      const prior=req.cookies[pendingCookie];
      reply.setCookie(pendingCookie,result ?? (prior && /^[0-9a-f-]{36}$/i.test(prior) ? prior : randomUUID()),{...cookieOptions,maxAge:120});
      return page(reply,'<form method="post" action="verify">'+formToken(reply)+'<label>اگر خریدی با این شماره ثبت شده، کد شش‌رقمی را وارد کنید.<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label><button>مشاهدهٔ رسیدها</button></form>');
    });
    scoped.post("/customer-receipts/verify",{config:{rateLimit:{max:12,timeWindow:"10 minutes"}}},async(req,reply)=>{
      if(!valid(req))return page(reply.code(403),'صفحهٔ رسیدها را دوباره باز کنید.');
      const id=req.cookies[pendingCookie];
      const code=String((req.body as {code?:string}).code??"").replace(/[۰-۹]/g,c=>String("۰۱۲۳۴۵۶۷۸۹".indexOf(c)));
      let token:string|undefined;
      if(master && id && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) && /^\d{6}$/.test(code)){
        token=await db.transaction().execute(async tx=>{
          const r=await sql`UPDATE platform.receipt_access SET attempts=attempts+1 WHERE id=${id}::uuid AND attempts<3 AND session_hash IS NULL
              AND created_at>clock_timestamp()-interval '2 minutes' RETURNING id`.execute(tx);
          if(!r.rows.length || !timingSafeEqual(Buffer.from(code),Buffer.from(codeFor(id,master))))return;
          const t=randomBytes(32).toString("hex");
          await sql`UPDATE platform.receipt_access SET session_hash=${hash(t)},session_until=now()+interval '15 minutes' WHERE id=${id}::uuid`.execute(tx);
          return t;
        });
      }
      if(!token)return page(reply.code(400),'<form method="post" action="verify">'+formToken(reply)+'<label>کد را بررسی و دوباره وارد کنید.<input name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="6"></label><button>بررسی کد</button></form><a href="../customer-receipts">دریافت کد تازه</a>');
      reply.setCookie(authCookie,token,{...cookieOptions,maxAge:900}).clearCookie(pendingCookie,cookieOptions);
      return reply.redirect("../customer-receipts",303);
    });
    scoped.post("/customer-receipts/logout",async(req,reply)=>{
      if(!valid(req))return page(reply.code(403),'صفحه را دوباره باز کنید.');
      const t=req.cookies[authCookie]; if(t)await sql`UPDATE platform.receipt_access SET session_until=now() WHERE session_hash=${hash(t)}`.execute(db);
      return reply.clearCookie(authCookie,cookieOptions).redirect("../customer-receipts",303);
    });
  });
}
