import {
  TOPIC_ADVISORIES,
  connectProducer,
  contentHash,
  partitionKey,
  type RawAdvisory,
} from "@signalpipe/shared";
import { readFile } from "node:fs/promises";

const POLL_SECONDS = Number(process.env.POLL_SECONDS ?? 300);
const ECOSYSTEMS = (process.env.ECOSYSTEMS ?? "npm").split(",");
const PACKAGES = (
  process.env.PACKAGES ?? "lodash,express,axios,minimist,tar"
).split(",");
const OFFLINE_FIXTURE = process.env.OFFLINE_FIXTURE;

interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  published?: string;
}

/**
 * Queries OSV per package. OSV has a bulk endpoint, but per-package keeps the
 * request shape identical to the offline fixture, so the pipeline is exercised
 * the same way whether or not the network is there.
 */
async function fetchOsv(ecosystem: string, name: string): Promise<OsvVuln[]> {
  const res = await fetch("https://api.osv.dev/v1/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ package: { ecosystem, name } }),
  });
  if (!res.ok) throw new Error(`osv ${res.status} for ${ecosystem}/${name}`);
  const body = (await res.json()) as { vulns?: OsvVuln[] };
  return body.vulns ?? [];
}

async function fetchFixture(): Promise<
  Array<{ ecosystem: string; name: string; vulns: OsvVuln[] }>
> {
  return JSON.parse(await readFile(OFFLINE_FIXTURE!, "utf8"));
}

function toRaw(
  ecosystem: string,
  packageName: string,
  v: OsvVuln,
): RawAdvisory {
  const summary = v.summary ?? "";
  const details = v.details ?? "";
  return {
    id: v.id,
    ecosystem,
    packageName,
    summary,
    details,
    published: v.published ?? "",
    contentHash: contentHash({ summary, details, packageName, ecosystem }),
  };
}

async function main(): Promise<void> {
  const producer = await connectProducer("ingester");
  console.log(
    `[ingester] mode=${OFFLINE_FIXTURE ? "fixture" : "osv"} poll=${POLL_SECONDS}s packages=${PACKAGES.length}`,
  );

  const publish = async (advisories: RawAdvisory[]) => {
    if (advisories.length === 0) return;
    await producer.send({
      topic: TOPIC_ADVISORIES,
      messages: advisories.map((a) => ({
        key: partitionKey(a.ecosystem, a.packageName),
        value: JSON.stringify(a),
        headers: { attempts: "1" },
      })),
    });
    console.log(`[ingester] published=${advisories.length}`);
  };

  const tick = async () => {
    try {
      if (OFFLINE_FIXTURE) {
        const groups = await fetchFixture();
        for (const g of groups) {
          await publish(g.vulns.map((v) => toRaw(g.ecosystem, g.name, v)));
        }
        return;
      }
      for (const ecosystem of ECOSYSTEMS) {
        for (const name of PACKAGES) {
          const vulns = await fetchOsv(ecosystem, name.trim());
          await publish(vulns.map((v) => toRaw(ecosystem, name.trim(), v)));
        }
      }
    } catch (err) {
      // A failed poll is not fatal. The next tick retries; OSV being down must
      // not take the ingester with it.
      console.error(
        "[ingester] poll failed:",
        err instanceof Error ? err.message : err,
      );
    }
  };

  await tick();
  // The ingester does not throttle itself when the processor falls behind.
  // Consumer lag is the backpressure signal, and it is deliberately allowed to
  // grow rather than being hidden by slowing the producer. See ADR-0002.
  setInterval(tick, POLL_SECONDS * 1000);
}

main().catch((err) => {
  console.error("[ingester] fatal", err);
  process.exit(1);
});
