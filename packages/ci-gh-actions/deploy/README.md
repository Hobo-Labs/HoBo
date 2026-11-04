# Deploy a HoBo CI relay partition

The image runs the actual GitHub App relay as UID/GID 1000 on Node 24. It builds
only the relay's workspace dependency closure with the committed frozen pnpm
lockfile and filtered Turbo build, then copies production dependencies into the
runtime image. The digest-pinned base includes `flock`; the service holds an OS
lock beside its database for its process lifetime.

One partition has one process and one SQLite directory. Compose uses a persistent
named volume; Kubernetes uses one replica, `Recreate`, a `ReadWriteOnce` PVC and
filesystem group 1000. This provides durable restart recovery, not multi-writer HA.
Do not scale the deployment or share its journal with another independently
configured partition. Use separate databases and budget partitions when adding
capacity; reconcile active leases before moving budget ownership.

## Configuration and secrets

Create an account configuration using [`../examples/config.json`](../examples/config.json)
and the [relay setup contract](../README.md). The sample offers are deliberately
disabled. Set real repository, App and provider bindings and fresh allocation
evidence before admitting jobs. Mount these files; do not bake credentials into
an image or commit them:

| Setting | Container path or value |
| --- | --- |
| `HOBO_CI_CONFIG` | `/etc/hobo-ci/config.json` |
| `HOBO_CI_DB` | `/var/lib/hobo-ci/relay.sqlite` |
| `HOBO_CI_PUBLIC_URL` | Public HTTPS origin, without a path; local HTTP requires the explicit loopback-only mode below |
| `HOBO_CI_GITHUB_APP_ID` | GitHub App identifier |
| `HOBO_CI_GITHUB_APP_KEY_FILE` | `/run/secrets/github-app-key.pem` |
| `HOBO_CI_WEBHOOK_SECRET_FILE` | `/run/secrets/webhook-secret` |
| `HOBO_CI_CONTROL_TOKENS_FILE` | `/run/secrets/control-tokens.json` |
| `HOBO_CI_INGRESS_FORWARD_SECRET_FILE` | Optional; required when a central ingress forwards webhooks with `X-Hobo-Ingress-Forward` |
| `HOBO_CI_TRUST_PROXY` | Set `1` when TLS terminates at a reverse proxy that sets `X-Forwarded-Proto` |
| `HOBO_CI_HOST` / `HOBO_CI_PORT` | `0.0.0.0` / `8787` inside the container |

Box-worker resource settings are resolved once at daemon startup. The class limits, aggregate admission
budget, merge-group lease cap, job-side caps and storage-pressure settings are documented with the other
non-secret worker settings below. Excess merge-group jobs remain queued without blocking push jobs; each
waiting job logs `hobo_ci_merge_group_cap_wait` once.

`HOBO_CI_CONFIG` seeds a new empty partition. An existing database retains its
revisioned configuration; replacing the seed file does not override it on restart.
Use the authenticated account policy API described in the [relay README](../README.md)
for later changes, with its current ETag/`If-Match` revision.

The account-token file holds token SHA-256 digests, account IDs, permitted
installation IDs and scopes; its plaintext bearer tokens stay with the authorized
clients. The GitHub App private key and webhook secret remain secrets even when
the account-token file contains only hashes. Ensure mounted files are readable by
UID/GID 1000. On Compose hosts, file-backed secrets are bind mounts: ownership and
mode must be set on the source files. Use mode `0400` with owner 1000, or `0440`
with group 1000. Kubernetes projects secrets with mode `0440` and `fsGroup: 1000`.
After rotating source files, recreate the Compose relay or restart the Kubernetes
deployment so the process reads the new credentials. Keep the old credentials
valid until the replacement is ready, then revoke them with their issuer.

