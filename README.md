# Kakaw monitoring — logs to Grafana Cloud

Ships every container's logs from the Dokploy host into **Grafana Cloud Loki**
using **Grafana Alloy**, plus an importable Grafana dashboard.

There is no self-hosted Grafana or Loki here — logs go to the existing Grafana
Cloud instance. Only the Alloy collector runs on the host.

## What gets collected

Alloy discovers all running containers via the Docker socket and tails their
stdout/stderr. Each line is labelled:

| label     | source                                   |
|-----------|------------------------------------------|
| `service` | container name (e.g. `backend`, `agent`, `postgres`) |
| `env`     | `prod`                                   |
| `host`    | `ALLOY_HOST_LABEL` (default `dokploy`)   |
| `level`   | parsed from JSON logs (`info`/`error`/…) |

The backend (nestjs-pino) and agent (PipelineLogger) emit JSON, so fields like
`requestId`, `userId`, `messageId`, `event`, `layer` are queryable per line.
These are deliberately **not** labels (they are high-cardinality) — filter on
them with LogQL, e.g. `{service="agent"} | json | requestId="…"`.

## Deploy on Dokploy

1. In Grafana Cloud → your stack → **Loki → Send Logs**, copy the push URL and
   user/instance ID, and create an Access Policy **token** with `logs:write`.
2. Create a new **Docker Compose** application in Dokploy pointing at this
   repository (`gitnasr/kakaw-monitoring`); the compose file is at the root.
3. Set the environment variables from `.env.example`
   (`GRAFANA_CLOUD_LOKI_URL`, `GRAFANA_CLOUD_LOKI_USER`,
   `GRAFANA_CLOUD_API_TOKEN`, optional `ALLOY_HOST_LABEL`).
4. Deploy. Alloy needs the host's Docker socket — the compose file mounts
   `/var/run/docker.sock` read-only.

### Verify
- In Grafana Cloud **Explore**, query `{env="prod"}` → logs from
  `service="backend"`, `service="agent"`, postgres appear within ~1 min.
- `{env="prod", level="error"}` returns only errors.
- Alloy's own UI (health/debug) is on `127.0.0.1:12345` — reach it with
  `ssh -L 12345:localhost:12345 <host>` then open `http://localhost:12345`.

## Dashboard

Import `dashboards/kakaw-logs.json` in Grafana Cloud
(**Dashboards → New → Import**) and select the Loki data source when prompted.
