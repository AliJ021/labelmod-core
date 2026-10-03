import { sql } from "kysely";
import { z } from "zod";
import type { Db } from "../../db/client.ts";
import type { ResolvedSession } from "../../auth/service.ts";
import { requireHumanSession } from "../../auth/human-session.ts";

const uuid=z.string().uuid();
/** ذخیره آفلاین؛ بدون HTTP، worker، شبکه یا رسید. شاهد فقط از آداپتور مورد اعتماد سرور. */
export class ProviderIntentStore {
  readonly #db: Db;
  constructor(db: Db){this.#db=db;}
  async create(session: ResolvedSession, raw: unknown) {
    const p=z.object({invoiceId:uuid,provider:z.enum(["snappay","digipay"]),key:uuid,configRevision:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(raw);
    return this.#db.transaction().execute(async trx=>{
      await requireHumanSession(trx,session);
      const result=await sql<{id:string}>`SELECT sales.create_provider_intent(${p.invoiceId}::uuid,${p.provider},${p.key}::uuid,${p.configRevision},${session.userId}::uuid) id`.execute(trx);
      return result.rows[0]!.id;
    });
  }
}
