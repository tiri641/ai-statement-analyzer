import "dotenv/config";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { runMigrations } from "./database/migrate.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error(
    JSON.stringify({
      event: "migration_failed",
      errorCode: "DATABASE_URL_MISSING",
    }),
  );
  process.exitCode = 1;
} else {
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const migrationDirectory = fileURLToPath(
      new URL("../migrations", import.meta.url),
    );
    await runMigrations(pool, migrationDirectory);
    console.log(JSON.stringify({ event: "migration_completed" }));
  } catch {
    console.error(
      JSON.stringify({
        event: "migration_failed",
        errorCode: "MIGRATION_ERROR",
      }),
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
