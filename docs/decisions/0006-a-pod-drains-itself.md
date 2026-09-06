# ADR-0006 — A pod drains itself; the orchestrator only stops sending

## Problem

Rolling three API replicas with the obvious configuration drops requests.

Not a few. Measured on a k3d cluster at 40 requests/second through a Traefik
ingress, with `maxUnavailable: 0`, a readiness probe on `/ready` that returns
503 the instant SIGTERM lands, and nothing else:

```
window          requests  failed     p50     p95     p99     max
before deploy        192       0     6ms    63ms   138ms   206ms
during deploy        693      41    17ms   455ms  5002ms  5030ms
after deploy         767       8     7ms   184ms   517ms  5003ms
total               1652      49     9ms   225ms  1350ms  5030ms

failures: HTTP 502 ×33, ETIMEDOUT ×16
```

Reproduce it with:

```bash
EXTRA_HELM_ARGS='--set api.preStopSeconds=0 --set api.drainSeconds=0' ./deploy/probe.sh
```

The reason is that a pod deletion is acted on by two controllers that do not
coordinate. The endpoint controller strikes the pod from the EndpointSlice, and
the ingress then reconciles its own backend pool from that. Separately, the
kubelet runs `preStop` and sends SIGTERM. Nothing sequences those, and the
second one is much faster than the first. A process that closes its listening
socket when SIGTERM arrives is closing it while the ingress is still routing to
it, and every request in that gap is a 502.

Readiness is a request to stop sending. It is not an acknowledgement that
sending has stopped.

## Decision

The API keeps serving for a fixed window after SIGTERM, and closes deliberately:

1. SIGTERM sets `draining`. `/ready` starts returning 503 with a reason.
2. Every response, for the whole drain, carries `Connection: close`. The ingress
   holds pooled keep-alive sockets to this pod; this retires them after a
   response the client already has, instead of having them severed mid-request.
3. After `SHUTDOWN_DRAIN_MS` (5s), `server.close()` plus
   `closeIdleConnections()` — the second one matters, because idle keep-alive
   sockets otherwise hold the close open for `keepAliveTimeout`.
4. `preStop: sleep 5` delays SIGTERM as a backstop.
5. `terminationGracePeriodSeconds: 30`, which must exceed preStop + drain +
   close, because the grace clock starts when preStop starts, not when SIGTERM
   is delivered.

Alongside that: `maxUnavailable: 0` with `maxSurge: 1`, so the rollout rents an
extra pod rather than borrowing capacity from the ones still serving. And
liveness on `/live`, which touches nothing but this process — a liveness probe
that checked Postgres would fail on every replica at once during a database
blip and let the kubelet convert a recoverable dependency outage into a
self-inflicted one.

Result, six runs, 10,449 requests at 40–50/s, zero failures. The one below is
the first probe against a cluster created two minutes earlier, which is what
`./deploy/k3d-up.sh && ./deploy/probe.sh` produces from nothing:

```
window          requests  failed     p50     p95     p99     max
before deploy        239       0     4ms    12ms    33ms    42ms
during deploy        546       0     6ms   121ms   350ms   551ms
after deploy         957       0     4ms    12ms   107ms   327ms
total               1742       0     4ms    21ms   221ms   551ms

helm upgrade + rollout: 11.4s   exit=0   offered load 50/s
```

## What did not work

**Readiness alone.** This is the run at the top of this page. The belief being
tested was that `maxUnavailable: 0` plus a readiness probe that fails
immediately on SIGTERM is enough, because Kubernetes will have stopped routing
before the socket closes. It does not. 49 of 1652 requests failed, and the shape
of the failures says why: 33 HTTP 502s, which are the ingress still holding the
pod in its backend pool, and 16 client timeouts at the 5s ceiling, which are
requests dispatched onto a connection that was going away. The `p99` inside the
deploy window was 5002 ms — that is the timeout, not a latency.

