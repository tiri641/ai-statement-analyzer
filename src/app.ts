import { Hono } from "hono";

export interface HealthDatabase {
  query(text: string): Promise<unknown>;
}

export function createApp(database: HealthDatabase) {
  const app = new Hono();

  app.get("/health", (context) => {
    return context.json({
      status: "ok",
      service: "api",
    });
  });

  app.get("/health/db", async (context) => {
    try {
      await database.query("SELECT 1");

      return context.json({
        status: "ok",
        database: "ok",
      });
    } catch {
      console.error(
        JSON.stringify({
          event: "database_health_check_failed",
          errorCode: "DATABASE_UNAVAILABLE",
        }),
      );

      return context.json(
        {
          status: "error",
          database: "unavailable",
        },
        503,
      );
    }
  });

  return app;
}
