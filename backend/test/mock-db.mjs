// Scripted fake of src/db.js for route-level tests that need no Postgres.
// Tests register rules: sql(/regex/, (params, text) => rows). Unmatched SQL throws, so every query a handler issues is visible.
const rules = [];
export const log = [];
export function sql(re, fn) { rules.unshift([re, typeof fn === 'function' ? fn : () => fn]); }
export function resetRules() { rules.length = 0; log.length = 0; }
async function exec(text, params = []) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(t)) return { rows: [], rowCount: 0 };
  log.push({ text: t, params });
  for (const [re, fn] of rules) {
    if (re.test(t)) { const rows = fn(params, t) || []; return { rows, rowCount: rows.length }; }
  }
  throw new Error('UNSCRIPTED SQL: ' + t.slice(0, 200));
}
export const pool = { query: exec, on() {}, end: async () => {}, connect: async () => ({ query: exec, release() {} }) };
export async function get(t, p = []) { return (await exec(t, p)).rows[0] || null; }
export async function all(t, p = []) { return (await exec(t, p)).rows; }
export async function query(t, p = []) { return (await exec(t, p)).rows; }
export async function run(t, p = []) { const r = await exec(t, p); return { rowCount: r.rowCount, rows: r.rows }; }
export async function withTransaction(fn) {
  const txn = { get, all, run };
  return fn(txn);
}
export default { pool, get, all, run, query, withTransaction };
