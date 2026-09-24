import "dotenv/config";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { runMigrations } from "./database/migrate.js";
import { createStructuredLogger } from "./observability/logger.js";

const databaseUrl = process.env.DATABASE_URL;
const logger = createStructuredLogger({ service: "migration" });

if (!databaseUrl) {
  logger.error({
    event: "migration_failed",
    errorCode: "DATABASE_URL_MISSING",
  });
  process.exitCode = 1;
} else {
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const migrationDirectory = fileURLToPath(
      new URL("../migrations", import.meta.url),
    );
    await runMigrations(pool, migrationDirectory);
    logger.info({ event: "migration_completed", status: "completed" });
  } catch {
    logger.error({
      event: "migration_failed",
      errorCode: "MIGRATION_ERROR",
    });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
