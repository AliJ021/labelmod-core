import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {deliverBale,verifyBaleChat} from "../src/operations/bale-backup.ts";

const target={token:"synthetic",chat:"123",recipient:"test"};
test("Bale must resolve the exact private chat before upload",async()=>{
  for(const [id,type] of [[123,"group"],[124,"private"]] as const){
    await assert.rejects(verifyBaleChat(target,async()=>Response.json({ok:true,result:{id,type}})),/private_chat/);
  }
  await verifyBaleChat(target,async()=>Response.json({ok:true,result:{id:123,type:"private"}}));
});
test("Bale acknowledgement is bound to the private recipient and encrypted attachment",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"lm-bale-test-"));
  try{
    const file=join(dir,"sample.age");await writeFile(file,"synthetic-ciphertext");
    const send:typeof fetch=async(url,init)=>{
      assert.ok(String(url).endsWith("/sendDocument"));assert.equal(init?.redirect,"error");
      const form=init?.body as FormData;
      const doc=form.get("document") as File;
      assert.equal(form.get("chat_id"),"123");assert.equal(doc.name,"labelmod-2026-11-26.dump.age");
      assert.equal(await doc.text(),"synthetic-ciphertext");
      return Response.json({ok:true,result:{message_id:77,chat:{type:"private",id:123}}});
    };
    for (const messageId of [0,-1]) {
      const pending = async () => Response.json({ok:true,result:{message_id:messageId,chat:{type:"private",id:123}}});
      await assert.rejects(deliverBale(target,file,"2026-11-26","a".repeat(64),pending),/delivery/);
    }
    assert.equal(await deliverBale(target,file,"2026-11-26","a".repeat(64),send),"77");
    await assert.rejects(deliverBale(target,file,"2026-11-26","a".repeat(64),async()=>Response.json({ok:true,result:{message_id:77,chat:{id:999,type:"private"}}})),/delivery/);
  }finally{await rm(dir,{recursive:true});}
});
