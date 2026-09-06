# signalpipe

An ingest pipeline with a **slow, expensive, non-deterministic consumer** in the
middle of it.

It pulls security advisories, extracts affected version ranges from their prose,
and answers one question: *given what I have installed, which advisories
actually apply to me?*

The extraction step is the point. It is the stage that costs money per call,
takes far longer than everything around it, and can return a different answer
for the same input. Most of the design here exists because of that one property.

```bash
docker compose up --build     # no API key needed
curl localhost:3900/health
```

## What it does

```
OSV advisories ──▶ ingester ──▶ Redpanda ──▶ processor ──▶ Postgres
                                    │            │            ▲
                                    │            ├──▶ Redis ──┘  (extraction cache)
                                    └── DLQ ◀────┘  (after 3 attempts)
                                                              │
                                            api ──────────────┘
```

Verified on a clean `docker compose up`:

```
$ curl localhost:3900/health
{"ok":true,"advisories":6,"deadLetters":0,"cache":"up"}

$ curl -X POST localhost:3900/check -d '{"dependencies":[
    {"ecosystem":"npm","name":"lodash","version":"4.17.20"},
    {"ecosystem":"npm","name":"minimist","version":"1.2.5"},
    {"ecosystem":"npm","name":"tar","version":"6.2.0"}]}'

  lodash    4.17.20  → GHSA-p6mc-m468-83gg   affected [4.0.0 .. 4.17.21)
  minimist  1.2.5    → GHSA-xvch-5gv4-984h   affected [1.0.0 .. 1.2.6)
  tar       6.2.0    → no match (fixed in 6.1.9)
```

## It runs with no API key

The default extractor is a deterministic heuristic — no network, no key, no
cost. A pipeline you cannot run without a paid credential is a pipeline nobody
reviews.

Set `ANTHROPIC_API_KEY` and the same interface swaps to Claude. The heuristic
then becomes the baseline the model is measured against, which is more useful
than either alone.

## The decisions worth arguing about

Each of these is a page in [`docs/decisions/`](docs/decisions/). They are the
parts where a different engineer could reasonably have chosen otherwise.

| | |
|---|---|
| [ADR-0001](docs/decisions/0001-idempotency-for-a-non-deterministic-step.md) | Making a non-deterministic step idempotent. The cache key is `(content hash, extractor id)` and both halves are load-bearing |
| [ADR-0002](docs/decisions/0002-backpressure-belongs-in-the-log.md) | Backpressure lives in consumer lag. The ingester does not throttle itself, on purpose |
| [ADR-0003](docs/decisions/0003-postgres-is-the-truth-redis-is-a-copy.md) | Losing Redis costs money and latency, never correctness |
| [ADR-0004](docs/decisions/0004-partition-by-package-not-by-advisory.md) | Partitioning by package accepts a hot-partition risk to keep per-package ordering |
| [ADR-0005](docs/decisions/0005-retry-in-band-then-park.md) | Retries re-publish with a counter instead of throwing, so one bad message cannot stall a partition |

[`docs/plan.md`](docs/plan.md) is the plan this was built from, including what
was deliberately cut.

## Deliberately not here

Kubernetes and Helm. Zero-downtime deploy verification. Multi-tenancy. Auth. A
frontend. Autoscaling. Terraform. A service mesh. A configurable rule engine.

The Kubernetes layer is the obvious next step and is **not** claimed as done —
this is Docker Compose and says so. Adding a rolling-deploy probe that measures
5xx and p99 across a release is the intended follow-up, because "zero-downtime"
should be a number that updates on every deploy rather than an adjective.

## Accuracy is not claimed

The heuristic extractor reads five prose patterns. It gets the fixture right
and will miss real advisories written differently. That is why extraction
carries a `confidence` and why zero ranges is stored as a valid answer rather
than an error — an advisory that states no versions is not a failure, and the
pipeline distinguishes the two. Measuring extraction accuracy against a labelled
set is future work, and until it exists no accuracy claim is made.

## Layout

```
packages/shared     types, content hash, bus and store wiring
services/ingester   polls OSV (or a fixture), publishes to Redpanda
services/processor  consumes, extracts, caches, persists, dead-letters
services/api        NestJS read API — /health, /advisories, /check
ops/fixture.json    offline advisories, including one with no versions at all
```

`npm test` runs the extractor and content-hash tests without Docker.

## Built with Claude

This repository was built with Claude as the implementer, with me directing the
design and reviewing every decision. That is how I work day to day, so hiding it
here would misrepresent the process rather than protect it.

What that means concretely: the architecture, the trade-offs in `docs/decisions/`
and the choice of what to leave out are mine. The code was largely written by an
agent against those decisions, and reviewed. Where I rejected an agent's
proposal, the ADR says so and says why — that difference is the part worth
reading.

## Licence

MIT.
