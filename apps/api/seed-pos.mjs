// کاتالوگ و موجودی برای اندازه‌گیری صندوق در مرورگر واقعی
process.env.NODE_ENV = "production";
const { sql } = await import("kysely");
const { createDb } = await import("/home/user/labelmod-core/apps/api/src/db/client.ts");
const { makeEan13 } = await import("/home/user/labelmod-core/apps/api/src/catalog/barcode.ts");
const url = process.argv[2];
const h = createDb(url, 5);
const BR="00000000-0000-7000-8000-000000000001", WH="00000000-0000-7000-8000-000000000101";
const SYS="00000000-0000-7000-8000-0000000000f1";
const N = 240;
const have = await sql`SELECT count(*)::int AS c FROM catalog.variation WHERE barcode IS NOT NULL`.execute(h.db);
if (have.rows[0].c >= N) { console.log("already seeded:", have.rows[0].c); }
else {
  const sx = `ui${Date.now()}`;
  const p = await sql`INSERT INTO catalog.product (code,name_internal) VALUES (${`P-${sx}`},'مانتو سنجش عملکرد') RETURNING id`.execute(h.db);
  await sql`SELECT platform.set_actor(${SYS}::uuid)`.execute(h.db);
  const base = Number(String(Date.now()).slice(-8));
  const codes = [];
  for (let i=0;i<N;i++) {
    const bc = makeEan13(base + i);
    const v = await sql`INSERT INTO catalog.variation (product_id,color,size,sku,barcode)
      VALUES (${p.rows[0].id}, ${'رنگ '+(i%12)}, ${'سایز '+i}, ${`SKU-${sx}-${i}`}, ${bc}) RETURNING id`.execute(h.db);
    await sql`INSERT INTO catalog.price (variation_id,price_list,amount) VALUES (${v.rows[0].id},'default',1850000)`.execute(h.db);
    await sql`SELECT inventory.apply_movement(${v.rows[0].id}::uuid,${WH}::uuid,60,'purchase_receipt',NULL,NULL,${SYS}::uuid,1100000)`.execute(h.db);
    codes.push(bc);
  }
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/claude-0/-home-user-labelmod-core/f18a79a1-7db0-529a-aace-e54dec3d8c6a/scratchpad/barcodes.json", JSON.stringify(codes));
  console.log("seeded", N, "variations");
}
await h.close();
