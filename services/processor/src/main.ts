import {
  TOPIC_ADVISORIES,
  TOPIC_DLQ,
  connectConsumer,
  connectProducer,
  closeAll,
  beat,
  LIVE_FILE,
  READY_FILE,
  migrateWithRetry,
  pool,
  redis,
  type Extraction,
  type RawAdvisory,
} from "@signalpipe/shared";
import { pickExtractor } from "./extract";

const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? 3);
const CACHE_TTL_SECONDS = Number(
  process.env.CACHE_TTL_SECONDS ?? 60 * 60 * 24 * 30,
);

const extractor = pickExtractor();

/**
 * The cache key is (content hash, extractor id). Not the advisory id.
 *
 * Advisory id alone would pin the first answer forever, so a fixed prompt or a
 * better extractor could never take effect. Content hash alone would serve an
 * old extractor's answer to a new one. Both together mean: re-poll of unchanged
 * prose is free, edited prose re-extracts, and bumping the extractor id
 * invalidates exactly what it should. See ADR-0001.
 */
function cacheKey(contentHash: string): string {
  return `extract:${extractor.id}:${contentHash}`;
}

async function extractCached(
  advisory: RawAdvisory,
): Promise<{ result: Extraction; hit: boolean }> {
  const key = cacheKey(advisory.contentHash);

  const cached = await redis.get(key).catch(() => null);
  if (cached) {
    try {
      return { result: JSON.parse(cached) as Extraction, hit: true };
    } catch {
      // A corrupt cache entry must not poison the pipeline. Drop and re-run.
      await redis.del(key).catch(() => undefined);
    }
  }

  const result = await extractor.run(advisory);
  // Cache failures are logged, never fatal: Redis is a copy, not the truth.
  await redis
    .set(key, JSON.stringify(result), "EX", CACHE_TTL_SECONDS)
    .catch(() => undefined);
  return { result, hit: false };
}

async function persist(
  advisory: RawAdvisory,
  extraction: Extraction,
): Promise<void> {
  await pool.query(
    `INSERT INTO advisory
       (id, ecosystem, package_name, summary, details, published, content_hash, extractor, confidence, ranges, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
     ON CONFLICT (id) DO UPDATE SET
       summary = EXCLUDED.summary,
       details = EXCLUDED.details,
       content_hash = EXCLUDED.content_hash,
       extractor = EXCLUDED.extractor,
       confidence = EXCLUDED.confidence,
       ranges = EXCLUDED.ranges,
       updated_at = now()`,
    [
      advisory.id,
      advisory.ecosystem,
      advisory.packageName,
      advisory.summary,
      advisory.details,
      advisory.published || null,
      advisory.contentHash,
      extraction.extractor,
      extraction.confidence,
      JSON.stringify(extraction.ranges),
    ],
  );
}

async function main(): Promise<void> {
  // Beat before anything that can block. Connecting to the broker on a cold
  // cluster can take longer than the liveness threshold, and a process that is
  // patiently retrying is not a process that needs killing.
  beat(LIVE_FILE);
  await migrateWithRetry();
  const consumer = await connectConsumer("processor", "processor-v1");
  const dlq = await connectProducer("processor-dlq");
  await consumer.subscribe({ topic: TOPIC_ADVISORIES, fromBeginning: true });

  // Liveness is "still fetching from the broker", not "process exists". FETCH
  // fires on every fetch cycle including empty ones, so an idle consumer still
  // beats, while one wedged in a rebalance loop or holding a dead broker
  // connection goes quiet — which is the failure worth restarting for.
  beat(LIVE_FILE);
  consumer.on(consumer.events.FETCH, () => beat(LIVE_FILE));
  consumer.on(consumer.events.GROUP_JOIN, () => {
    beat(LIVE_FILE);
    beat(READY_FILE);
  });

  let done = 0;
  let hits = 0;

  console.log(
    `[processor] extractor=${extractor.id} maxAttempts=${MAX_ATTEMPTS}`,
  );

  // SIGTERM stops the runner and waits for the in-flight handler. A message
  // that was mid-extraction when the pod went away is re-delivered to whoever
  // picks up the partition, which is safe precisely because of the content-hash
  // cache in ADR-0001 — the redelivery is a cache hit, not a second API call.
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[processor] ${signal}: disconnecting`);
    setTimeout(() => process.exit(0), 25_000).unref();
    await consumer.disconnect().catch(() => undefined);
    await dlq.disconnect().catch(() => undefined);
    await closeAll();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await consumer.run({
    // One message at a time. The extractor is the bottleneck, so there is
    // nothing to gain from batching, and lag is the backpressure signal we
    // actually want to read. See ADR-0002.
    eachMessage: async ({ message }) => {
      const advisory = JSON.parse(message.value!.toString()) as RawAdvisory;
      const attempts = Number(message.headers?.attempts?.toString() ?? "1");

      try {
        const { result, hit } = await extractCached(advisory);
        await persist(advisory, result);
        done += 1;
        if (hit) hits += 1;
        if (done % 10 === 0) {
          console.log(`[processor] processed=${done} cacheHits=${hits}`);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);

        if (attempts >= MAX_ATTEMPTS) {
          // Out of retries. Park it with the reason and the payload so it can
          // be replayed after a fix, and keep the pipeline moving.
          await pool.query(
            `INSERT INTO dead_letter (advisory_id, reason, attempts, payload) VALUES ($1,$2,$3,$4)`,
            [advisory.id, reason, attempts, JSON.stringify(advisory)],
          );
          await dlq.send({
            topic: TOPIC_DLQ,
            messages: [
              {
                key: advisory.id,
                value: JSON.stringify({ advisory, reason, attempts }),
              },
            ],
          });
          console.error(
            `[processor] dlq id=${advisory.id} attempts=${attempts} reason=${reason}`,
          );
          return;
        }

        // Re-publish with the attempt count incremented rather than throwing.
        // Throwing here stalls the partition on one bad message, which is the
        // failure mode that takes a pipeline down at 3am.
        await dlq.send({
          topic: TOPIC_ADVISORIES,
          messages: [
            {
              key: message.key ?? advisory.id,
              value: message.value!,
              headers: { attempts: String(attempts + 1) },
            },
          ],
        });
        console.warn(
          `[processor] retry id=${advisory.id} attempt=${attempts + 1} reason=${reason}`,
        );
      }
    },
  });
}

main().catch((err) => {
  console.error("[processor] fatal", err);
  process.exit(1);
});
