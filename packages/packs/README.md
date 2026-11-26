# Implementation packs

An **implementation pack** is a capability HoBo can satisfy without a provider
account: a digest-pinned OCI image, the readiness and storage facts needed to run
it, the argv-array operations that back it up and migrate it, and the signed
provenance that says where the bytes came from. Packs are what make the
anonymous, claimable deployment plane (ADR-0151) work when nobody has signed up
for anything yet — the workload runs on compute the operator already owns, and
ownership migrates later rather than a provider account being transferred.

| Package | What it is |
| --- | --- |
| [`pack-framework`](pack-framework/README.md) | The pure core: manifest parsing, signature verification, configuration parsing, conformance case model, catalog semantics. Holds no state and performs no I/O. |
| `pack-postgres-oci` | The PostgreSQL capability pack: pinned image digests, the PGDATA volume binding, credential provisioning, `pg_dump`/`pg_restore` operations, and the `binding.postgresql/v1` it produces. |
| `pack-valkey-oci` | Reserved for the Valkey capability pack. Scaffolding only today — no source, no manifest, and therefore no records or contracts of its own. |

## Data models and contracts

`packs/` is a category directory, not a package: each subdirectory owns its own
`data-models/` and `contracts/` folder, the same way `packages/adapters/*` and
`packages/providers/*` do.

| Path | Contents |
| --- | --- |
| `pack-framework/data-models/pack_framework.proto` / `.cue` | Manifest, image, probe, volume, config-field, operation, provenance, signature, and conformance records, plus the invariants that keep them honest. |
| `pack-framework/contracts/pack-framework-oci-registry.pact.json` | Framework ⇄ OCI Distribution registry: manifest pull **by digest**, `Docker-Content-Digest` verification, and the interaction where the returned digest disagrees with the requested one. |
| `pack-postgres-oci/data-models/pack_postgres_oci.proto` / `.cue` | The PostgreSQL pack's durable shapes: the image pin a deployment ran, the PGDATA volume binding, one argv operation invocation, a dump/restore pair, the emitted binding, and recorded conformance evidence. |
| `pack-postgres-oci/contracts/pack-postgres-oci-yard-executor.pact.json` | PostgreSQL pack ⇄ the Yard executor that starts the container and runs its operations. |

The shared scalars (`#Sha256`, `#IsoDate`, `#AbsolutePath`) are spelled
identically in each pack's CUE file rather than shared from one, because a CUE
file in another directory is a different package. A pack that spelled a digest
differently from the framework that verifies it would be the exact defect these
constraints exist to prevent, so the identical spelling is load-bearing.

## Parse, don't validate

Every input crosses one parse boundary and comes back as a derived domain type —
`ParsedPinnedImageRef`, `ImageDigest`, `ParsedPackManifest`,
`VerifiedPackManifest`, `ParsedPackConfiguration`, `PostgresEndpoint`,
`PostgresIdentifier`, `PostgresFilePath` — and every function downstream accepts
the parsed type. A tag can therefore not reach a pull, an unverified manifest can
not reach an execution, and an unparsed identifier can not reach an argv array,
because none of those states is representable past the boundary rather than
because something re-checks them. The protobuf records in `data-models/` are the
wire projection of these parsed types; the branded TypeScript types are
narrowings of them, never a second source of truth.

## Event architecture

Packs are a pure core, so nothing here appends anything. The durable behaviour
belongs to the Yard pack-instance **actor**, which is what the outputs of these
packages feed:

- **Commands** — the actor accepts `InstallPack`, `StartPackWorkload`,
  `RunPackOperation`, `RotatePackCredential`, and `MigratePackOwnership`. Each
  carries the pack id, pack version, and the verified image digest that
  `pack-framework` produced, so a command is replayable against one artifact
  rather than against "latest". A pack claimed later also drives the
  `@hobo/claims` coordinator actor's `BeginClaimItem` / `VerifyOwnership` /
  `RotateCapabilityBinding` commands.
- **Events** — the actor emits `pack.Verified`, `pack.WorkloadStarted`,
  `pack.OperationCompleted`, `pack.ConformanceRecorded`,
  `pack.CredentialRotated`, and `pack.OwnershipMigrated`. Their bodies are the
  records in `data-models/`, which is why no event body can carry credential
  material: every credential field in those records is a `*_secret_ref` locator.
- **Event store** — the host appends to the durable SQLite-backed **event store**
  under per-stream OCC and a fencing token, so a stale writer cannot append after
  the workload moved. Container and registry effects happen outside that
  transaction, keyed by idempotency, so a retry starts nothing twice.
- **Projections / materialized views** — the stream folds into the
  **materialized views** the CLI and catalog read: installed packs with their
  pinned digests, the current conformance outcome per profile claim, and the
  volume-to-storage map. The catalog view is exactly what
  `toPackResourceSemantics` produces, which is why selection can gate on
  `realization: "pack"` without a second registry.
- **Snapshots / read store** — periodic **snapshots** of the pack-instance
  aggregate back the **read store** that answers `hobo status`; historical
  snapshots keep the digest a resource was last verified against auditable after
  the image is re-pinned.

## Tests

```bash
pnpm --filter @hobo/pack-framework run test
pnpm --filter @hobo/pack-postgres-oci run test
```

Offline and deterministic. No registry is contacted, no container is started, and
every digest in fixtures and contracts is a synthetic value rather than a real
published image digest.
