#!/usr/bin/env bash
# Measure what a release costs.
#
# Fires steady traffic at the API through the ingress while a real
# `helm upgrade` rolls the API Deployment underneath it. Exits non-zero if a
# single request failed. That exit code is the point: "zero-downtime" is an
# assertion this script either passes or does not.
set -euo pipefail
cd "$(dirname "$0")/.."

NAMESPACE="${NAMESPACE:-signalpipe}"
RELEASE="${RELEASE:-signalpipe}"
URL="${URL:-http://localhost:8080}"
RPS="${RPS:-50}"
TAG="${TAG:-dev}"
WARMUP="${WARMUP:-5}"
# Long enough that the last old pod finishes terminating inside the measured
# window. `kubectl rollout status` returns when the new ReplicaSet is available,
# which is before the final old pod has drained — stop the traffic there and the
# most interesting requests never get sent.
COOLDOWN="${COOLDOWN:-20}"
# Extra --set flags, so the shutdown configuration can be varied without
# editing anything. This is how the failing runs in ADR-0006 were produced:
#   EXTRA_HELM_ARGS='--set api.preStopSeconds=0 --set api.drainSeconds=0' ./deploy/probe.sh
EXTRA_HELM_ARGS="${EXTRA_HELM_ARGS:-}"

# Only the API rollout is timed. `helm upgrade --wait` would also wait on the
# workers and on Postgres, which would make the reported deploy duration mean
# something other than "how long the serving tier took to turn over".
DEPLOY_CMD="helm upgrade --install ${RELEASE} deploy/helm/signalpipe \
  --namespace ${NAMESPACE} --create-namespace \
  --set-file fixtureJson=ops/fixture.json \
  --set image.tag=${TAG} \
  --set releaseId=$(date +%s) \
  ${EXTRA_HELM_ARGS} \
  && kubectl -n ${NAMESPACE} rollout status deploy/${RELEASE}-api --timeout=5m"

exec node ops/probe.mjs \
  --url "${URL}" \
  --rps "${RPS}" \
  --warmup "${WARMUP}" \
  --cooldown "${COOLDOWN}" \
  --label "helm upgrade + rollout" \
  --deploy "${DEPLOY_CMD}" \
  "$@"
