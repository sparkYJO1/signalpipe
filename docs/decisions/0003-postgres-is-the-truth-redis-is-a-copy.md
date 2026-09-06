# ADR-0003 — Postgres is the truth, Redis is a copy

## Problem

Two stores. Which one is authoritative, and what breaks when the other is gone?

## Decision

Postgres holds advisories and extraction results and is the only thing the API
reads. Redis holds the extraction cache and nothing else.

Every Redis operation in the processor is written so that failure is
non-fatal — a failed `get` falls through to extraction, a failed `set` is
ignored, and a corrupt entry is deleted and re-run.

## Rejected

**Serve reads from Redis for speed.** Nothing here is read-heavy enough to
justify it, and it would turn a cache outage from a cost problem into an
availability problem. Not paying for a second consistency story.

## Consequence

Losing Redis costs money and latency: every advisory re-extracts. It never
costs correctness, and the API keeps answering.

The test of whether this line is drawn correctly is being able to say, in one
sentence, what a Redis outage does. Here it is: the pipeline gets slower and
more expensive, and nothing wrong is served.
