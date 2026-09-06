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

export async function closeAll(): Promise<void> {
  await pool.end().catch(() => undefined);
  redis.disconnect();
}
