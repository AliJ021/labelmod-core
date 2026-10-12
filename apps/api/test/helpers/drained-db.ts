import type { DbHandle } from "../../src/db/client.ts";

/** فقط fixture: pool.end پیش از پایان واقعی socketها resolve می‌شود. */
export function drainDbOnClose(handle: DbHandle, timeoutMs = 10_000): DbHandle {
  const disconnected: Promise<void>[] = [];
  // پیش از اولین query ثبت می‌شود تا پایان اتصال idle هم از دست نرود.
  handle.pool.on("connect", (client) => {
    disconnected.push(new Promise<void>((resolve) => client.once("end", resolve)));
  });
  return {
    ...handle,
    async close() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            await handle.close();
            await Promise.all(disconnected);
          })(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("اتصال‌های دیتابیس آزمون در مهلت مقرر بسته نشدند")), timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
