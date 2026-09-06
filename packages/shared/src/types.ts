/** One advisory as it arrives from OSV, before extraction. */
export interface RawAdvisory {
  id: string; // GHSA-xxxx / CVE-2024-1234
  ecosystem: string; // npm, PyPI, Go, ...
  packageName: string;
  summary: string;
  details: string;
  published: string;
  /** Stable hash of the fields extraction depends on. See ADR-0001. */
  contentHash: string;
}

/** What the extraction step produces. */
export interface ExtractedRange {
  introduced: string | null; // null means "from the beginning"
  fixed: string | null; // null means "no fix published"
}

export interface Extraction {
  advisoryId: string;
  ranges: ExtractedRange[];
  /** Which extractor produced this, and at which version. Part of the cache key. */
  extractor: string;
  confidence: number; // 0..1
}

export interface DeadLetter {
  advisoryId: string;
  reason: string;
  attempts: number;
  payload: unknown;
  failedAt: string;
}

export const TOPIC_ADVISORIES = "advisories";
export const TOPIC_DLQ = "advisories.dlq";
