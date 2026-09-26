/**
 * نقطه ورود سرویس API.
 */
import { loadConfig } from "./lib/config.ts";
import { createDb } from "./db/client.ts";
import { assertRuntimeDatabaseRole } from "./db/runtime-role.ts";
import { AuthService } from "./auth/service.ts";
import { buildApp } from "./http/app.ts";

const config = loadConfig();
const handle = createDb(config.DATABASE_URL, config.DB_POOL_MAX);
await assertRuntimeDatabaseRole(handle, config.isProduction);
const app = await buildApp({
  db: handle.db,
  auth: new AuthService(handle.db),
  config,
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "در حال خاموش شدن");
  await app.close();
  await handle.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: config.PORT, host: config.HOST });
