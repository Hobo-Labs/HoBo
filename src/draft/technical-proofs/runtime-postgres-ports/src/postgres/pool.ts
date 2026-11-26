import { newDb, DataType, type IMemoryDb } from "pg-mem";
import type { Pool } from "pg";

import { migrateSchemaStatements } from "./schema.js";

export type PostgresRuntime = {
  pool: Pool;
  memDb?: IMemoryDb;
};

export type PostgresPoolOptions = {
  connectionString?: string;
};

function migrateSchemaSync(memDb: IMemoryDb): void {
  for (const statement of migrateSchemaStatements()) {
    memDb.public.none(statement);
  }
}

export async function createPostgresRuntime(
  options: PostgresPoolOptions = {},
): Promise<PostgresRuntime> {
  if (options.connectionString) {
    const pg = await import("pg");
    const pool = new pg.default.Pool({ connectionString: options.connectionString });
    const { migrateSchema } = await import("./schema.js");
    await migrateSchema(pool);
    return { pool };
  }
  return createPostgresRuntimeSync(options);
}

export function createPostgresRuntimeSync(
  options: PostgresPoolOptions = {},
): PostgresRuntime {
  if (options.connectionString) {
    throw new Error("createPostgresRuntimeSync requires pg-mem; use createPostgresRuntime for DATABASE_URL");
  }

  const memDb = newDb({ autoCreateForeignKeyIndices: true });
  memDb.public.registerFunction({
    name: "current_database",
    implementation: () => "hobo_runtime_postgres",
  });
  memDb.public.registerFunction({
    name: "version",
    implementation: () => "PostgreSQL 16.0 (pg-mem)",
  });
  memDb.public.registerFunction({
    name: "now",
    returns: DataType.timestamptz,
    implementation: () => new Date(),
  });
  memDb.public.registerFunction({
    name: "pg_notify",
    args: [DataType.text, DataType.text],
    implementation: () => undefined,
  });

  const { Pool: MemPool } = memDb.adapters.createPg();
  const pool = new MemPool();
  migrateSchemaSync(memDb);
  return { pool, memDb };
}


export async function withTransaction<T>(
  pool: Pool,
  run: (query: Pool["query"]) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client.query.bind(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
