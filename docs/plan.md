# Plan: vitals — Oura health dashboard

Source spec: `./spec.md`. Two repos are involved: `~/dev/dbd/vitals` (this repo, TypeScript) and `~/homelab` (Flux manifests, step 8–9 only).

Conventions discovered during planning (do not re-derive):

- Homelab secrets: SOPS + age; `~/homelab/.sops.yaml` auto-matches `*secret.yaml` — write plaintext, `sops -e -i` it.
- Custom images: `ghcr.io/devbydaniel/<name>`, versioned tags, release-please (see `~/dev/dbd/taproot/.github/workflows/`).
- Tailnet exposure: tailscale LoadBalancer service (`~/homelab/apps/miniflux/miniflux-service.yaml`).
- Per-app Postgres: `~/homelab/apps/miniflux/postgres-*.yaml` (`postgres:18`, synology-csi PVC).
- CronJob pattern: `~/homelab/apps/restic-backup/cronjob.yaml`.
- Oura API: base `https://api.ouraring.com` (the OpenAPI file `~/Downloads/oura-openapi.json` has a broken `servers` entry — ignore it). OAuth token URL `https://api.ouraring.com/oauth/token`, authorize URL `https://cloud.ouraring.com/oauth/authorize`. Refresh tokens are SINGLE-USE and rotate.

## Steps

### ✅ Step 1 — Scaffold repo

**Scope:** ONLY `~/dev/dbd/vitals/` (new files; `docs/` already exists — leave it)

**Creates:** repo scaffold via the `setup-repo` skill — name `vitals`, description "Personal health data scraper + dashboards (Oura, extensible)", **simple tier**, ticket prefix `VIT`, GitHub user `devbydaniel`, database **None** (we add `pg` ourselves in step 2 — no ORM), no frontend, no auth. Then:

- Remove the Fastify server bits the simple tier ships (`src/app.ts`, `src/server.ts`, `src/routes/`) and their deps — this is a batch CLI, not a server. Keep all tooling (eslint, prettier, vitest, hooks, CI).
- Add `docker-compose.yml` with `postgres:18` for local dev (port 5432, volume, POSTGRES_DB=vitals).
- `.env.example`: `DATABASE_URL`, `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET`, `HEARTBEAT_URL`.

**Tests:** scaffold's own smoke test passes after server-bit removal.

**Validation:**

```bash
cd ~/dev/dbd/vitals && npm run lint && npm run typecheck && npm test
```

**DO NOT touch:** `~/homelab/`, `docs/spec.md`, `docs/plan.md` (except ✅ markers)

### Step 2 — DB schema + migrations

**Scope:** ONLY `~/dev/dbd/vitals/{migrations/,src/db.ts,package.json,docker-compose.yml}`

**Creates:**

- `migrations/` using **node-pg-migrate** (SQL-first). Migration 1:
  - `tokens` (`provider` text PK, `access_token`, `refresh_token`, `expires_at` timestamptz, `updated_at`) — the multi-provider seam.
  - Per-endpoint tables `oura_daily_sleep`, `oura_daily_readiness`, `oura_daily_activity`, `oura_daily_stress`, `oura_daily_resilience`, `oura_daily_spo2`, `oura_daily_cardiovascular_age`, `oura_vo2_max`, `oura_sleep`, `oura_sleep_time`, `oura_workout`, `oura_session`, `oura_enhanced_tag`, `oura_rest_mode_period` — shape: `id` text PK, `day` date (indexed), `raw` jsonb, `fetched_at` timestamptz. Views extract from jsonb; no wide parsed columns.
  - `oura_heartrate`: (`ts` timestamptz, `source` text, `bpm` int, PK (`ts`,`source`)) — no document id in the API.
- `src/db.ts` — pg Pool from `DATABASE_URL`, small `upsertDocument(table, id, day, raw)` helper.

**Tests:** vitest integration test: run migrations against docker-compose postgres, assert tables exist, upsert twice → one row.

**Validation:**

```bash
cd ~/dev/dbd/vitals && docker compose up -d && npm run migrate up && npm run lint && npm run typecheck && npm test
```

**DO NOT touch:** `src/providers/`, `src/cli/`, `~/homelab/`

### Step 3 — Oura client + OAuth token machinery

**Scope:** ONLY `~/dev/dbd/vitals/src/{oauth.ts,tokens.ts,providers/oura/}` + tests

**Creates:**

