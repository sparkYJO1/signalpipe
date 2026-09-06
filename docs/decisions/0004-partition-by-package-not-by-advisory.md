# ADR-0004 — Partition by package, not by advisory

## Problem

Kafka and Redpanda guarantee ordering within a partition, not across
partitions. The key choice decides both what stays ordered and how evenly load
spreads. It is also painful to change later, because changing it re-shuffles
which partition every future key lands on.

## Decision

Key on `{ecosystem}/{packageName}`.

Two advisories for the same package must be processed in order: a later one can
supersede an earlier one, and applying them out of order leaves the wrong
result in Postgres. Package is the smallest unit where that is true.

## Rejected

**Key on advisory id.** Distributes almost perfectly — every advisory is its own
key — and loses the one ordering guarantee that matters. Perfect balance of the
wrong thing.

**Key on ecosystem.** Ordering is safe but `npm` becomes a single hot partition
carrying most of the traffic, and the consumer group can never scale past it.

## Consequence

Accepted risk: a package with an unusual number of advisories makes a hot
partition. For this corpus that is not a real concern; at a scale where it is,
the fix is a composite key with a bucket suffix and the ordering guarantee then
weakens to per-bucket.

Worth stating plainly: this is the decision I would most expect to be
challenged on, and the honest answer is that it trades measurable balance for a
correctness property.
