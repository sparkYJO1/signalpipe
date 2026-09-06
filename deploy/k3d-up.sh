#!/usr/bin/env bash
# Bring up a laptop cluster running the whole pipeline.
#
# Idempotent: re-running it rebuilds the image and upgrades the release.
# Nothing here talks to a registry — the image is built locally and imported
# straight into the k3d nodes, so this works on a plane.
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER="${CLUSTER:-signalpipe}"
NAMESPACE="${NAMESPACE:-signalpipe}"
RELEASE="${RELEASE:-signalpipe}"
HOST_PORT="${HOST_PORT:-8080}"
TAG="${TAG:-dev}"

need() { command -v "$1" >/dev/null || { echo "missing: $1" >&2; exit 1; }; }
need docker; need k3d; need kubectl; need helm

if ! k3d cluster list -o json | grep -q "\"name\":\"${CLUSTER}\""; then
  echo "==> creating k3d cluster '${CLUSTER}' (host :${HOST_PORT} -> ingress :80)"
  # servicelb (klipper) stays enabled. The path the probe measures is
  #   host:8080 -> k3d serverlb -> node:80 -> klipper -> traefik -> Service -> pod
  # and disabling servicelb leaves nothing listening on node:80, so the whole
  # chain fails with an empty reply while every in-cluster check still passes.
  k3d cluster create "${CLUSTER}" \
    --agents 1 \
    --port "${HOST_PORT}:80@loadbalancer" \
    --wait
else
  echo "==> cluster '${CLUSTER}' already exists"
  k3d kubeconfig merge "${CLUSTER}" --kubeconfig-merge-default --kubeconfig-switch-context >/dev/null
fi

# k3s installs Traefik through its helm-controller after the API server is up,
# so the Deployment does not exist yet at cluster-create time. Waiting on the
# object before it exists is the single most common way this script fails on a
# fresh machine.
echo "==> waiting for traefik"
for _ in $(seq 1 60); do
  kubectl -n kube-system get deploy traefik >/dev/null 2>&1 && break
  sleep 5
done
kubectl -n kube-system rollout status deploy/traefik --timeout=180s

echo "==> building signalpipe:${TAG}"
docker build -t "signalpipe:${TAG}" .

echo "==> importing image into the cluster"
k3d image import "signalpipe:${TAG}" -c "${CLUSTER}"

echo "==> helm upgrade --install ${RELEASE}"
helm upgrade --install "${RELEASE}" deploy/helm/signalpipe \
  --namespace "${NAMESPACE}" --create-namespace \
  --set-file fixtureJson=ops/fixture.json \
  --set "image.tag=${TAG}" \
  --set "releaseId=$(date +%s)" \
  --wait --timeout 8m

kubectl -n "${NAMESPACE}" rollout status "deploy/${RELEASE}-api" --timeout=5m

echo
echo "==> up. try:"
echo "    curl -s localhost:${HOST_PORT}/health"
echo "    ./deploy/probe.sh"
