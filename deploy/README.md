# Kubernetes

Docker Compose is still the quick path and still works. This is the second
path: the same three services under a Helm chart, on a cluster a reviewer can
create on a laptop in a few minutes — most of which is the first image build —
with a script that measures what a release costs.

```bash
./deploy/k3d-up.sh          # cluster + image + helm install
curl -s localhost:8080/health
./deploy/probe.sh           # steady traffic through a real rolling deploy
./deploy/k3d-down.sh        # delete everything
```

Needs `docker`, `k3d`, `kubectl` and `helm`. Nothing talks to a registry — the
image is built locally and imported straight into the cluster nodes.

## What `k3d-up.sh` does

1. Creates a k3d cluster (one server, one agent) with host `:8080` mapped to the
   cluster load balancer.
2. Waits for Traefik. k3s installs it asynchronously through its helm-controller
   after the API server is up, so the Deployment does not exist yet at
   cluster-create time.
3. Builds `signalpipe:dev` and `k3d image import`s it.
4. `helm upgrade --install`, passing `ops/fixture.json` with `--set-file` so the
   chart does not carry a second copy of it.

It is idempotent. Run it again and it rebuilds the image and upgrades the
release.

The request path the probe measures is:

```
host :8080 → k3d serverlb → node :80 → klipper (servicelb) → Traefik
           → Service signalpipe-api → one of 3 api pods
```

## The probe

`ops/probe.mjs` fires open-loop traffic at `POST /check` — the real endpoint,
which does a real query — while `deploy/probe.sh` runs a real
`helm upgrade` underneath it. It prints a table and **exits non-zero if a single
request failed**. That exit code is the point: "zero-downtime" is an assertion
this script either passes or does not.

Open-loop matters. A client with N workers each waiting for a reply stops
sending when the server stalls, so a stall shows up as reduced throughput rather
than as latency, and the tail you wanted to measure disappears.

```bash
./deploy/probe.sh                     # defaults: 50 rps, 5s warmup, 20s cooldown
RPS=100 COOLDOWN=30 ./deploy/probe.sh
```

The cooldown is long on purpose. `kubectl rollout status` returns when the new
ReplicaSet is available, which is *before* the last old pod has finished
draining — stop the traffic there and the most interesting requests never get
sent.

To reproduce the failing configurations from
[ADR-0006](../docs/decisions/0006-a-pod-drains-itself.md):

```bash
# readiness alone — no preStop, no in-process drain
EXTRA_HELM_ARGS='--set api.preStopSeconds=0 --set api.drainSeconds=0' ./deploy/probe.sh

# preStop alone — zero failures, seconds of tail latency
EXTRA_HELM_ARGS='--set api.preStopSeconds=5 --set api.drainSeconds=0' ./deploy/probe.sh
```

Set the same flags on an install first, then probe. The configuration that
matters during a rollout is the one on the pods being *terminated*.

## The chart

`deploy/helm/signalpipe`. `helm show values deploy/helm/signalpipe` for the
whole surface; the parts worth knowing:

| | |
|---|---|
| `api.strategy.maxUnavailable: 0` | never take capacity away to make room for the new version |
| `api.drainSeconds: 5` | how long the process keeps serving after SIGTERM |
| `api.preStopSeconds: 5` | how long SIGTERM is delayed while endpoint removal propagates |
| `api.terminationGracePeriodSeconds: 30` | must exceed preStop + drain; the clock starts at preStop |
| `deps.*.enabled` | in-cluster Postgres/Redis/Redpanda, on for a laptop |
| `external.*` | connection strings used when the matching dep is off |

Probes:

- **api** — `httpGet /live` for liveness, which touches nothing but the process,
  and `httpGet /ready` for readiness, which checks Postgres and returns 503 the
  instant SIGTERM lands. `/health` is the human-facing summary and is wired to
  no probe.
- **ingester, processor** — no HTTP surface, so liveness is a heartbeat file the
  worker rewrites on the beat that actually matters (a kafkajs `FETCH`, a
  completed poll tick) and an `exec` probe asserting the file is recent. A web
  server standing up only to answer "the web server is up" would stay green
  through a consumer that had silently stopped fetching. The processor's
  readiness file is written on `GROUP_JOIN`, so a rollout waits for the
  rebalance instead of racing through it.

The in-cluster dependencies are single replicas on `emptyDir`. Restarting one
loses its data. They exist so a reviewer can run this, and the chart says as
much in `NOTES.txt`. For anything real, set `deps.*.enabled=false` and point
`external.*` at managed services — the chart fails the render rather than
installing something that will crash-loop against a hostname that does not
exist.

## CI

`.github/workflows/release-probe.yml` does all of the above on every push: k3d
cluster, image build, `helm upgrade`, probe. The number in the top-level README
fails the build when it stops being true, which is the only reason it is worth
printing.