- `src/oauth.ts` — generic OAuth2 helpers: `exchangeCode()`, `refreshTokens()` (POST token URL, Basic auth client id/secret). Provider-agnostic (Whoop later).
- `src/tokens.ts` — `getFreshToken(provider)`: read row → `refreshTokens()` → **persist new pair in the same transaction BEFORE returning the access token** (crash-safety invariant from spec). On `invalid_grant`: throw a typed fatal error.
- `src/providers/oura/client.ts` — fetch one endpoint with `start_date`/`end_date`, follow `next_token` pagination, return all documents. Endpoint registry (name → path → table) for all 15 endpoints. 429/5xx: simple retry with backoff.

**Tests:** unit tests with mocked `fetch`: pagination follows next_token; refresh persists before first API call (assert call order); invalid_grant → fatal.

**Validation:**

```bash
cd ~/dev/dbd/vitals && npm run lint && npm run typecheck && npm test
```

**DO NOT touch:** `src/cli/`, `src/sync.ts`, `migrations/`, `~/homelab/`

### Step 4 — Bootstrap auth CLI

**Scope:** ONLY `~/dev/dbd/vitals/src/cli/auth.ts` + tests + `package.json` (bin/script entry)

**Creates:** `src/cli/auth.ts` — prints/opens `https://cloud.ouraring.com/oauth/authorize?...` (scopes `email personal daily heartrate workout session tag spo2Daily`, `redirect_uri=http://localhost:8484/callback`, random `state`), listens on localhost:8484, validates state, exchanges code via `src/oauth.ts`, upserts the `tokens` row for provider `oura`. Reads `DATABASE_URL` (works via kubectl port-forward), `OURA_CLIENT_ID/SECRET` from env.

**Tests:** unit test the callback handler (state mismatch rejected, code exchanged, row written) with mocked fetch + test DB.

**Validation:**

```bash
cd ~/dev/dbd/vitals && npm run lint && npm run typecheck && npm test
```

**DO NOT touch:** `src/sync.ts`, `migrations/`, `~/homelab/`

### Step 5 — Sync engine + cron entrypoint

**Scope:** ONLY `~/dev/dbd/vitals/src/{sync.ts,cli/sync.ts}` + tests + `package.json` (script entry)

**Creates:**

- `src/sync.ts` — for each endpoint: window = trailing 7 days, or **full backfill** (2013-01-01 → today, in ≤30-day chunks to respect range limits) when the table is empty. Upsert everything by document id (idempotent). Heartrate uses datetime params. After ALL endpoints succeed: GET `HEARTBEAT_URL` if set. Any failure → non-zero exit, no heartbeat.
- `src/cli/sync.ts` — entrypoint the container runs.

**Tests:** integration: mocked API + real docker postgres — empty table triggers backfill windows, populated table triggers 7-day window, re-run is idempotent, failure skips heartbeat.

**Validation:**

```bash
cd ~/dev/dbd/vitals && docker compose up -d && npm run migrate up && npm run lint && npm run typecheck && npm test
```

**DO NOT touch:** `migrations/` (views come in step 6), `~/homelab/`

### Step 6 — SQL views (interpretation layer)

**Scope:** ONLY `~/dev/dbd/vitals/migrations/` (new migration)

**Creates:** one migration adding views (extracting from `raw` jsonb; all with a `day` column for Grafana time filtering):

- `v_daily_scores` — sleep/readiness/activity/stress/resilience scores + HRV (`raw->>'average_hrv'` from daily_sleep contributors / sleep), RHR, per day.
- `v_baselines_30d` — each score + HRV + RHR vs 30-day rolling mean and stddev band (window functions).
- `v_sleep` — duration, stages, efficiency, bedtime/waketime per day; `v_sleep_debt_14d` — cumulative deficit vs 8h over trailing 14 days; `v_sleep_consistency` — bedtime variance per week.
- `v_weekly_deltas` — week-over-week averages of key scores.

**Tests:** integration test: seed 40 days of synthetic jsonb rows, assert view outputs (rolling mean correct at day 31, sleep debt sums).

**Validation:**

```bash
cd ~/dev/dbd/vitals && docker compose up -d && npm run migrate up && npm run lint && npm run typecheck && npm test
```

**DO NOT touch:** `src/`, `~/homelab/`

### Step 7 — Dockerfile + CI image publish

**Scope:** ONLY `~/dev/dbd/vitals/{Dockerfile,.github/workflows/,release-please-config.json,.release-please-manifest.json,package.json}`

**Creates/Edits:** multi-stage Dockerfile (build TS → slim node:24 runtime, entrypoint `node dist/cli/sync.js`; migrations run via `npm run migrate up` as an initContainer command or entry pre-step — include migrate in the image). `release-please.yml` + docker publish job → `ghcr.io/devbydaniel/vitals:<version>` on release (copy the taproot workflow shape: `~/dev/dbd/taproot/.github/workflows/release-please.yml`). Make the package public (or add ghcr pull secret in step 8 — prefer public, no PHI in the image).

