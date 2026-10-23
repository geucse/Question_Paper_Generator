import { pathToFileURL } from 'node:url';
import path from 'node:path';
const MOCK = pathToFileURL(path.resolve(import.meta.dirname, 'mock-db.mjs')).href;
export async function resolve(specifier, context, next) {
  const r = await next(specifier, context);
  if (/\/src\/db\.js$/.test(r.url)) return { ...r, url: MOCK, shortCircuit: true };
  return r;
}
