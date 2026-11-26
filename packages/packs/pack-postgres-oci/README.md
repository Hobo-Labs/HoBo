# @hobo/pack-postgres-oci

PostgreSQL as an **implementation pack**: upstream PostgreSQL, pinned by digest,
running on compute the operator already owns, satisfying the same
`data.postgres/v1` capability profile a managed database product would.

This package exists to make one claim falsifiable. `data.postgres/v1` is only a
portability boundary if something other than a SaaS vendor can satisfy it. Here,
`realization` is `"pack"`, ownership is `yard-owned`, `sponsorExposureMinorUnits`
is `0`, and there is no provider account in the story at all.

`pack.postgres.oci/v1` — implements `data.postgres/v1` and, by refinement,
`data.relational/v1`, on `oci`, `vm_iaas`, and `paas` substrates.

## What is in here

- `image.ts` — the pinned digests, the PGDATA path, and the volume mount path.
- `manifest.ts` — `POSTGRES_PACK_MANIFEST_DOCUMENT`, the unsigned pack manifest,
  plus `createPostgresPackManifest(signature)` and
  `POSTGRES_PACK_PAYLOAD_DIGEST` (the digest a signer must cover).
- `credentials.ts` — `provisionPostgresSuperuserCredential` /
  `provisionPostgresApplicationCredential`: custody mints, this package receives a
  locator.
- `deployment.ts` — `buildPostgresContainerSpec`: verified manifest plus parsed
  configuration in, container spec out.
- `binding.ts` — `buildPostgresBinding`: produces `binding.postgresql/v1`.
- `operations.ts` — `buildPgDumpArgv`, `buildPgRestoreArgv`,
  `buildPgDumpMigrationPlan`, `buildVacuumAnalyzeArgv`, `runPostgresCommand`.
- `catalog.ts` — `postgresPackCandidate`: the Resource Definition vNext / selection
  projection.
- `conformance.ts` — `POSTGRES_CONFORMANCE_CASES`.

## The pinned image

| Field | Value |
| --- | --- |
| Repository | `docker.io/library/postgres` |
| Resolved from tag (provenance only) | `18-alpine` |
| Image index digest | `sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15` |
| `linux/amd64` manifest digest | `sha256:b6a16ed0eb96e2c362811f7eeb951eac8b459e7b40be4149ea5444aa7c65569b` |
| `linux/arm64` manifest digest | `sha256:122c9942437efcbbb8d595fc578dee7d26ee1543c2a8634d183adfa4a1e55b4d` |
| Server version (`PG_VERSION` in the amd64 config blob) | `18.4` |

The **per-platform manifest digest** is what gets pinned, not the index digest. The
index is what a `docker pull` resolves, but it is one more indirection between the
pack and the bytes that run, and the pack already knows the architecture it is
deploying to. The tag is recorded as provenance and is unusable: `parsePinnedImageRef`
rejects any reference carrying one.

Only `linux/amd64` and `linux/arm64` are pinned. The index also lists
`linux/arm/v6`, `linux/arm/v7`, `linux/386`, `linux/ppc64le`, `linux/riscv64`, and
`linux/s390x`; copying those digests in would be advertising support nobody has
exercised, so `ARCHITECTURE_UNSUPPORTED` is the answer for them.

## Persistence is required, and a missing volume is an error

`persistence.requirement` is `"required"`, the `dataVolume` configuration key is
required, and the declared volume sets `externalStorageAllowed: false`. Three
consequences:

- a configuration with no storage bound raises `PACK_PERSISTENCE_REQUIRED` — there
  is no default to fall through to, because the default would be an ephemeral
  container filesystem holding a database;
- an object store cannot satisfy the gate, because PostgreSQL cannot put PGDATA on
  one;
- the volume is `single-writer`: PostgreSQL takes an exclusive lock on its data
  directory, so two servers on one directory is corruption rather than contention.

PostgreSQL 18 images moved `PGDATA` to `/var/lib/postgresql/18/docker` and moved
the declared `VOLUME` up to the parent `/var/lib/postgresql`, so that
`pg_upgrade --link` can see both major versions. Mounting the pre-18
`/var/lib/postgresql/data` path against this image gives you a server whose data
directory is *not* on the volume. Both paths are pinned as constants and the CUE
model asserts PGDATA sits underneath the mount path, so an image bump that moves
either one fails validation instead of quietly writing to scratch space.