**`preStop` sleep alone**, which is what most write-ups recommend. It gets the
failure count to zero, and that is where a less careful measurement would stop:

```
                     requests  failed     p50     p95     p99     max
run 1, during deploy      710       0    15ms  1884ms  2742ms  3287ms
run 2, after deploy       771       0     8ms  1005ms  2177ms  2808ms
```

Zero failures, and a p99 between two and three seconds. The pod serves happily
through the preStop window and then stops accepting the moment SIGTERM lands, so
the ingress's pooled connections to it are cut rather than retired, and the
requests riding them wait for a reconnect. "No dropped requests" and "no impact"
are not the same claim, and only the probe's latency columns tell them apart.

**Running migrations before opening the port.** The original `bootstrap` awaited
`migrate()` and then called `listen()`. On a cold cluster where Postgres takes
longer to accept connections than the startup budget allows, the kubelet sees:

```
Warning  Unhealthy  Startup probe failed: Get "http://10.42.0.13:3000/ready":
                    dial tcp 10.42.0.13:3000: connect: connection refused
Normal   Killing    Container api failed startup probe, will be restarted
```

Every API pod restarted once, and the logs showed the process had been doing
exactly the right thing — retrying the migration with backoff — the whole time.
Connection-refused is indistinguishable from a crash. Opening the port first and
reporting `503 {"reason":"migrating"}` turns the same wait into a fact the
kubelet can act on and a human can read. A service should never make its
listener conditional on a dependency; that is what readiness is for.

**A migration timeout competing with the startup probe.** The fix above shipped
with a 60-second deadline on the migration retry loop, next to a startup probe
deliberately given 180 seconds because a cold laptop cluster is slow. On a
from-scratch `./deploy/k3d-up.sh`, one API pod restarted anyway:

```
04:45:48  Created pod signalpipe-api-...-9gfnm
04:45:57  Startup probe failed: dial tcp 10.42.1.6:3000: connection refused
04:46:41  Startup probe failed: HTTP probe failed with statuscode: 503
04:47:57  Container created / Container started      <- restarted
```

No `Killing` event, so no probe killed it: the process exited on its own. The
only exit path is the migration loop giving up, and the arithmetic matches —
port open around 04:46:00, deadline 60s later, exit, CrashLoopBackOff, restart
at 04:47:57. Postgres on a cold cluster had not accepted a connection inside a
minute, and the 180-second budget that was supposed to cover exactly that was
never reached, because a second clock inside the process expired first.

Deciding when to give up on a slow dependency is the orchestrator's job. The
retry loop now has no deadline by default; it retries and logs why, and the
startup probe owns the verdict. Two independent timeouts governing the same
event is a bug even when both numbers are individually reasonable, because the
shorter one wins silently and the longer one looks like it is working.

## Consequence

The honest reading of the ablation is that the in-process drain is the
load-bearing half. On its own, with no `preStop` at all, it also reached zero
failures with a `p99` of 217 ms — better than `preStop` alone on both counts.
`preStop` is kept anyway, because the drain depends on application code being
correct and `preStop` does not; it is the half that still works when someone
adds a library that calls `process.exit` in a shutdown hook.

What this costs: one surge pod for the length of a rollout, about ten seconds
per pod of added rollout time, and a 30-second grace period that a node drain
has to wait out. The rollout takes 12.8s instead of roughly 5s. That is the
trade, and it is worth it.

What this does not prove: a k3d cluster on a laptop is two nodes on one machine
behind Traefik, not a real cluster behind a cloud load balancer with its own
health-check interval and its own connection draining. A cloud LB typically
notices an unhealthy target more slowly than Traefik does, which means the drain
window needed there is longer, not shorter. 50 requests/second is a low enough
offered load that three replicas minus one is still ample, so this measures the
routing gap, not capacity under a rollout. Both of those are why the probe is a
script that reports numbers rather than a sentence in the README.
