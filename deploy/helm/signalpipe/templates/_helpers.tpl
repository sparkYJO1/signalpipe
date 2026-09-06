{{- define "signalpipe.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "signalpipe.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "signalpipe.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "signalpipe.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
The connection strings every service shares. When a dependency is disabled the
chart refuses to guess: it fails the render rather than installing something
that will crash-loop against a hostname that does not exist.
*/}}
{{- define "signalpipe.databaseUrl" -}}
{{- if .Values.deps.postgres.enabled -}}
postgres://postgres:postgres@{{ include "signalpipe.fullname" . }}-postgres:5432/signalpipe
{{- else if .Values.external.databaseUrl -}}
{{- .Values.external.databaseUrl -}}
{{- else -}}
{{- fail "deps.postgres.enabled is false, so external.databaseUrl must be set" -}}
{{- end -}}
{{- end -}}

{{- define "signalpipe.redisUrl" -}}
{{- if .Values.deps.redis.enabled -}}
redis://{{ include "signalpipe.fullname" . }}-redis:6379
{{- else if .Values.external.redisUrl -}}
{{- .Values.external.redisUrl -}}
{{- else -}}
{{- fail "deps.redis.enabled is false, so external.redisUrl must be set" -}}
{{- end -}}
{{- end -}}

{{- define "signalpipe.brokers" -}}
{{- if .Values.deps.redpanda.enabled -}}
{{ include "signalpipe.fullname" . }}-redpanda:9092
{{- else if .Values.external.redpandaBrokers -}}
{{- .Values.external.redpandaBrokers -}}
{{- else -}}
{{- fail "deps.redpanda.enabled is false, so external.redpandaBrokers must be set" -}}
{{- end -}}
{{- end -}}

{{- define "signalpipe.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag }}
{{- end -}}

{{/*
Pod annotations. releaseId is what turns `helm upgrade` into a real rolling
replacement without changing the image, which is how the probe drives a deploy.
*/}}
{{- define "signalpipe.podAnnotations" -}}
{{- if .Values.releaseId }}
signalpipe.dev/release-id: {{ .Values.releaseId | quote }}
{{- end }}
{{- end -}}

{{/*
Liveness for a process with no HTTP surface: assert the heartbeat file the
worker rewrites on each broker fetch / poll tick is younger than maxAge.
Written with `sh -c` and busybox-safe arithmetic because the runtime image is
node:22-alpine.
*/}}
{{- define "signalpipe.heartbeatProbe" -}}
exec:
  command:
    - /bin/sh
    - -c
    - '[ -f {{ .file }} ] && [ $(( $(date +%s) - $(cat {{ .file }}) )) -lt {{ .maxAge }} ]'
{{- end -}}
