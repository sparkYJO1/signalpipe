import "reflect-metadata";
import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Module,
  Post,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  closeAll,
  migrateWithRetry,
  pool,
  redis,
  type ExtractedRange,
} from "@signalpipe/shared";

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

/**
 * Process lifecycle, as the orchestrator sees it.
 *
 * `migrated` flips when the schema is in place. `draining` flips on SIGTERM.
 * They are separate because liveness and readiness answer different questions:
 * "is this process wedged" versus "should traffic come here right now".
 * See ADR-0006.
 */
const state = { migrated: false, draining: false };

/** The slice of the Express response this file actually touches. */
interface SetHeader {
  setHeader(name: string, value: string): void;
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
  /**
   * Liveness. Deliberately touches nothing but this process.
   *
   * If this checked Postgres, a database blip would fail liveness on every
   * replica at once and the kubelet would restart all of them — turning a
   * recoverable dependency outage into a self-inflicted outage. A dependency
   * being down is a readiness fact, not a liveness fact.
   */
  @Get("/live")
  live() {
    return { ok: true, pid: process.pid, uptime: Math.round(process.uptime()) };
  }

  /**
   * Readiness. 503 while draining, and 503 if the dependencies this process
   * needs to answer a request are unreachable.
   */
  @Get("/ready")
  async ready() {
    if (state.draining || !state.migrated) {
      throw new HttpException(
        { ok: false, reason: state.draining ? "draining" : "migrating" },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const db = await pool
      .query("SELECT 1")
      .then(() => true)
      .catch(() => false);
    if (!db) {
      throw new HttpException(
        { ok: false, reason: "database" },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return { ok: true };
  }

  /** Human-facing summary. Not wired to any probe — see /live and /ready. */
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

/**
 * Time between SIGTERM and the listening socket closing.
 *
 * This is not politeness. A pod is removed from Service endpoints and the
 * process is sent SIGTERM by two independent controllers, in no guaranteed
 * order, and kube-proxy/ingress take time to act on the removal. Closing the
 * socket the instant SIGTERM lands races that propagation and drops requests.
 * See ADR-0006 for the measurement.
 */
const DRAIN_MS = Number(process.env.SHUTDOWN_DRAIN_MS ?? 5000);
const HARD_EXIT_MS = Number(process.env.SHUTDOWN_HARD_EXIT_MS ?? 20000);

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn", "log"],
  });

  // While draining, every response carries `Connection: close`. Without this a
  // client with keep-alive holds an idle socket to a pod that is about to
  // disappear and sends its next request into a closing connection. The header
  // makes the client retire the socket after a response it already has.
  app.use((_req: unknown, res: SetHeader, next: () => void) => {
    if (state.draining) res.setHeader("Connection", "close");
    next();
  });

  await app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");

  const server = app.getHttpServer();
  // Longer than the usual 5s so a client's idle keep-alive socket is not closed
  // out from under an in-flight request; shorter than any sane LB idle timeout.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  console.log(`[api] listening on ${process.env.PORT ?? 3000}`);

  // Migrations run *after* the port is open, not before.
  //
  // Blocking the listener on Postgres makes the startup probe blind: the
  // kubelet gets connection-refused and cannot tell "still waiting for the
  // database" from "crashed", so when the startup budget runs out it kills a
  // container that was working correctly. Measured on a cold k3d cluster: a 60s
  // startup budget restarted every API pod once, while the logs showed this
  // process retrying the migration with backoff the whole time. Opening the
  // port first turns the same wait into a readiness 503 with a reason attached,
  // which is a fact the kubelet can act on and a human can read. See ADR-0006.
  migrateWithRetry()
    .then(() => {
      state.migrated = true;
      console.log("[api] schema ready");
    })
    .catch((err) => {
      console.error("[api] migrations gave up", err);
      process.exit(1);
    });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    state.draining = true;
    console.log(`[api] ${signal}: draining for ${DRAIN_MS}ms`);

    // Backstop. If a socket refuses to drain we still exit inside the
    // termination grace period rather than being SIGKILLed mid-request.
    const hard = setTimeout(() => {
      console.warn("[api] drain did not finish, exiting anyway");
      process.exit(0);
    }, HARD_EXIT_MS);
    hard.unref();

    await new Promise((r) => setTimeout(r, DRAIN_MS));

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Sockets sitting idle between keep-alive requests would otherwise hold
      // the close open for keepAliveTimeout.
      server.closeIdleConnections?.();
    });
    console.log("[api] http server closed");

    await app.close().catch(() => undefined);
    await closeAll();
    console.log("[api] bye");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

bootstrap().catch((err) => {
  console.error("[api] fatal", err);
  process.exit(1);
});