## Credentials never exist in this process

`provisionPostgresSuperuserCredential` asks custody to **mint** the password and
gets back a `SecretRef`. The container receives it as a file:

```
POSTGRES_PASSWORD_FILE=/run/secrets/postgres-superuser   (mode 0400)
```

not as `POSTGRES_PASSWORD`, because an environment variable is visible in
`/proc/<pid>/environ` and in every `docker inspect` output, and not as argv,
because argv is world-readable through `ps`. `hostAuthMethod` offers
`scram-sha-256` and `md5`; `trust` is deliberately not a member of the enum, so a
configuration cannot express an unauthenticated server.

## Operations are argv arrays

`PackOperation.shell` is the literal `false`, and every builder returns a
`PostgresCommand` whose `argv` is a string array with `secretEnv` carrying
locators:

```ts
const command = buildPgDumpArgv({
  endpoint: {
    host: "pg-1.yard-1.hobo.test",
    port: 5432,
    database: "appdb",
    role: "appowner",
    sslMode: "require",
    passwordRef: superuserRef, // a SecretRef, not a password
  },
  outputPath: "/var/backups/appdb.dump",
});
// command.argv     → ["pg_dump", "--host", …, "--no-password", "--format=custom", …]
// command.secretEnv → { PGPASSWORD: "hobo-secret://…" }
```

`runPostgresCommand(runner, resolver, command)` is the only place a password
exists: it resolves each locator into the child process's environment object at
the moment of spawn, re-asserts argv safety, and returns the process result. The
`PostgresCommand` itself holds no material, so it is safe to log, to store in an
event, or to put in a plan a human reviews.

`migration.postgres.pg-dump/v1` is a **pair** of commands, not a pipeline. A shell
pipeline would need a shell, and `pg_dump … | pg_restore …` also loses the dump's
exit status. `buildPgDumpMigrationPlan` refuses a plan whose source and target
endpoints are identical — a migration that moves nothing is a mistake, not a
no-op.

A database named `x; rm -rf /` is accepted where PostgreSQL identifier rules allow
it and inert either way, because there is no shell to interpret it. What is
rejected is a credential in argv (`PACK_ARGV_UNSAFE`), NUL, and control
characters.

## Parse, don't validate

Untrusted input crosses one boundary and becomes a **derived type**; every function
downstream takes the derived type and re-checks nothing:

| Raw input | Derived type | Impossible afterwards |
| --- | --- | --- |
| `string` | `PostgresIdentifier` (branded) | a 64-byte-truncated or quote-bearing identifier reaching argv |
| `string` | `PostgresFilePath` (branded) | a relative path, or `..` traversal, as a dump target |
| `{ host, port, database }` | `PostgresEndpoint` | a port outside 1–65535, a connection string in the host field |
| manifest document | `ParsedPackManifest` → `VerifiedPackManifest` | deployment before signature and digest verification |
| config record | `ParsedPackConfiguration` | a persistent pack with no volume, an undeclared key, a plaintext password |
| locator `string` | `SecretRef` (from `@hobo/bindings`) | a connection string travelling as a "ref" |
| builder options | `PostgresCommand` | a shell string, or a credential in argv |

The proto messages in `data-models/` are the **wire form**; the branded types in
`src/` are narrowings of those fields, never parallel declarations of them.

## Command / event / actor / event-store story

This package is pure description: it builds specs, argv arrays, and bindings.
Reaching the durable control plane is the host's job, and it happens the same way
as for any other HoBo capability.

- **Commands** — a Yard **actor** per database instance accepts
  `ProvisionPostgresPack`, `StartPostgresWorkload`, `RunPostgresOperation`
  (backup / restore / migration / maintenance), `RotatePostgresCredential`, and
  `MigratePostgresOwnership`. Every command carries the pack version and the
  verified image digest, so a replay targets the artifact the operator actually
  approved rather than whatever `18-alpine` points at today.
- **Events** — the actor emits `pack.WorkloadStarted` (digest, architecture, bound
  volume), `postgres.DatabaseInitialised`, `postgres.BindingIssued` (locator only),
  `postgres.BackupCompleted` (artifact path, byte count, exit code),
  `postgres.MigrationCompleted`, `pack.CredentialRotated`,
  `pack.ConformanceRecorded`. Bodies are the records in
  `data-models/pack_postgres_oci.proto`, so an event never contains credential
  material — only `*_secret_ref` locators.
