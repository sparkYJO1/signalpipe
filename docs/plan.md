# Plan

Written before the code, kept as written, with a short note at the end on what
actually happened.

## Why this and not something else

I own the Kubernetes footprint at work — several applications plus the
Redpanda, Redis, database and cron workloads behind them, with a five-person
team and no dedicated infrastructure engineer. None of that is visible to
anyone outside the company, and none of it can be published.

So this needed to be a system I own outright that exercises the same shape.

The domain is security advisories because a reviewer understands the problem in
about four seconds and can check the output themselves. There is no domain
knowledge standing between them and the engineering.

## The one property everything is built around

The extraction step:

- costs money per call
- is an order of magnitude slower than everything else in the path
- can return a different answer for the same input

Any pipeline design that ignores one of those three ends up either expensive,
stalled, or wrong. Most of the decisions in `docs/decisions/` are downstream of
this single paragraph.

## Scope

**In, for v1**

- Three services: ingester, processor, api
- Redpanda with a dead-letter topic, Redis, Postgres
- An extractor interface with two implementations, defaulting to the one that
  needs no credentials
- Content-hash caching, bounded retries, dead-lettering
- Runs entirely under `docker compose up`

**Out, and stated as out**

Kubernetes, Helm, rolling-deploy measurement, multi-tenancy, auth, a frontend,
autoscaling, Terraform, a service mesh.

Also out, for a different reason: **a configurable rule engine**. That shape
belongs to my employer's system, and reproducing it here would blur a line that
has to stay sharp. Ingest, queue and worker are generic; that is not.

## How this fails

The most likely failure was perfecting infrastructure until there was no
application. The countermeasure was ordering: get one advisory flowing end to
end under Docker Compose first, and treat everything else as optional.

The second most likely failure is the README promising more than the code does.
The countermeasure is the "deliberately not here" section, and refusing to use
the word "zero-downtime" anywhere, because nothing here measures it.

## What actually happened

Built in a day rather than the weeks originally estimated, because the scope
was cut to Docker Compose. That cut is real and costs something: the strongest
claim on my résumé is Kubernetes ownership, and this does not demonstrate it.
It demonstrates the pipeline design underneath.

Two things went differently than planned:

- `(ecosystem, package_name) = ANY($1::record[])` fails at runtime — Postgres
  will not bind an anonymous composite array. Replaced with two parallel arrays
  joined through `unnest`. It parses fine, so nothing catches it until a request
  arrives, which is exactly the kind of bug an integration test earns its keep on.
- The fixture gained an advisory that states no versions at all, once it became
  clear that "extraction returned nothing" and "extraction failed" needed to be
  visibly different states. It is stored with zero ranges and confidence 0, and
  it is not dead-lettered.

Next, in order: a rolling-deploy probe that measures 5xx and p99 across a
release, then Kubernetes and Helm underneath it, then extraction accuracy
against a labelled set.
