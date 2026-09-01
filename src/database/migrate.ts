import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool, PoolClient } from "pg";

interface MigrationPool {
  connect(): Promise<PoolClient>;
}

interface MigrationFile {
  version: string;
  filePath: string;
}

function isMigrationFile(fileName: string): boolean {
  return /^\d+_[a-z0-9_]+\.sql$/.test(fileName);
}

function toMigrationFile(fileName: string, directory: string): MigrationFile {
  return {
    version: fileName.slice(0, -4),
    filePath: path.join(directory, fileName),
  };
}

async function listMigrationFiles(directory: string): Promise<MigrationFile[]> {
  const fileNames = await readdir(directory);

  return fileNames
    .filter(isMigrationFile)
    .sort((left, right) => {
      const leftNumber = Number(left.match(/^\d+/)?.[0]);
      const rightNumber = Number(right.match(/^\d+/)?.[0]);
      return leftNumber - rightNumber;
    })
    .map((fileName) => toMigrationFile(fileName, directory));
}

async function rollback(client: PoolClient, originalError: unknown): Promise<never> {
  try {
    await client.query("ROLLBACK");
  } catch (rollbackError) {
    throw new AggregateError(
      [originalError, rollbackError],
      "MigrationとRollbackの両方に失敗しました",
    );
  }

  throw originalError;
}

export async function runMigrations(
  pool: Pick<Pool, "connect"> | MigrationPool,
  directory: string,
): Promise<void> {
  const migrationFiles = await listMigrationFiles(directory);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT NOW()
      )
    `);

    for (const migration of migrationFiles) {
      const applied = await client.query(
        "SELECT 1 FROM schema_migrations WHERE version = $1",
        [migration.version],
      );

      if (applied.rowCount !== 0) {
        continue;
      }

      const sql = await readFile(migration.filePath, "utf8");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1)",
        [migration.version],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await rollback(client, error);
  } finally {
    client.release();
  }
}
