import { test } from "node:test";
import assert from "node:assert/strict";
import { digestContent } from "../src/worker/digest.ts";
const amounts={"حضوری":"۸۰۰","سایت":"۲۰۰","اینستاگرام":"۰","جمع":"۱۰۰۰"};
test("ترتیب عددهای پترن دقیقاً همان متن انتخابی مدیر است",()=>{
  assert.deepEqual(digestContent("جمع {جمع}، سایت {سایت}",amounts),{text:"جمع ۱۰۰۰، سایت ۲۰۰",args:["۱۰۰۰","۲۰۰"]});
  for(const text of ["ثابت","{نامعلوم}","{جمع}}","{جمع"]){assert.throws(()=>digestContent(text,amounts));}
});
