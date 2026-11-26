# @hobo/pack-valkey-oci

Valkey as an **implementation pack**: upstream Valkey, pinned by digest, running
on compute the operator already owns, satisfying the same
`kv.redis-compatible/v1` capability profile a managed cache product would.

This package exists to make two claims falsifiable. The first is portability:
`kv.redis-compatible/v1` is only a boundary if something other than a SaaS vendor
can satisfy it, so here `realization` is `"pack"`, ownership is `yard-owned`, and
there is no provider account in the story at all. The second is honesty about
what a Redis-compatible server *is*: a store whose durability and key retention
are **configuration**, not a property of the image. The same bytes are a durable
keyspace or a lossy cache depending on three settings, and this pack refuses to
choose them for you.

`pack.valkey.oci/v1` — implements `kv.redis-compatible/v1` and `kv.valkey/v1` on
`oci`, `vm_iaas`, and `paas` substrates.

## What is in here

- `image.ts` — the pinned digests, the mount path, the config path, and the
  credential include path.
- `manifest.ts` — `VALKEY_PACK_MANIFEST_DOCUMENT`, the unsigned pack manifest,
  plus `createValkeyPackManifest(signature)` and `VALKEY_PACK_PAYLOAD_DIGEST`
  (the digest a signer must cover).
- `semantics.ts` — `VALKEY_DURABILITY` / `VALKEY_EVICTION` /
  `valkeyRetentionSemantics`: the four durability modes and eight eviction
  policies with their real guarantees, including worst-case loss.
- `credentials.ts` — `provisionValkeyAuthCredential`: custody mints the
  `requirepass` value, this package receives a locator.
- `request.ts` — `parseValkeyDeploymentRequest` / `buildValkeyDeployment`: the
  parse boundary and the deployment entry point.
- `deployment.ts` — `buildValkeyContainerSpec`: verified manifest plus parsed
  configuration in, container spec (including the rendered config file) out.
- `binding.ts` — `buildValkeyBinding`: produces `binding.redis-protocol/v1`.
- `operations.ts` — `buildValkeyRdbBackupArgv`, `buildValkeyRewriteAofArgv`,
  `buildValkeyReplicaHandoffPlan`, `runValkeyCommand`.
- `catalog.ts` — `valkeyPackCandidate`: the Resource Definition vNext / selection
  projection, computed from the deployment's retention rather than hard-coded.
- `conformance.ts` — `valkeyConformanceCases(durabilityMode)`.

## The pinned image

| Field | Value |
| --- | --- |
| Repository | `docker.io/valkey/valkey` |
| Resolved from tag (provenance only) | `9-alpine` |
| Image index digest | `sha256:ee91f7a174ac4d6a6b0685b3a60e321f0a9dbbb691f9b0e285be2ba1d1be8328` |
| `linux/amd64` manifest digest | `sha256:3fe38a705227d29534a199e876b38d5474dec4d3baca980ac6894df539416562` |
| `linux/arm64` manifest digest | `sha256:5a345cba0feab47d27275e90515580e95a3de3ee00a132efc6f8f8eb67115213` |
| Server version (`VALKEY_VERSION` in the amd64 config blob) | `9.1.1` |

The **per-platform manifest digest** is what gets pinned, not the index digest.
The index is what a `docker pull` resolves, but it is one more indirection
between the pack and the bytes that run, and the pack already knows the
architecture it is deploying to. The tag is recorded as provenance and is
unusable: `parsePinnedImageRef` rejects any reference carrying one.

Only `linux/amd64` and `linux/arm64` are pinned. The index also lists
`linux/arm/v7` and `linux/ppc64le`; copying those digests in would advertise
support nobody has exercised, so `ARCHITECTURE_UNSUPPORTED` is the answer for
them.

## Persistence is required, and the image gives you no safety net

`persistence.requirement` is `"required"`, the `dataVolume` configuration key is
required, and the declared volume sets `externalStorageAllowed: false`.

The reason is specific to this image: **it declares no `VOLUME`.** Redis's
official image did; Valkey's does not. A container started without an explicit
mount therefore writes its RDB or AOF into its own filesystem layer and loses it
on removal, with not even an anonymous volume left behind as a consolation. So a
configuration with no storage bound raises `PACK_PERSISTENCE_REQUIRED`, an object
store cannot satisfy the gate (an RDB or AOF is written with ordinary file
semantics), and the volume is `single-writer` because two servers appending to
one AOF is corruption rather than contention.

