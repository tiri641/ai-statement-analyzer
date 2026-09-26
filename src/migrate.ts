import "dotenv/config";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { getDatabasePoolConfig } from "./config/database.js";
import { runMigrations } from "./database/migrate.js";
import { createStructuredLogger } from "./observability/logger.js";

const logger = createStructuredLogger({ service: "migration" });
let databaseConfig: ReturnType<typeof getDatabasePoolConfig> | null = null;
try {
  databaseConfig = getDatabasePoolConfig(process.env);
} catch {
  databaseConfig = null;
}

if (!databaseConfig) {
  logger.error({
    event: "migration_failed",
    errorCode: "DATABASE_CONFIG_MISSING",
  });
  process.exitCode = 1;
} else {
  const pool = new Pool(databaseConfig);

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
