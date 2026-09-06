#!/usr/bin/env bash
# Delete the cluster. Nothing in it is worth keeping — the dependencies are
# single replicas on emptyDir and say so.
set -euo pipefail
CLUSTER="${CLUSTER:-signalpipe}"
k3d cluster delete "${CLUSTER}"