Cache mode (`durabilityMode: "none"`) still requires the volume. Requiring it in
three modes out of four and quietly dropping it in the fourth would mean a
deployment that changes one enum value silently changes where its files land.

## Durability, eviction, and the data-loss budget

`durabilityMode`, `evictionPolicy`, and `maxmemoryBytes` are **required
configuration with no defaults**, and that is the central design decision of this
package. A default here would be the pack choosing the operator's data-loss
budget for them.

| `durabilityMode` | `appendfsync` | Worst-case loss on an unexpected exit |
| --- | --- | --- |
| `none` | — | the entire keyspace since the last restart |
| `rdb-snapshots` | — | up to 60s of writes (the tightest schedule this pack renders) |
| `aof-everysec` | `everysec` | about 1s of writes |
| `aof-always` | `always` | no acknowledged write, at the volume's fsync latency |

Eviction is split by what a policy is allowed to discard. The `allkeys-*`
policies can evict a key that was never given a TTL, so a client that wrote a key
and read it back a moment later may not find it; the `volatile-*` policies only
discard keys carrying a TTL; `noeviction` refuses the write with an error
instead. `valkeyRetentionSemantics` returns the *combination*, because that is
the interesting fact: `aof-always` with `allkeys-lru` is durable against a crash
and still allowed to throw your key away under memory pressure. `keyLossPossible`
and `behavesAsDurableKeyspace` are carried on the container spec, on the binding,
and into the selection candidate, so a requirement can gate on them rather than
reading the profile name and hoping.

## The credential is a file the config includes, never argv and never an env var

`provisionValkeyAuthCredential` asks custody to **mint** the password and gets
back a `SecretRef`. The container receives it as an included config file:

```
/run/secrets/valkey-requirepass.conf   (mode 0400, contains `requirepass <value>`)
```

`valkey-server --requirepass <value>` would put it in argv, where `ps` shows it to
every process on the host. An environment variable would put it in
`/proc/<pid>/environ` and in every `docker inspect` output. The include is the
only one of the three that keeps it out of both, and it is rendered as the **last
directive** in the file because a later directive wins in a Valkey config — so
nothing above it can override the password away.

## Operations are argv arrays

`PackOperation.shell` is the literal `false`, and every builder returns a
`ValkeyCommand` whose `argv` is a string array with `secretEnv` carrying
locators:

```ts
const command = buildValkeyRdbBackupArgv({
  endpoint: {
    host: "cache-1.yard-1.hobo.test",
    passwordRef: authRef, // a SecretRef, not a password
  },
  outputPath: "/var/backups/cache-1.rdb",
});
// command.argv      → ["valkey-cli", "-h", …, "--no-auth-warning", "--rdb", "…"]
// command.secretEnv → { REDISCLI_AUTH: "hobo-secret://…" }
```

`runValkeyCommand(runner, resolver, command)` is the only place a password
exists: it resolves each locator into the child process's environment object at
the moment of spawn, re-asserts argv safety, and returns the process result. The
`ValkeyCommand` itself holds no material, so it is safe to log, to store in an
event, or to put in a plan a human reviews.

Three operations, and each one is narrower than it looks:

- **`valkey.backup.rdb-dump`** asks the *server* for a fresh RDB (`--rdb`) rather
  than copying the file off the volume. In cache mode there is no file, and in
  snapshot mode the file on disk is as old as the last save, so this is the only
  form of backup that means the same thing in every durability mode.
- **`valkey.maintenance.rewrite-aof`** is refused in `none` and `rdb-snapshots`.
  The server accepts `BGREWRITEAOF` with `appendonly no` and does nothing useful;
  reporting success for a no-op is how a maintenance schedule ends up believing
  it is compacting a file that does not exist.
- **`migration.valkey.replica-handoff/v1`** is **three** commands, not a
  pipeline: attach the target as a replica, ask the target whether its initial
  sync finished, then detach it. The middle step is a real question with a real
  answer instead of a sleep, and it is separate because it is the only step that
  can legitimately fail slowly and be retried on its own.

## Parse, don't validate

Untrusted input crosses one boundary and becomes a **derived type**; every
function downstream takes the derived type and re-checks nothing:

