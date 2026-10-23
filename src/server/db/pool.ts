import pg from "pg";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

// Return BIGINT (int8) and NUMERIC as JS numbers; values in this app stay well inside safe-integer range.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export function createPool(url: string, max = 8): Db {
  const pool = new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30_000 });
  pool.on("error", (e) => console.error("[db] idle client error", e.message));
  return pool;
}

/** Run `fn` inside one transaction. Serialization failures and deadlocks are retried a few times. */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await db.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (e: any) {
      await client.query("ROLLBACK").catch(() => { broken = true; });
      if (attempt < retries && (e?.code === "40001" || e?.code === "40P01")) continue;
      throw e;
    } finally {
      // A connection that cannot even roll back (it was cut) is discarded rather than handed to the next caller.
      client.release(broken);
    }
  }
}

export async function one<T = any>(q: Queryable, text: string, params: unknown[] = []): Promise<T> {
  const r = await q.query(text, params);
  if (r.rowCount !== 1) throw new Error(`expected one row, got ${r.rowCount}: ${text.slice(0, 80)}`);
  return r.rows[0] as T;
}

export async function maybeOne<T = any>(q: Queryable, text: string, params: unknown[] = []): Promise<T | null> {
  const r = await q.query(text, params);
  return (r.rows[0] as T) ?? null;
}

export async function many<T = any>(q: Queryable, text: string, params: unknown[] = []): Promise<T[]> {
  const r = await q.query(text, params);
  return r.rows as T[];
}
