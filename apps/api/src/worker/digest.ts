import { sql } from "kysely";
import type { HandlerContext, HandlerResult, OutboxMessage } from "./handlers.ts";
import { SmsError, toLocalMobile } from "./sms.ts";
import { toTomanExact } from "../sales/invoice-page.ts";

export const metricTokens = ["حضوری", "سایت", "اینستاگرام", "جمع"] as const;
type Metric = typeof metricTokens[number];
export function digestContent(template: string, amounts: Record<Metric, string>) {
  const args: string[] = [];
  const text = template.replace(/\{([^{}]+)\}/g, (_, key: string) => {
    if (!Object.hasOwn(amounts, key)) throw new SmsError("نام یکی از عددهای قالب گزارش شناخته نشد", true);
    const amount = amounts[key as Metric];
    args.push(amount);
    return amount;
  });
  if (!args.length || args.length > 10 || /[{}]/.test(text)) throw new SmsError("برای قالب گزارش یک تا ده جای عدد مشخص کنید", true);
  return { args, text };
}

export async function sendManagerDigest(ctx: HandlerContext, msg: OutboxMessage): Promise<HandlerResult> {
  const date = String(msg.payload["date"]);
  const cfg = (await sql<{enabled:boolean; template:string; pattern:number|null}>`
    SELECT digest_enabled AS enabled,digest_copy AS template,digest_pattern AS pattern
    FROM platform.melipayamak_credential WHERE singleton`.execute(ctx.db)).rows[0];
  if (!cfg?.enabled || ctx.settings.provider !== "melipayamak") return {done:true,note:"گزارش پیامکی مدیر غیرفعال است"};
  const to = toLocalMobile(ctx.settings.managerMobile);
  if (!to) throw new SmsError("موبایل مدیر را در تنظیمات اعلان‌ها وارد کنید");
  const sums = await sql<{channel:string; amount:string}>`
    SELECT channel, (net_amount - return_amount)::text AS amount
    FROM sales.report_summary(${date}::date, ${date}::date, NULL)`.execute(ctx.db);
  const by = new Map(sums.rows.map(r=>[r.channel,BigInt(r.amount)]));
  const pos=by.get("pos")??0n, web=by.get("web")??0n, ig=by.get("instagram")??0n;
  const content=digestContent(cfg.template,{"حضوری":toTomanExact(pos),"سایت":toTomanExact(web),"اینستاگرام":toTomanExact(ig),"جمع":toTomanExact(pos+web+ig)});
  const claim=await sql`UPDATE platform.manager_digest SET state='sending',rendered=${content.text},updated_at=now()
    WHERE report_date=${date}::date AND state='queued' RETURNING report_date`.execute(ctx.db);
  if (!claim.rows.length) {
    const previous=await sql<{state:string}>`SELECT state FROM platform.manager_digest WHERE report_date=${date}::date`.execute(ctx.db);
    if(previous.rows[0]?.state==="accepted") return {done:true,note:"گزارش پیش‌تر پذیرفته شده"};
    throw new SmsError("نتیجهٔ ارسال قبلی گزارش مدیر نیازمند تطبیق است", true);
  }
  let ref;
  try {
    ref=await ctx.sms.send(to,content.text,{purpose:"digest",args:content.args,bodyId:cfg.pattern});
  } catch (error) {
    const state=error instanceof SmsError && !error.uncertain ? "queued" : "unknown";
    await sql`UPDATE platform.manager_digest SET state=${state},updated_at=now() WHERE report_date=${date}::date`.execute(ctx.db);
    throw error;
  }
  await sql`UPDATE platform.manager_digest SET state='accepted',provider_ref=${ref??null},updated_at=now() WHERE report_date=${date}::date`.execute(ctx.db);
  return {done:true,note:"گزارش فروش به ملی‌پیامک تحویل شد"};
}