Repository environment profiles can declare required secret names for deployment
and execution, without embedding values. Use the `check-secrets` preflight in
the [repository environment guide](../README.md#repository-and-organization-environments)
with a trusted secret directory for the selected environment and phase. The
preflight checks only the declared files; it does not provision them, configure
these container mounts, or automatically gate deployment. Configure the actual
relay bindings above independently, and include all credentials needed by your
chosen backend in your declarations.

## Build and start with Compose

Run from the repository root:

```sh
pnpm --filter @hobo/ci-gh-actions deploy:check
docker build -f packages/ci-gh-actions/deploy/Dockerfile -t hobo-ci-relay:local .
```

In a managed build environment with a TLS proxy, add
`--secret id=proxy_ca,src="$CODEX_PROXY_CERT"` to the build command. The certificate
is an ephemeral build mount and is not copied into the image.
Keep certificate verification enabled. Runtime proxy deployments must separately
mount their CA read-only and set `NODE_EXTRA_CA_CERTS` to that file. Node uses
`--use-env-proxy` so the configured proxy environment is honored.

Store these non-secret selectors in a private deployment environment file, using
absolute host paths. The secret file contents stay out of this file:

```dotenv
HOBO_CI_PUBLIC_URL=https://ci.example.com
HOBO_CI_GITHUB_APP_ID=12345
HOBO_CI_CONFIG_FILE=/srv/hobo-ci/config.json
HOBO_CI_GITHUB_APP_KEY_PATH=/srv/hobo-ci/secrets/private-key.pem
HOBO_CI_WEBHOOK_SECRET_PATH=/srv/hobo-ci/secrets/webhook-secret
HOBO_CI_CONTROL_TOKENS_PATH=/srv/hobo-ci/secrets/control-tokens.json
HOBO_CI_DATA_VOLUME=hobo-ci-data
HOBO_CI_IMAGE=hobo-ci-relay:local
```

For an isolated box worker, class limits and admission share one budget. The worker refuses to start unless every
general class fits outside the trunk reservation and the heavy trunk class fits the full budget. These are
non-secret settings:

| Worker variable | Default | Purpose |
|---|---|---|
| `HOBO_CI_WORKER_MEMORY_BUDGET_MB` | host/cgroup total minus reserve | Sum available to active, reserved and warm containers; explicit values cannot exceed this ceiling |
| `HOBO_CI_WORKER_MEMORY_RESERVE_MB` | `2048`, minimum `2048` | Host, daemon, Docker and page-cache headroom subtracted from the budget ceiling |
| `HOBO_CI_WORKER_MEMORY_CLASS_LIGHT_MB` | `3072` | Exact-name guard/lint/contract jobs |
| `HOBO_CI_WORKER_MEMORY_CLASS_STANDARD_MB` | `4096` | Unlisted jobs and the pre-warmed container |
| `HOBO_CI_WORKER_MEMORY_CLASS_HEAVY_MB` | `HOBO_CI_WORKER_MEMORY_MB` or `6144` | Turbo build/test and image jobs; trunk reservation |
| `HOBO_CI_WORKER_MEMORY_MB` | unset | Backward-compatible heavy-class override; the startup check still applies |
| `HOBO_CI_WORKER_MEMORY_HOL_MS` | `60000` | Time smaller same-rank jobs may backfill behind a non-fitting head job |
| `HOBO_CI_WORKER_MERGE_GROUP_LEASES` | `1` | Maximum active merge-group leases; zero and invalid values are rejected |
| `HOBO_CI_WORKER_WORK_ROOT` | `${XDG_STATE_HOME:-~/.local/state}/hobo-ci/work` | Host per-job work mounts, teardown and pressure checks; same filesystem as pnpm store |
| `HOBO_CI_PNPM_STORE_DIR` | `~/.cache/hobo-ci/pnpm-store` | Shared store mounted read-write at `/pnpm-store`; empty disables it |
| `HOBO_CI_WORKER_GC_MS` | `300000` | Scheduled image/builder/store/dead-workdir GC interval; minimum 60000, capped at 300000 |
| `HOBO_CI_WORKER_BUILDER_CACHE_CAP` | `4GB` | Hard BuildKit cache cap with no age exemption; `HOBO_CI_WORKER_BUILDER_KEEP_STORAGE` remains a deprecated alias |

The admitted request becomes the container's `--memory` and `--memory-swap` value and its
`HOBO_CI_JOB_MEMORY_MB` environment variable. On the 15989 MiB box with a 2048 MiB reserve, the admission
budget is **13941 MiB**. Heavy + standard + light = **13312 MiB** fits three slots; two heavy jobs leave
**1653 MiB**, so a third light job waits; three heavy jobs need **18432 MiB** and never fit together.

Job preflight reserves 768 MiB for native/non-heap memory, then chooses
`workers = max(1, min(cpuCount, floor((limit - 768) / 1280) - 1))` and
`heap = min(3072, floor((limit - 768) / (workers + 1)))`. It exports that heap through `NODE_OPTIONS`,
always exports `HOBO_TURBO_CONCURRENCY=1`, and exports the worker count through `HOBO_TEST_MAX_WORKERS`.
This keeps `(workers + 1) × heap + 768 <= limit`, including the turbo/Vitest parent's heap. It never exports
`VITEST_MAX_WORKERS`, preserving configs that pin one worker or disable file parallelism.

| Class | Container limit | Node heap per process | Max Vitest workers |
|---|---:|---:|---:|
| `light` | 3072 MiB | 1152 MiB | 1 |
| `standard` | 4096 MiB | 1664 MiB | 1 |
| `heavy` | 6144 MiB | 1344 MiB | 3 |

Each job bind-mounts its host work directory and teardown deletes it, including `node_modules`, after pass,
failure, cancellation, crash or timeout. Startup reaps only directories with no active lease or container.
All jobs install from the shared `/pnpm-store` with `npm_config_package_import_method=hardlink`; cross-filesystem
store/work-root configurations fail startup. Jobs never prune the store. The daemon prunes it only with no
active job, and runs scheduled GC at least every five minutes for fetch intermediates, old deps images (two
newest plus `local` and in-use images retained), old worker images (current and previous content keys plus
`local` and in-use images retained), dangling images and builder cache. BuildKit has a hard 4 GB default cap
with no age exemption. Byte or inode usage above **85%** triggers the same GC before admission. Usage still
above **95%** blocks admission and logs `hobo_ci_inode_pressure` once per episode.
See [the runner queue guide](../../ci/RUNNER-QUEUE.md) for operations and admission logs.

For a release, publish the tested image to your registry and replace
`HOBO_CI_IMAGE` with its immutable `registry/image@sha256:...` reference. The local
tag is for building and checking these assets, not a moving production release.

```sh
docker compose --env-file /srv/hobo-ci/deploy.env -f packages/ci-gh-actions/deploy/compose.yml config --quiet
docker compose --env-file /srv/hobo-ci/deploy.env -f packages/ci-gh-actions/deploy/compose.yml up --no-build -d
curl --fail http://127.0.0.1:8787/readyz
docker compose --env-file /srv/hobo-ci/deploy.env -f packages/ci-gh-actions/deploy/compose.yml logs --tail=100 relay
```

Compose publishes HTTP only on loopback. Put a certificate-managing reverse proxy
on the same host, forwarding the public HTTPS origin to `127.0.0.1:8787`. For
example, an installed Caddy service can use this Caddyfile, with its normal
persistent certificate storage:

```caddyfile
ci.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Supply your own hostname and point DNS at that proxy before enabling GitHub
webhook delivery. HTTPS terminates at the proxy; the relay does not issue
certificates. Verify the public `/readyz` URL and webhook signature handling.
Keep the control API behind its account-scoped bearer authorization as well.

## Local development

The URL used by a local control client can differ from the GitHub-facing public
URL. The Compose manifest listens inside the container and publishes its HTTP
port on host loopback only. A local client can therefore use
`http://127.0.0.1:8787` with `allowInsecureLoopback: true`; credentials remain
in the local token binding rather than in the project configuration. Use a
separate local configuration and `HOBO_CI_DATA_VOLUME=hobo-ci-local` so its
budget and lease journal are independent of a hosted environment.

For offline development with simulated GitHub delivery, `HOBO_CI_PUBLIC_URL`
can be a reserved HTTPS origin such as `https://local.invalid`. This is an
identity placeholder; GitHub cannot deliver webhooks or reach runner callbacks
at that address. To receive real GitHub events, set `HOBO_CI_PUBLIC_URL` to a
public HTTPS tunnel or reverse proxy pointing to the local container, and
register that public URL with the GitHub App. The repo-local control endpoint
can remain `http://127.0.0.1:8787`.

The standalone relay currently runs its trusted companion-workflow bridge for
private repositories. It does not provide the Vercel adapter's isolated Sandbox
host for public-repository or pull-request jobs. Use the hosted isolated relay
for those jobs; changing the control endpoint does not add a runner backend.

A relay process bound directly to loopback can instead opt into an HTTP public
origin by setting `HOBO_CI_PUBLIC_URL=http://127.0.0.1:8787`,
`HOBO_CI_HOST=127.0.0.1`, and `HOBO_CI_ALLOW_INSECURE_LOOPBACK=1`. This mode
rejects wildcard and non-loopback listeners and binds `localhost` to numeric
loopback without DNS resolution. Use the listener's port in the public URL
unless a local proxy maps it separately. This mode works in a container with
host networking where supported; the normal Compose bridge listener uses the
separate public HTTPS URL described above. GitHub still cannot reach a loopback
address, so use the public HTTPS tunnel mode for real GitHub traffic.

## Kubernetes

Use an existing namespace and a storage class that supports local SQLite locking
and durable filesystem writes. Avoid network filesystems with incompatible
locking. Create the configuration and secret bindings from files without printing
their contents:

```sh
kubectl create configmap hobo-ci-config --from-file=config.json=/srv/hobo-ci/config.json --from-literal=public-url=https://ci.example.com
kubectl create secret generic hobo-ci-secrets --from-literal=app-id=12345 --from-file=private-key.pem=/srv/hobo-ci/secrets/private-key.pem --from-file=webhook-secret=/srv/hobo-ci/secrets/webhook-secret --from-file=control-tokens.json=/srv/hobo-ci/secrets/control-tokens.json
```

Replace the manifest's `hobo-ci-relay:local` image with your tested immutable
registry digest before applying it:

```sh
kubectl apply -f packages/ci-gh-actions/deploy/kubernetes.yaml
kubectl rollout status deployment/hobo-ci
kubectl get pods -l app=hobo-ci
```

The Service is `ClusterIP` on port 8787. Configure your cluster's existing TLS
Ingress or Gateway to route the public origin to that Service, using its managed
certificate. There is no NodePort or plaintext public LoadBalancer in this
manifest. `/healthz` checks process liveness; `/readyz` includes recovery/readiness
and becomes unavailable while draining. Recreate updates deliberately incur a
brief availability gap. Kubernetes secrets, ingress/certificate provisioning,
registry access and storage lifecycle remain operator-managed infrastructure.

## Box worker deps image

Run `scripts/isolated-worker-daemon.mts` from a checkout that tracks HoBo's default
branch. The daemon reads that checkout's head on startup and every
`HOBO_CI_DEPS_POLL_MS` (default `300000`), recomputing the deps key only when the
head changes. The checkout defaults to the repository containing the daemon script,
independent of the service manager's working directory; set `HOBO_CI_DEPS_ROOT` to
override it. The checkout needs the lockfile importer manifests, including the
pinned ts-autocode submodule.

The daemon and `build-deps.sh` use the checkout's computed
`hobo-ci-worker:<toolchain>` when that image exists. If it is absent, they use the
`hobo-ci-worker:v[0-9a-f]{12}` tag carried by `hobo-ci-worker:local`; the same
selected toolchain prefixes the deps key and labels the image. They fail only when
neither toolchain is available. For a new key, the daemon checks
`hobo-ci-deps:<key>`, tries the corresponding
`ghcr.io/<owner>/<repo>/hobo-ci-deps:<key>` pull, then builds a registry miss with
`build-deps.sh --no-promote`. Builds are single-flight and asynchronous: they do
not block admission or hold a job slot. The process runs under `nice` and `ionice`,
and `HOBO_CI_DEPS_BUILD_MEMORY_MB` (default `4096`, minimum `512`) caps both the
Docker build and its offline verification container. A successful local, pulled,
or built candidate is tagged `hobo-ci-deps:local` and passed to keep-2 GC.
`HOBO_CI_DEPS_IMAGE=` disables both selection and this ensure loop.

Look for `hobo_ci_deps_image_ensure_started` with the selected key before local,
registry, or build work, then `hobo_ci_deps_image_ensure` with
`action=hit|pull|build` after success, and `hobo_ci_deps_image_ensure_failed` with
`retryMs` after failure. Failures are fail-open and retry with one-minute
exponential backoff capped at 15 minutes. Jobs keep using
`hobo-ci-worker:local` until deps promotion succeeds; an image build never
prevents the daemon from admitting other work.

A matching image must also pass a once-per-image-id writability probe as uid/gid
1000 before selection. Failure logs `hobo_ci_deps_image_fallback` with
`reason=unwritable-workdir` and uses the worker image. Selection is disabled when
`HOBO_CI_WORKER_WORK_ROOT` is configured: its per-job bind mount covers
`_hobo_work`, hiding the image's `.git` and `node_modules`, so exporting the deps
key would incorrectly let jobs skip installation.

For immediate recovery from an unwritable promoted image, stop the daemon, run
`docker rmi hobo-ci-deps:local`, and restart it. Alternatively set
`HOBO_CI_DEPS_IMAGE=` (empty) and restart to disable selection and the ensure
loop. Redeploy the fixed daemon and rebuild the image before re-enabling it.

## Backup, restore and stop

The SQLite database, WAL and shared-memory files live together in the persistent
directory. Do not copy only a live database file. The shipped operations CLI uses
SQLite's consistent online backup and refuses an existing output path:

```sh
docker compose --env-file /srv/hobo-ci/deploy.env -f packages/ci-gh-actions/deploy/compose.yml exec -T relay node dist/ops.js backup --database /var/lib/hobo-ci/relay.sqlite --output /var/lib/hobo-ci/backup-20261027.sqlite
docker compose --env-file /srv/hobo-ci/deploy.env -f packages/ci-gh-actions/deploy/compose.yml cp relay:/var/lib/hobo-ci/backup-20261027.sqlite /srv/hobo-ci/backups/backup-20261027.sqlite
```

Choose a new backup filename each time. Keep enough volume space for the snapshot,
copy completed snapshots to encrypted off-host storage, and test restoration.
For Kubernetes, use the same backup command through `kubectl exec` and copy the
completed snapshot with `kubectl cp`.

Restore only while the relay is stopped, into a fresh empty volume. Keep the old
volume and its journal for investigation. The restore command refuses an existing
database. An older snapshot omits launches and spend recorded after its creation.
Fence webhook delivery and provider dispatch, inventory that later activity,
verify its hosts have stopped and reconcile usage against the retained journal
and current provider evidence before restarting admission. If the old journal is
lost, reconstruct that interval from provider records; restoring old balances
does not establish current free allocation or budget headroom. This is an offline
data restore, not automatic failover.

For Compose, stop the service, create a new named volume and mount it
into a one-shot container using the same image and nonroot identity:

```sh
docker compose --env-file /srv/hobo-ci/deploy.env -f packages/ci-gh-actions/deploy/compose.yml stop relay
docker volume create hobo-ci-restored
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --mount type=volume,src=hobo-ci-restored,dst=/var/lib/hobo-ci --mount type=bind,src=/srv/hobo-ci/backups/backup-20261027.sqlite,dst=/run/restore.sqlite,readonly --entrypoint node hobo-ci-relay:local dist/ops.js restore --database /var/lib/hobo-ci/relay.sqlite --input /run/restore.sqlite
```

Use the same immutable image reference used by the service. Make the backup
readable by UID/GID 1000. Set `HOBO_CI_DATA_VOLUME=hobo-ci-restored` in the
deployment environment file. After the activity and budget reconciliation above,
run Compose `up --no-build -d` again and restore webhook delivery. On
Kubernetes, scale the deployment to zero, run the same restore CLI in a one-shot
pod against a fresh PVC, update the data claim, then return to one replica.
Restore does not prove external hosts have stopped: recovery retains ambiguous
running leases as uncertain; reconcile them before releasing reservations or
re-admitting side effects.

`docker compose stop` and Kubernetes termination send SIGTERM. The relay first
withdraws readiness, drains in-flight requests/work, closes SQLite and releases
its process lock. Both manifests allow 90 seconds before forced termination.
After a forced kill, restart recovery preserves uncertain launches rather than
blindly retrying them. A healthy readiness response is service evidence; it does
not certify vendor runner availability or final invoices.
