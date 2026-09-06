import type {
  Extraction,
  ExtractedRange,
  RawAdvisory,
} from "@signalpipe/shared";

export interface Extractor {
  /** Goes into the cache key. Bump it when behaviour changes. See ADR-0001. */
  readonly id: string;
  run(advisory: RawAdvisory): Promise<Extraction>;
}

/**
 * Default extractor. No API key, no network, deterministic.
 *
 * It exists so `docker compose up` works for someone who just cloned this. A
 * pipeline you cannot run without a paid key is a pipeline nobody reviews.
 * It is also the baseline the LLM extractor is measured against.
 */
export class HeuristicExtractor implements Extractor {
  readonly id = "heuristic@2";

  async run(advisory: RawAdvisory): Promise<Extraction> {
    const text = `${advisory.summary}\n${advisory.details}`;
    const ranges: ExtractedRange[] = [];

    // "affected: >=1.2.0, <1.4.5" and the usual prose variants around it.
    const between =
      /(?:>=?|after|from|since)\s*v?(\d+(?:\.\d+)*)[^\d]{0,24}?(?:<|before|prior to|up to|until|fixed in)\s*v?(\d+(?:\.\d+)*)/gi;
    for (const m of text.matchAll(between)) {
      ranges.push({ introduced: m[1], fixed: m[2] });
    }

    if (ranges.length === 0) {
      // "fixed in 1.4.5" / "patched in v2.0.1" with no lower bound stated.
      const fixedOnly =
        /(?:fixed|patched|resolved|remediated)\s+in\s+v?(\d+(?:\.\d+)*)/gi;
      for (const m of text.matchAll(fixedOnly)) {
        ranges.push({ introduced: null, fixed: m[1] });
      }
    }

    return {
      advisoryId: advisory.id,
      ranges: dedupe(ranges),
      extractor: this.id,
      // Deterministic, so it reports full confidence in its own output. That is
      // not a claim of being right — see the accuracy note in the README.
      confidence: ranges.length > 0 ? 1 : 0,
    };
  }
}

/**
 * Optional. Used only when ANTHROPIC_API_KEY is set.
 *
 * This is the non-deterministic, slow, per-call-costed stage the whole pipeline
 * is shaped around: the same input can produce a different answer, so the
 * consumer caches by content hash rather than retrying blindly. See ADR-0001.
 */
export class ClaudeExtractor implements Extractor {
  readonly id = "claude-sonnet@1";

  constructor(
    private readonly apiKey: string,
    private readonly model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
  ) {}

  async run(advisory: RawAdvisory): Promise<Extraction> {
    const prompt = [
      "Extract the affected version ranges from this advisory.",
      'Reply with JSON only: {"ranges":[{"introduced":"1.2.0","fixed":"1.4.5"}],"confidence":0.0}',
      "Use null for an unknown bound. Return an empty array if no version is stated.",
      "",
      `Package: ${advisory.ecosystem}/${advisory.packageName}`,
      `Summary: ${advisory.summary}`,
      `Details: ${advisory.details.slice(0, 4000)}`,
    ].join("\n");

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok)
      throw new Error(
        `anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`,
      );

    const body = (await res.json()) as { content: Array<{ text?: string }> };
    const raw = body.content?.map((c) => c.text ?? "").join("") ?? "";
    const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);

    let parsed: { ranges?: ExtractedRange[]; confidence?: number };
    try {
      parsed = JSON.parse(json);
    } catch {
      // A model that returns prose is a failure of this call, not of the
      // advisory. Let it reach the retry/DLQ path rather than storing nothing.
      throw new Error(`unparseable model output: ${raw.slice(0, 120)}`);
    }

    return {
      advisoryId: advisory.id,
      ranges: dedupe(parsed.ranges ?? []),
      extractor: this.id,
      confidence:
        typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    };
  }
}

function dedupe(ranges: ExtractedRange[]): ExtractedRange[] {
  const seen = new Set<string>();
  return ranges.filter((r) => {
    const k = `${r.introduced ?? "*"}..${r.fixed ?? "*"}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function pickExtractor(): Extractor {
  const key = process.env.ANTHROPIC_API_KEY;
  return key ? new ClaudeExtractor(key) : new HeuristicExtractor();
}
