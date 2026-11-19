// crew's own Postgres: a "golden" demo database built from the project's seed scripts, and cheap
// per-ticket copies of it (CREATE DATABASE … TEMPLATE). Workers never see the databases of live apps.
import { sh } from './sysrun.js';
import { shQuote } from './util.js';

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export function ident(name) {
  if (!IDENT.test(name)) throw new Error(`Unsafe database name: ${name}`);
  return name;
}

// Run SQL as crew's admin role. project.db.psql may be "psql" (PG* vars from agent.env)
// or e.g. "docker exec -i crew-pg psql -U postgres" on a dev machine.
export async function sql(project, env, statement, { logFile } = {}) {
  const psql = project.db?.psql || 'psql';
  const cmd = `${psql} -v ON_ERROR_STOP=1 -d postgres -tAc ${shQuote(statement)}`;
  const r = await sh(cmd, { env, logFile, timeoutMs: 10 * 60e3 });
  if (r.code !== 0) throw new Error(`SQL failed (${statement.slice(0, 80)}): ${r.out.trim().slice(-500)}`);
  return r.out.trim();
}

export async function exists(project, env, name) {
  return (await sql(project, env, `SELECT 1 FROM pg_database WHERE datname='${ident(name)}'`)) === '1';
}

export async function dropDb(project, env, name, opts) {
  await sql(project, env, `DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`, opts);
}

export async function cloneDb(project, env, from, to, opts) {
  await dropDb(project, env, to, opts);
  await sql(project, env, `CREATE DATABASE ${ident(to)} TEMPLATE ${ident(from)}`, opts);
}

export async function createEmpty(project, env, name, opts) {
  await dropDb(project, env, name, opts);
  await sql(project, env, `CREATE DATABASE ${ident(name)}`, opts);
}

// Swap a freshly built database into place under the golden name.
export async function promote(project, env, built, golden, opts) {
  await dropDb(project, env, golden, opts);
  await sql(project, env, `ALTER DATABASE ${ident(built)} RENAME TO ${ident(golden)}`, opts);
}