- **Event store** — the host appends to the durable SQLite-backed **event store**
  under per-stream OCC with a fencing token, so a superseded writer cannot append
  after the workload has moved. Container and `pg_dump` effects run **outside** the
  store transaction and are keyed by idempotency, so a retried
  `RunPostgresOperation` does not produce a second dump.
- **Projections / materialized views** — the stream folds into the **materialized
  views** the CLI and catalog read: the deployed-instances view (digest, volume,
  database, role, max connections), the backup-history view, and the
  conformance-outcome view keyed by profile and image digest. The catalog
  **projection** is exactly what `postgresPackCandidate` produces, which is why
  selection can honour `allowPack: false` without consulting a second registry.
- **Snapshots / read store** — periodic **snapshots** of the instance aggregate back
  the **read store** that answers `hobo status`; historical snapshots keep "which
  digest was this database last verified against" auditable after a re-pin, and the
  last backup snapshot is what a restore plan is built from.

## Contracts

- `data-models/pack_postgres_oci.proto` — durable records: image pin, volume
  binding, deployment, operation invocation, migration pair, issued binding,
  conformance evidence.
- `data-models/pack_postgres_oci.cue` — the invariants: digests are digests, PGDATA
  sits inside the mount path, `local-volume` is the only storage kind, no credential
  in argv, the executable is one of this pack's tools, a migration's endpoints
  differ, and TLS implies a certificate locator.
- `contracts/pack-postgres-oci-yard-executor.pact.json` — the boundary with the Yard
  container executor: a digest-pinned deploy with a bound volume, the refusal of a
  deploy with no persistence, an argv readiness probe, an argv backup with the
  credential in `secretEnv`, the refusal of argv containing a credential, and the
  issued binding.

## Conformance evidence, stated precisely

`POSTGRES_CONFORMANCE_CASES` covers version reporting, presence of `pg_dump` /
`pg_restore`, wire-protocol connectivity, transaction rollback, primary-key
enforcement, survival of a workload restart, and refusal of an unauthenticated
connection.

**Every case is marked `container-runtime`**, including the version checks: those
binaries live inside the image, so running them is running the image.
`offlineCases(POSTGRES_CONFORMANCE_CASES)` is therefore empty, and the mandatory
test lane replays recorded outcomes through
`createReplayConformanceRunner`. The manifest reports
`conformance.executedAgainstContainer: false` for exactly this reason: **nothing
in this repo has started this image**, so the `pass` outcome in the manifest is a
declared expectation backed by replay fixtures, not observed container evidence.
Treat it as unverified until the opt-in container lane runs it.

## Sources

| Fact | Source | Checked |
| --- | --- | --- |
| Image index digest and the two per-platform manifest digests for `postgres:18-alpine` | Docker Hub registry API (`registry-1.docker.io/v2/library/postgres/manifests/18-alpine`) | 2026-08-08 (fetched) |
| `PG_VERSION=18.4`, `PG_MAJOR=18`, `PGDATA=/var/lib/postgresql/18/docker`, `VOLUME /var/lib/postgresql`, `EXPOSE 5432` | config blob of the pinned `linux/amd64` manifest, read from the same API | 2026-08-08 (fetched) |
| `POSTGRES_PASSWORD_FILE` / `POSTGRES_USER_FILE` / `POSTGRES_DB_FILE` are supported by the official image entrypoint | <https://github.com/docker-library/docs/blob/master/postgres/content.md> | 2026-08-08 (not fetched — **unverified**; the variables are also visible in the pinned image's entrypoint script, which is why they are used here) |
| `pg_dump` / `pg_restore` option names and `PGPASSWORD` handling | <https://www.postgresql.org/docs/current/app-pgdump.html> | 2026-08-08 (not fetched — **unverified**) |
| The frontend/backend protocol `data.postgres/v1` asserts | <https://www.postgresql.org/docs/current/protocol.html> | 2026-08-08 (not fetched — **unverified**) |
| Upstream build revision for the pinned image | — | **not asserted**: the digests came from the registry, not from a build record, so `provenance.sourceRevision` is `"unverified"` rather than an invented commit sha |

## Licence

MIT — see [LICENSE](LICENSE).
