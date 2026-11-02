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
