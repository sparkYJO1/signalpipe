# ADR-0005 — Retry in band, then park

## Problem

Extraction fails for two different reasons that look the same at the call site:
transient (rate limit, timeout, a model returning prose instead of JSON) and
permanent (an advisory that will never parse). A single strategy cannot serve
both.

## Decision

On failure, re-publish the message to its own topic with an incremented
`attempts` header. After `MAX_ATTEMPTS`, write it to `dead_letter` in Postgres
with the reason and the payload, and publish to `advisories.dlq`.

Crucially, the handler does **not** throw.

## Rejected

**Throw and let the consumer retry.** This is the default and it is the failure
mode that takes pipelines down: throwing blocks the partition, so one
permanently-bad message stops every message behind it. Fine at noon, expensive
at 3am.

**Retry with in-process backoff.** Holds the partition for the duration and
converts a slow failure into a stalled consumer.

## Consequence

Failures cost throughput, never progress. A bad message is visible in one
`SELECT` with the reason attached and the payload kept, so it can be replayed
after a fix.

The trade is ordering: a retried message returns to the back of its partition,
so it can be processed after a message that arrived later. For this workload
that is acceptable — the retry path is rare and advisories for the same package
are minutes apart, not milliseconds. If that stopped being true, this decision
would need revisiting before ADR-0004 would.
