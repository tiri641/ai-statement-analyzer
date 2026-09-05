import "dotenv/config";
import { serve } from "@hono/node-server";
import { Pool } from "pg";
import { createApp } from "./app.js";
import { StatementRepository } from "./database/statement-repository.js";
import { isLoopbackHost } from "./server-safety.js";

const port = Number(process.env.PORT ?? "3000");
const host = process.env.HOST ?? "127.0.0.1";
const databaseUrl = process.env.DATABASE_URL;

if (!isLoopbackHost(host)) {
  console.error(
    JSON.stringify({
      event: "api_start_failed",
      errorCode: "AUTH_REQUIRED_FOR_NON_LOOPBACK_HOST",
    }),
  );
  process.exit(1);
}

if (!databaseUrl) {
  console.error(
    JSON.stringify({
      event: "api_start_failed",
      errorCode: "DATABASE_URL_MISSING",
    }),
  );
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 2_000,
  query_timeout: 2_000,
});
const app = createApp({
  database: pool,
  statements: new StatementRepository(pool),
});
const server = serve(
  {
    fetch: app.fetch,
    hostname: host,
    port,
  },
  (info) => {
    console.log(
      JSON.stringify({
        event: "api_started",
        host: info.address,
        port: info.port,
      }),
    );
  },
);

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(JSON.stringify({ event: "api_shutdown_started", signal }));
  server.close();
  await pool.end();
  console.log(JSON.stringify({ event: "api_shutdown_completed" }));
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
