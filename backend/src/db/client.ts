import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

export interface QueryExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface DbClient extends QueryExecutor {
  transaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Create a unified PostgreSQL client backed either by `pg.Pool` (postgres://...)
 * or embedded `PGlite` (pglite://memory or pglite://./path) so local/CI runs use
 * the exact same PostgreSQL dialect as Docker Compose.
 */
export async function createDbClient(databaseUrl: string): Promise<DbClient> {
  if (databaseUrl.startsWith('pglite://')) {
    const target = databaseUrl.slice('pglite://'.length);
    let pglite: PGlite;
    if (!target || target === 'memory') {
      pglite = new PGlite();
    } else {
      const resolvedPath = resolve(target);
      mkdirSync(dirname(resolvedPath), { recursive: true });
      mkdirSync(resolvedPath, { recursive: true });
      pglite = new PGlite(resolvedPath);
    }
    await pglite.waitReady;

    return {
      async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
        const res = await pglite.query<T>(sql, params);
        return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
      },
      async transaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T> {
        return pglite.transaction(async (tx) => {
          const executor: QueryExecutor = {
            async query<R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<R>> {
              const res = await tx.query<R>(sql, params);
              return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
            },
          };
          return fn(executor);
        });
      },
      async close(): Promise<void> {
        await pglite.close();
      },
    };
  }

  const pool = new Pool({ connectionString: databaseUrl });
  return {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
      const res = await pool.query(sql, params);
      return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length };
    },
    async transaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const executor: QueryExecutor = {
          async query<R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<R>> {
            const res = await client.query(sql, params);
            return { rows: res.rows as R[], rowCount: res.rowCount ?? res.rows.length };
          },
        };
        const result = await fn(executor);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

