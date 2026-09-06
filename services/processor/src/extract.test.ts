import { describe, expect, it } from "vitest";
import { HeuristicExtractor } from "./extract";
import { contentHash } from "@signalpipe/shared";

const extractor = new HeuristicExtractor();

function advisory(
  details: string,
  over: Partial<Parameters<typeof contentHash>[0]> = {},
) {
  const base = {
    summary: "",
    details,
    packageName: "pkg",
    ecosystem: "npm",
    ...over,
  };
  return {
    id: "TEST-1",
    ecosystem: base.ecosystem,
    packageName: base.packageName,
    summary: base.summary,
    details: base.details,
    published: "",
    contentHash: contentHash(base),
  };
}

describe("HeuristicExtractor", () => {
  it("reads a bounded range written as an inequality", async () => {
    const r = await extractor.run(advisory("affected: >=1.0.0, <1.2.6"));
    expect(r.ranges).toEqual([{ introduced: "1.0.0", fixed: "1.2.6" }]);
  });

  it("reads the same range written as prose", async () => {
    const r = await extractor.run(
      advisory("Versions from 0.0.1 up to 0.2.1 are affected."),
    );
    expect(r.ranges).toEqual([{ introduced: "0.0.1", fixed: "0.2.1" }]);
  });

  it("falls back to a fix-only range when no lower bound is stated", async () => {
    const r = await extractor.run(advisory("This is fixed in 1.6.0."));
    expect(r.ranges).toEqual([{ introduced: null, fixed: "1.6.0" }]);
  });

  it("returns nothing rather than guessing when no version appears", async () => {
    const r = await extractor.run(
      advisory("No versions are stated anywhere in this text."),
    );
    expect(r.ranges).toEqual([]);
    // Zero ranges is a valid answer, not an error. The processor stores it and
    // does not dead-letter it — that distinction is the point of this case.
    expect(r.confidence).toBe(0);
  });

  it("does not emit the same range twice", async () => {
    const r = await extractor.run(
      advisory(">=1.0.0, <2.0.0 is affected. Again: from 1.0.0 before 2.0.0."),
    );
    expect(r.ranges).toHaveLength(1);
  });
});

describe("contentHash", () => {
  it("ignores whitespace differences so a re-publish does not re-extract", () => {
    const a = contentHash({
      summary: "x",
      details: "a  b\n c",
      packageName: "p",
      ecosystem: "npm",
    });
    const b = contentHash({
      summary: "x",
      details: "a b c",
      packageName: "p",
      ecosystem: "npm",
    });
    expect(a).toBe(b);
  });

  it("changes when the prose changes, so edited advisories do re-extract", () => {
    const a = contentHash({
      summary: "x",
      details: "fixed in 1.0",
      packageName: "p",
      ecosystem: "npm",
    });
    const b = contentHash({
      summary: "x",
      details: "fixed in 1.1",
      packageName: "p",
      ecosystem: "npm",
    });
    expect(a).not.toBe(b);
  });

  it("separates identically-worded advisories for different packages", () => {
    const a = contentHash({
      summary: "s",
      details: "d",
      packageName: "one",
      ecosystem: "npm",
    });
    const b = contentHash({
      summary: "s",
      details: "d",
      packageName: "two",
      ecosystem: "npm",
    });
    expect(a).not.toBe(b);
  });
});
