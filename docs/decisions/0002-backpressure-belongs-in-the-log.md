# ADR-0002 — Backpressure belongs in the log

## Problem

The producer can outrun the consumer by orders of magnitude: polling is fast,
extraction is slow. Something has to absorb the difference.

## Decision

Let consumer lag grow. The ingester does not throttle itself, and the processor
handles one message at a time.

The log is the buffer. That is what it is for. Lag becomes the signal that says
how far behind the expensive stage is, in a unit that is directly observable
and alertable.

Processing one message at a time is deliberate: the extractor is the
bottleneck, so batching buys nothing and only makes lag harder to read.

## Rejected

**Throttle the ingester when lag grows.** This is the intuitive answer and it
is worse. It moves the queue from a place designed to hold it into a place that
is not, and it destroys the signal — a system that slows its producer to keep
lag flat looks healthy right up until it is not. Lag going up is information.

**Scale the processor automatically on lag.** The right answer eventually, and
out of scope here. Worth noting that partition count caps it, which is why
ADR-0004 matters more than it looks.

## Consequence

A burst shows up as lag rather than as loss. Someone has to actually watch lag,
which is a real operational obligation this repo does not yet meet — there is
no alerting here, and the README says so.