| Raw input | Derived type | Impossible afterwards |
| --- | --- | --- |
| `unknown` deployment body | `ValkeyDeploymentRequest` (via `parseValkeyDeploymentRequest`) | an undeclared config key, a nested object where a scalar belongs, a volume binding with no storage |
| `unknown` | `ValkeyResourceRef` (branded) | a display name travelling as a resource identity |
| `string` | `ValkeyFilePath` (branded) | a relative path, or `..` traversal, as an RDB target |
| `{ host, port, database }` | `ValkeyEndpoint` | a port outside 1–65535, a `SELECT` index outside 0–255, a connection string in the host field |
| manifest document | `ParsedPackManifest` → `VerifiedPackManifest` | deployment before signature and digest verification |
| config record | `ParsedPackConfiguration` | a pack with no volume, an unstated data-loss budget, a plaintext password |
| locator `string` | `SecretRef` (from `@hobo/bindings`) | a `redis://user:pass@host` URL travelling as a "ref" |
| builder options | `ValkeyCommand` | a shell string, or a credential in argv |

`buildValkeyDeployment` accepts the refined `ValkeyDeploymentRequest` and nothing
else, so there is no path from raw input to a container spec that skips the
parse. The proto messages in `data-models/` are the **wire form**; the branded
parsed domain types in `src/` are narrowings of those fields, never parallel
declarations of them.

## Event architecture

This package is pure description: it builds specs, argv arrays, and bindings.
Reaching the durable control plane is the host's job, and it happens the same way
as for any other HoBo capability.

- **Commands** — a Yard **actor** per cache instance accepts
  `ProvisionValkeyPack`, `StartValkeyWorkload`, `RunValkeyOperation` (backup /
  rewrite / handoff), `RotateValkeyCredential`, and `HandOffValkeyKeyspace`.
  Every command carries the pack version and the verified image digest, so a
  replay targets the artifact the operator approved rather than whatever
  `9-alpine` points at today. It also carries the retention settings, because a
  command replayed with a different durability mode is a different deployment.
- **Events** — the actor emits `pack.WorkloadStarted` (digest, architecture,
  bound volume, rendered-config digest), `valkey.RetentionDeclared` (durability
  mode, eviction policy, `keyLossPossible`), `valkey.BindingIssued` (locator
  only), `valkey.BackupCompleted` (artifact path, byte count, exit code),
  `valkey.HandoffCompleted` (source, target, promotion outcome),
  `pack.CredentialRotated`, and `pack.ConformanceRecorded`. Bodies are the
  records in `data-models/pack_valkey_oci.proto`, so an event never contains
  credential material — only `*_secret_ref` locators.
- **Event store** — the host appends to the durable SQLite-backed **event store**
  under per-stream OCC with a fencing token, so a superseded writer cannot append
  after the workload has moved. Container and `valkey-cli` effects run **outside**
  the store transaction and are keyed by idempotency, so a retried
  `RunValkeyOperation` does not produce a second RDB. The handoff is the case that
  needs this most: `REPLICAOF` is idempotent, but promoting twice is not the same
  as promoting once.
- **Projections / materialized views** — the stream folds into the **materialized
  views** the CLI and catalog read: the deployed-instances view (digest, volume,
  maxmemory, databases, retention), the backup-history view, the handoff view,
  and the conformance-outcome view keyed by profile, image digest, and durability
  mode. The catalog **projection** is exactly what `valkeyPackCandidate`
  produces, which is why a cache-mode instance and an `aof-always` instance
  present *different* candidates from the same image, and why selection can
  honour `allowPack: false` without consulting a second registry.
- **Snapshots / read store** — periodic **snapshots** of the instance aggregate
  back the **read store** that answers `hobo status`; historical snapshots keep
  "which digest was this cache last verified against, in which durability mode"
  auditable after a re-pin, and the last backup snapshot is what a restore plan
  is built from.

## Contracts

Records and contracts live in this package, beside the code they describe:

- `data-models/pack_valkey_oci.proto` — durable records: image pin, volume
  binding, retention, rendered config, deployment, probe result, operation
  invocation, handoff, issued binding, conformance evidence.