**Tests:** `docker build .` succeeds locally.

**Validation:**

```bash
cd ~/dev/dbd/vitals && npm run lint && npm run typecheck && npm test && docker build -t vitals-test .
```

**DO NOT touch:** `src/` (except nothing), `migrations/`, `~/homelab/`

### Step 8 — Homelab manifests

**Scope:** ONLY `~/homelab/apps/vitals/` (new) + `~/homelab/apps/kustomization.yaml` (add one line)

**Creates:** following existing app shapes:

- `namespace.yaml`
- `postgres-deployment.yaml`, `postgres-pvc.yaml` (synology-csi), `postgres-service.yaml` — copy from `~/homelab/apps/miniflux/`, `postgres:18`.
- `migrate-and-sync` `cronjob.yaml` — schedule `30 3 * * *`, image `ghcr.io/devbydaniel/vitals:<first release>`, command runs migrations then sync; env from secret; pattern `~/homelab/apps/restic-backup/cronjob.yaml`.
- `grafana-deployment.yaml` + `grafana-pvc.yaml` + provisioning ConfigMaps: Postgres datasource (read-only user or the app DSN), dashboard provider pointing at `/var/lib/grafana/dashboards`; env: anonymous Viewer enabled, admin password from secret.
- `grafana-service.yaml` — `type: LoadBalancer`, `loadBalancerClass: tailscale`, `tailscale.com/hostname: vitals` (pattern: miniflux).
- `secret.yaml` — SOPS-encrypted: `POSTGRES_USER/PASSWORD/DB`, `DATABASE_URL`, `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET`, `HEARTBEAT_URL`, `GF_SECURITY_ADMIN_PASSWORD`. Generate real random passwords; Oura client id/secret get placeholder values until Daniel registers the app (step 10).
- `kustomization.yaml`; register `vitals` in `~/homelab/apps/kustomization.yaml`.

**Tests/Validation:**

```bash
kubectl kustomize ~/homelab/apps/vitals && sops -d ~/homelab/apps/vitals/secret.yaml > /dev/null
```

**DO NOT touch:** other `~/homelab/apps/*` dirs, `~/homelab/infrastructure/`, `~/dev/dbd/vitals/src/`

### Step 9 — Grafana dashboards

**Scope:** ONLY `~/homelab/apps/vitals/dashboards/` (JSON) + the dashboard ConfigMap + `~/homelab/apps/vitals/kustomization.yaml` (configMapGenerator)

**Creates:** three dashboard JSONs reading the step-6 views (read the `dataviz` skill before designing panels):

1. `today.json` — current readiness/sleep/activity vs 30-day baseline bands, HRV + RHR vs baseline.
2. `sleep.json` — duration + stages stacked, efficiency, sleep debt, bedtime consistency heatmap.
3. `trends.json` — 90-day rolling scores, weekly deltas, resilience / cardiovascular age / VO2max long-term.

**Validation:**

```bash
kubectl kustomize ~/homelab/apps/vitals && for f in ~/homelab/apps/vitals/dashboards/*.json; do jq empty "$f"; done
```

**DO NOT touch:** `~/dev/dbd/vitals/`, other homelab apps

### Step 10 — Deploy, bootstrap, verify (needs Daniel)

**Scope:** pushes + cluster operations + `~/homelab/apps/vitals/secret.yaml` (real Oura creds)

1. Push vitals repo to GitHub (`devbydaniel/vitals`), let CI release and publish the image; make the ghcr package public.
2. Push homelab changes; Flux reconciles; postgres + grafana come up (cronjob will fail until tokens exist — expected).
3. **Daniel:** register the API application at <https://cloud.ouraring.com/oauth/applications> (redirect URI `http://localhost:8484/callback`), hand over client id/secret → update SOPS secret.
4. **Daniel:** run the auth CLI locally with `kubectl port-forward -n vitals svc/vitals-postgres 5432` — one browser consent.
5. `kubectl create job --from=cronjob/vitals-sync -n vitals sync-manual` → watch backfill; spot-check row counts vs the Oura app.
6. Create the uptime-kuma push monitor (24h+grace expected interval), put its URL in the secret.
7. Open `https://vitals.<tailnet>.ts.net` — dashboards render with real data.

**Validation:** spec's Verification section, items 1–6.

## Follow-ups

- Whoop provider module when/if he re-subscribes (`src/providers/whoop/`, `whoop_*` tables, tokens row `provider='whoop'`, cross-provider views only where semantics align).
- Consider a read-only Postgres user for Grafana instead of the app DSN.
- Renovate will bump the image tag in the homelab repo once the first release exists — confirm it picks up `ghcr.io/devbydaniel/vitals`.
