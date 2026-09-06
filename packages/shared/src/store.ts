import { Pool } from "pg";
import Redis from "ioredis";

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://postgres:postgres@postgres:5432/signalpipe",
  max: 8,
});

export const redis = new Redis(process.env.REDIS_URL ?? "redis://redis:6379", {
  maxRetriesPerRequest: null,
});

/**
 * Postgres is the source of truth; Redis only ever holds a copy. See ADR-0003.
 * Losing Redis costs money and latency because extraction re-runs. It never
 * costs correctness, and that is the whole reason the split is drawn here.
 */
export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS advisory (
      id            TEXT PRIMARY KEY,
      ecosystem     TEXT NOT NULL,
      package_name  TEXT NOT NULL,
      summary       TEXT NOT NULL,
      details       TEXT NOT NULL,
      published     TIMESTAMPTZ,
      content_hash  TEXT NOT NULL,
      extractor     TEXT,
      confidence    REAL,
      ranges        JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS advisory_pkg_idx ON advisory (ecosystem, package_name);
    CREATE TABLE IF NOT EXISTS dead_letter (
      advisory_id TEXT NOT NULL,
      reason      TEXT NOT NULL,
      attempts    INT  NOT NULL,
      payload     JSONB,
      failed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

/**
 * Postgres will not be reachable the moment a pod starts.
 *
 * Compose had `depends_on: condition: service_healthy`. Kubernetes has no
 * equivalent, and the honest answer is not an initContainer that waits — it is
 * that a service must tolerate its dependencies arriving late.
 *
 * There is no deadline by default, and that is deliberate. Deciding when to
 * give up on a slow dependency is the orchestrator's job: the startup probe
 * already owns that decision and has a budget set alongside it. An independent
 * timeout in here is a second clock governing the same thing, and whichever one
 * is shorter silently wins — which is exactly what happened with a 60s default
 * against a 180s startup budget. See ADR-0006.
 *
 * Set MIGRATE_TIMEOUT_MS to reintroduce a deadline where nothing else owns one.
 */
export async function migrateWithRetry(): Promise<void> {
  const budget = Number(process.env.MIGRATE_TIMEOUT_MS ?? 0);
  const deadline = budget > 0 ? Date.now() + budget : Infinity;
  let lastErr: unknown;
  for (let attempt = 1; Date.now() < deadline; attempt++) {
    try {
      await migrate();
      return;
    } catch (err) {
      lastErr = err;
      const wait = Math.min(5000, 250 * 2 ** attempt);
      console.warn(
        `[store] migrate attempt ${attempt} failed (${err instanceof Error ? err.message : err}), retrying in ${wait}ms`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

export async function closeAll(): Promise<void> {
  await pool.end().catch(() => undefined);
  redis.disconnect();
}