- `data-models/pack_valkey_oci.cue` — the invariants: digests are digests, the
  data directory is the mounted volume, the `appendfsync` setting agrees with the
  durability mode it claims, only `allkeys-*` may evict an untimed key, a durable
  keyspace excludes both loss routes, the credential include is the last
  directive and the rendered file carries no plaintext, `secret_env` holds one
  locator under one variable, readiness is answered by a command rather than a
  socket, a handoff's endpoints differ, and TLS implies a certificate locator.
  `#Sha256`, `#IsoDate`, `#IsoInstant`, and `#AbsolutePath` are restated from
  `pack_framework.cue` because a CUE file in another directory is a different
  package.
- `contracts/pack-valkey-oci-yard-executor.pact.json` — the boundary with the
  Yard container executor: a digest-pinned deploy with a bound volume and its
  exact rendered config, the cache-mode variant that turns snapshots off
  explicitly, the four refusals (no volume, no stated durability, a maxmemory
  below the floor, a plaintext password, object storage), the readiness probe, an
  argv backup with the credential in `secretEnv`, the refusal of argv mutated to
  carry a credential, the refusal of a rewrite in a snapshot mode, the three-step
  handoff, and the issued binding with its retention metadata.
  `test/contract.test.ts` replays every interaction through the real functions —
  `test/pact-replay.ts` is the dispatcher, and it mocks nothing.

## Conformance evidence, stated precisely

`valkeyConformanceCases(durabilityMode)` covers version reporting, protocol
connectivity plus an answered command, refusal of an unauthenticated command,
per-key expiry, atomic increment, sorted sets, the configured eviction policy,
and restart behaviour.

The restart case takes the durability mode as an input rather than asserting one
outcome: in a mode that claims to survive a restart it asserts the key is still
there, and in cache mode it asserts the key is **gone**. Asserting survival in
cache mode would be a failing test for correct behaviour, and asserting nothing
would leave the loss claim unevidenced.

**Every case is marked `container-runtime`**, including the version check:
`valkey-cli` and `valkey-server` live inside the image, so running them is
running the image. `offlineCases(...)` is therefore empty, and the mandatory test
lane replays recorded outcomes through `createReplayConformanceRunner`. The
manifest reports `conformance.executedAgainstContainer: false` for exactly this
reason: **nothing in this repo has started this image**, so the `pass` outcome in
the manifest is a declared expectation backed by replay fixtures, not observed
container evidence. Treat it as unverified until the opt-in container lane runs
it.

## What this pack deliberately does not claim

There is no `queue.*` or `topic.*` profile in the manifest. `LPUSH`/`BRPOP` looks
like a work queue and streams look like a durable log, but neither carries the
redelivery, visibility-timeout, or consumer-group guarantees those profiles
assert, and this pack has no conformance evidence for them. `test/selection.test.ts`
pins the `PROFILE_INCOMPATIBLE` rejection so the omission stays an omission.
`deliveryGuarantees: "none"` is a literal on the binding for the same reason.

## Sources

| Fact | Source | Checked |
| --- | --- | --- |
| Image index digest and the two per-platform manifest digests for `valkey/valkey:9-alpine` | Docker Hub registry API (`registry-1.docker.io/v2/valkey/valkey/manifests/9-alpine`) | 2026-08-08 (fetched) |
| `VALKEY_VERSION=9.1.1`, `WORKDIR /data`, `EXPOSE 6379`, and the absence of a `VOLUME` declaration | config blob of the pinned `linux/amd64` manifest, read from the same API | 2026-08-08 (fetched) |
| RDB snapshot and AOF `appendfsync` semantics the durability table describes | <https://valkey.io/topics/persistence/> | 2026-08-08 (not fetched — **unverified**) |
| `maxmemory-policy` behaviour the eviction table describes | <https://valkey.io/topics/lru-cache/> | 2026-08-08 (not fetched — **unverified**) |
| `REPLICAOF` / initial-sync semantics the handoff uses | <https://valkey.io/topics/replication/> | 2026-08-08 (not fetched — **unverified**) |
| `REDISCLI_AUTH` is the environment variable `valkey-cli` reads a password from | inherited from `redis-cli` | 2026-08-08 (**unverified** against a live `valkey-cli` build; it is used rather than `-a`/`--pass` because those put the password in argv, and if the variable turns out to be unsupported the fix is a different variable, not a move to argv) |
| Upstream build revision for the pinned image | — | **not asserted**: the digests came from the registry, not from a build record, so `provenance.sourceRevision` is `"unverified"` rather than an invented commit sha |

## Licence

MIT — see [LICENSE](LICENSE).
