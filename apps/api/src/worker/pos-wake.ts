import pg from "pg";
import { setTimeout as delay } from "node:timers/promises";

// LISTEN needs a session of its own. Reconnects wake the consumer to cover
// commits made while disconnected. Polling continues throughout.
export function listenForPosStock(url: string, wake: () => void, log: (line: string) => void) {
  const stop = new AbortController();
  const done = (async () => {
    while (!stop.signal.aborted) {
      const client = new pg.Client({ connectionString: url, application_name: "lmc-pos-stock-listener", connectionTimeoutMillis: 5000, keepAlive: true });
      let disconnected!: () => void;
      const closed = new Promise<void>(resolve => { disconnected = resolve; });
      client.on("end", disconnected);
      client.on("error", disconnected);
      client.on("notification", msg => { if (msg.channel === "lmc_pos_stock") wake(); });
      stop.signal.addEventListener("abort", disconnected, { once: true });
      try {
        await client.connect();
        await client.query("LISTEN lmc_pos_stock");
        wake();
        await closed;
      } catch {
        // Connection or LISTEN failed. Release the session before retrying.
      } finally {
        stop.signal.removeEventListener("abort", disconnected);
        await client.end().catch(() => undefined);
      }
      if (!stop.signal.aborted) {
        log("POS stock listener disconnected; polling continues");
        await delay(5000, undefined, { signal: stop.signal }).catch(() => undefined);
      }
    }
  })();
  return { stop: () => { stop.abort(); return done; } };
}
