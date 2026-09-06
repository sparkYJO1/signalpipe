# signalpipe

[![release probe](https://github.com/sparkYJO1/signalpipe/actions/workflows/release-probe.yml/badge.svg)](https://github.com/sparkYJO1/signalpipe/actions/workflows/release-probe.yml)

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

There is a second path — a Helm chart, a k3d cluster and a script that measures
what a release costs. It is below, under
[Releases are measured](#releases-are-measured).

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

## Releases are measured

`./deploy/probe.sh` fires steady open-loop traffic at `POST /check` while a real
`helm upgrade` rolls the API underneath it, and **exits non-zero if a single
request failed**. Real output from `./deploy/k3d-up.sh && ./deploy/probe.sh` on
a cluster created two minutes earlier — three replicas, 50 requests per second,
through a Traefik ingress:

```
window          requests  failed     p50     p95     p99     max
---------------------------------------------------------
before deploy        239       0     4ms    12ms    33ms    42ms
during deploy        546       0     6ms   121ms   350ms   551ms
after deploy         957       0     4ms    12ms   107ms   327ms
total               1742       0     4ms    21ms   221ms   551ms

helm upgrade + rollout: 11.4s   exit=0   offered load 50/s
failures: none — 0 non-2xx, 0 connection errors, 0 timeouts
```

Six runs of this configuration, 10,449 requests at 40–50/s, zero failures — two
of them the first probe against a cluster that was minutes old. That table is what the word zero-downtime is allowed to mean in this
repository: a measurement with a scope attached, not an adjective. The same
probe runs in CI against a k3d cluster on every push — that is what the badge at
the top is — so the number fails the build when it stops being true rather than
ageing quietly in a README.

Getting there took three attempts at the shutdown path, and two more at the
startup path. The configuration most guides describe — `maxUnavailable: 0` and
a readiness probe that fails on SIGTERM — dropped 49 of 1652 requests. The one
after that reached zero failures with a `p99` of 2.7 seconds, which counting
only failures would have called a success.
[ADR-0006](docs/decisions/0006-a-pod-drains-itself.md) has every failing run
with its numbers and the commands to reproduce them.

**What this does not prove.** A k3d cluster is two nodes on one laptop behind
Traefik. It is not a production cluster behind a cloud load balancer, which
notices an unhealthy target more slowly than Traefik does and would need a
longer drain window, not a shorter one. 50 requests per second is low enough
that three replicas minus one is still ample, so this measures the routing gap
during a rollout and not capacity under one. The in-cluster Postgres, Redis and
Redpanda are single replicas on `emptyDir`. What it does prove is that the
shutdown path is correct and stays correct, which is the part that is usually
wrong.

[`deploy/README.md`](deploy/README.md) is the short version:

```bash
./deploy/k3d-up.sh     # cluster + image + helm install
./deploy/probe.sh      # the table above
./deploy/k3d-down.sh
```

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
| [ADR-0006](docs/decisions/0006-a-pod-drains-itself.md) | A pod drains itself. Readiness is a request to stop sending, not an acknowledgement that sending has stopped — with the two configurations that did not work |

[`docs/plan.md`](docs/plan.md) is the plan this was built from, including what
was deliberately cut.

## Extracted from this

**[nestjs-outbox](https://github.com/sparkYJO1/nestjs-outbox)** — the
transactional outbox and idempotent-consumer parts, pulled out as a package.
The API is shaped the way it is because it came out of building this, not from
designing a library in the abstract.

## Deliberately not here

Multi-tenancy. Auth. A frontend. Autoscaling. Terraform. A service mesh. A
configurable rule engine.

Kubernetes and rolling-deploy verification used to be on this list. They came
off it by being built and measured, not by being claimed — see
[Releases are measured](#releases-are-measured) for what the numbers cover and
what they do not.

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
ops/probe.mjs       the release probe — open-loop load, percentiles, exit code
deploy/helm         the chart: three services, their dependencies, probes, PDB
deploy/*.sh         k3d up, probe, down
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
