import { createHash } from "node:crypto";

/**
 * The content hash is the idempotency key for a non-deterministic step.
 *
 * It covers only the fields the extractor actually reads. `published` and the
 * rest of OSV's bookkeeping are excluded on purpose: an advisory re-published
 * with no change to its prose must hash the same, or every re-poll pays for an
 * extraction that cannot produce a different answer.
 */
export function contentHash(parts: {
  summary: string;
  details: string;
  packageName: string;
  ecosystem: string;
}): string {
  const canonical = [
    parts.ecosystem,
    parts.packageName,
    parts.summary,
    parts.details,
  ]
    .map((s) => s.normalize("NFC").trim().replace(/\s+/g, " "))
    .join(" ");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}
