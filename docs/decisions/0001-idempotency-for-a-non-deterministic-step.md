# ADR-0001 — Idempotency for a non-deterministic step

## Problem

The extraction stage can return a different answer for the same input, costs
money per call, and is the slowest thing in the pipeline. At-least-once
delivery means it *will* see the same message twice. Naive retry pays twice and
can store two different answers for one advisory.

## Decision

Cache extraction results in Redis under `extract:{extractorId}:{contentHash}`.

Both halves of the key are load-bearing:

- **Advisory id alone** would pin the first answer forever. A fixed prompt or a
  better extractor could never take effect, which quietly makes the system
  unimprovable.
- **Content hash alone** would serve one extractor's answer to a different
  extractor. Bumping the extractor would appear to do nothing.

Together: a re-poll of unchanged prose is free, edited prose re-extracts, and
bumping `extractor.id` invalidates exactly the entries it should.

The content hash covers only the fields extraction reads — ecosystem, package,
summary, details — normalised for whitespace. `published` and OSV's bookkeeping
are excluded on purpose. An advisory re-published with no change to its prose
must hash the same, or every poll pays for a call that cannot produce a
different answer.

## Rejected

**Store the extraction in Postgres and skip Redis.** Correct, and it was the
agent's first proposal. Rejected because the cache has to be keyed by content
hash rather than by advisory id, so it is not the same row as the advisory —
it is a separate keyspace with its own TTL, and Redis is the better shape for
that. Postgres still holds the result; Redis holds the *derivation*.

**Make the model deterministic with `temperature: 0`.** Reduces variance, does
not remove it, and does nothing about cost or latency. Designing as if it were
deterministic is the trap.

## Consequence

Duplicates within the TTL are free. Duplicates after it re-extract and pay
again — accepted, because the alternative is unbounded cache growth. The cost
of a wrong guess here is money, not correctness, which is the right thing to be
wrong about.
