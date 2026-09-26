import type { PoolConfig } from "pg";

export class DatabaseConfigurationError extends Error {
  public constructor(message = "Database configuration is invalid") {
    super(message);
    this.name = "DatabaseConfigurationError";
  }
}

type DatabasePoolConfig = Pick<
  PoolConfig,
  "connectionString" | "host" | "port" | "database" | "user" | "password"
>;

export function getDatabasePoolConfig(
  environment: NodeJS.ProcessEnv,
): DatabasePoolConfig {
  const connectionString = environment.DATABASE_URL?.trim();
  if (connectionString) {
    return { connectionString };
  }

  const host = environment.DB_HOST?.trim();
  const database = environment.DB_NAME?.trim();
  const user = environment.DB_USER?.trim();
  const password = environment.DB_PASSWORD;

  if (!host || !database || !user || !password) {
    throw new DatabaseConfigurationError();
  }

  const port = parsePort(environment.DB_PORT ?? "5432");

  return {
    host,
    port,
    database,
    user,
    password,
  };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DatabaseConfigurationError();
  }

  return port;
}
