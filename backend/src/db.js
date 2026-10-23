import pg from 'pg';

// APP_DATABASE_URL points at a restricted, least-privilege role
// (see backend/deploy/create-app-role.sql — spec section 75.5) that can
// only read/write rows, never run DDL. Falls back to DATABASE_URL (the
// schema-owning role migrations use) when unset, so this is purely
// opt-in hardening — nothing breaks for a local/dev setup that hasn't
// created the separate role.
const connectionString = process.env.APP_DATABASE_URL || process.env.DATABASE_URL;

// Single shared connection pool for the whole process. Every route imports
// `pool` (or the convenience helpers below) rather than opening its own
// connections — pg's Pool already handles concurrency safely.
export const pool = new pg.Pool({
  connectionString,
  max: Number(process.env.PG_POOL_MAX || 10),
});

pool.on('error', (err) => {
  // A background/idle client emitting an error should never crash the
  // whole process — log it and let the pool recover the connection.
  console.error('Unexpected Postgres pool error:', err.message);
});

// Thin convenience wrappers so route code reads close to the old
// better-sqlite3 style (.get / .all / .run) while actually being async
// and using $1,$2... parameterized queries under the hood.
export async function get(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows[0] || null;
}

export async function all(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows;
}

// Alias used by authorization.js; returns rows.
export async function query(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows;
}

export async function run(text, params = []) {
  const result = await pool.query(text, params);
  return { rowCount: result.rowCount, rows: result.rows };
}

// Runs `fn` inside a single transaction using a dedicated client from the
// pool. `fn` receives an object with the same get/all/run shape, bound to
// that client, so nested queries participate in the same transaction.
export async function withTransaction(fn) {
  const client = await pool.connect();
  const txn = {
    get: async (text, params = []) => (await client.query(text, params)).rows[0] || null,
    all: async (text, params = []) => (await client.query(text, params)).rows,
    run: async (text, params = []) => {
      const r = await client.query(text, params);
      return { rowCount: r.rowCount, rows: r.rows };
    },
  };
  try {
    await client.query('BEGIN');
    const result = await fn(txn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export default { pool, get, all, run, query, withTransaction };
