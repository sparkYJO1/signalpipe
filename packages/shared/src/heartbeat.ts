import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A liveness heartbeat for a process with no HTTP surface.
 *
 * The ingester and the processor serve no traffic, so `httpGet` probes would
 * mean standing up a web server whose only job is to answer "the web server is
 * up" — which is true even when the consumer has silently stopped fetching.
 * Instead each writes a unix timestamp to a file on the beat that actually
 * matters (a broker fetch, a completed poll), and the probe asserts that file
 * is recent. That fails when the loop wedges, which is the failure this is for.
 *
 * A write failure is swallowed on purpose: a full or read-only filesystem would
 * otherwise turn a warning into a crash loop.
 */
export function beat(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${Math.floor(Date.now() / 1000)}\n`);
  } catch {
    /* ignored */
  }
}

export const LIVE_FILE = process.env.HEARTBEAT_LIVE ?? "/tmp/health/live";
export const READY_FILE = process.env.HEARTBEAT_READY ?? "/tmp/health/ready";
