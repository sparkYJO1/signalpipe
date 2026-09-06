import "reflect-metadata";
import { Body, Controller, Get, Module, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { migrate, pool, redis, type ExtractedRange } from "@signalpipe/shared";

interface Dependency {
  ecosystem: string;
  name: string;
  version: string;
}

interface Match {
  advisoryId: string;
  ecosystem: string;
  packageName: string;
  installed: string;
  summary: string;
  ranges: ExtractedRange[];
  confidence: number;
  extractor: string;
}

/** Numeric-segment compare. Enough for the semver-shaped versions OSV carries. */
function cmp(a: string, b: string): number {
  const pa = a.split(/[.\-+]/);
  const pb = b.split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number(pa[i] ?? 0);
    const y = Number(pb[i] ?? 0);
    if (Number.isNaN(x) || Number.isNaN(y)) return a.localeCompare(b);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function affected(installed: string, r: ExtractedRange): boolean {
  if (r.introduced && cmp(installed, r.introduced) < 0) return false;
  if (r.fixed && cmp(installed, r.fixed) >= 0) return false;
  return Boolean(r.introduced || r.fixed);
}

@Controller()
class AppController {
  @Get("/health")
  async health() {
    const db = await pool
      .query("SELECT count(*)::int AS n FROM advisory")
      .then((r) => r.rows[0].n as number)
      .catch(() => -1);
    const dlq = await pool
      .query("SELECT count(*)::int AS n FROM dead_letter")
      .then((r) => r.rows[0].n as number)
      .catch(() => -1);
    const cache = await redis
      .ping()
      .then(() => "up")
      .catch(() => "down");
    return { ok: db >= 0, advisories: db, deadLetters: dlq, cache };
  }

  @Get("/advisories")
  async list() {
    const { rows } = await pool.query(
      `SELECT id, ecosystem, package_name, summary, ranges, confidence, extractor
         FROM advisory ORDER BY updated_at DESC LIMIT 50`,
    );
    return rows;
  }

  /**
   * The question this whole pipeline exists to answer: given what I have
   * installed, which advisories actually apply to me.
   */
  @Post("/check")
  async check(
    @Body() body: { dependencies?: Dependency[] },
  ): Promise<{ matches: Match[] }> {
    const deps = body?.dependencies ?? [];
    if (deps.length === 0) return { matches: [] };

    // Two parallel arrays joined through unnest. Postgres will not bind an
    // anonymous composite array, so `(ecosystem, name) = ANY($1::record[])`
    // fails at runtime rather than at parse time — worth the comment.
    const { rows } = await pool.query(
      `SELECT a.id, a.ecosystem, a.package_name, a.summary, a.ranges, a.confidence, a.extractor
         FROM advisory a
         JOIN unnest($1::text[], $2::text[]) AS d(ecosystem, name)
           ON a.ecosystem = d.ecosystem AND a.package_name = d.name`,
      [deps.map((d) => d.ecosystem), deps.map((d) => d.name)],
    );

    const matches: Match[] = [];
    for (const dep of deps) {
      for (const row of rows) {
        if (row.ecosystem !== dep.ecosystem || row.package_name !== dep.name)
          continue;
        const ranges = row.ranges as ExtractedRange[];
        if (ranges.some((r) => affected(dep.version, r))) {
          matches.push({
            advisoryId: row.id,
            ecosystem: row.ecosystem,
            packageName: row.package_name,
            installed: dep.version,
            summary: row.summary,
            ranges,
            confidence: row.confidence,
            extractor: row.extractor,
          });
        }
      }
    }
    return { matches };
  }
}

@Module({ controllers: [AppController] })
class AppModule {}

async function bootstrap(): Promise<void> {
  await migrate();
  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn", "log"],
  });
  await app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
  console.log(`[api] listening on ${process.env.PORT ?? 3000}`);
}

bootstrap().catch((err) => {
  console.error("[api] fatal", err);
  process.exit(1);
});
