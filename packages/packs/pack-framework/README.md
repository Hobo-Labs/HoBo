# @hobo/pack-framework

Capability-agnostic mechanics for **implementation packs**: the way HoBo satisfies
a capability profile on generic compute instead of buying it from a managed
provider.

A pack is not a Dockerfile with good intentions. It is a **signed, digest-pinned
declaration** of what will run, and this package owns the parts that are the same
for every pack: the manifest type, verification before execution, the projection
into the product catalog, configuration parsing, secret custody, argv
construction, and the conformance harness.

Nothing here starts a container, opens a socket, reads a clock, or generates
randomness. Every effect is an injected port.

## What is in here

- `manifest.ts` — the `PackManifestInput` → `ParsedPackManifest` parse boundary.
  Pinned image digest per architecture, ports, probes, persistence requirements,
  resource bounds, configuration schema, produced binding profiles, backup and
  migration operations, and supply-chain provenance.
- `digest.ts` — `parsePinnedImageRef`. A reference must be
  `<registry>/<path>@sha256:<64 hex>`; a tag is rejected even when a digest is
  present next to it.
- `signature.ts` — `canonicalJson` and `canonicalizeForSigning`, the deterministic
  bytes a signer covers, plus the `PackSignatureVerifier` port. The framework
  never holds a key and never links a crypto library.
- `verification.ts` — `verifyPackManifest`, the only producer of
  `VerifiedPackManifest`.
- `semantics.ts` — `toPackResourceSemantics` / `toPackSelectionCandidate`: the
  Resource Definition vNext projection, always with `realization: "pack"`.
- `config.ts` — `parsePackConfiguration`, which refuses to produce a
  configuration for a persistent pack with no storage bound.
- `custody.ts` — credentials are **minted inside custody**; this process only ever
  holds a `SecretRef`.
- `argv.ts` — `assertArgvSafe`, the last check before a child process is spawned.
- `conformance.ts` — declarative cases plus an injected runner, so the mandatory
  test lane is offline.

## Verification happens before execution, and the type system enforces it

`verifyPackManifest` is the only function that returns `VerifiedPackManifest`, and
every surface that can cause something to run — the conformance harness, the
semantics projection that makes a pack selectable — accepts nothing else. "We
forgot to check the signature before pulling" is a compile error rather than an
incident.

Four rejections, all fail-closed:

| Condition | Error code |
| --- | --- |
| moving tag, malformed digest, missing/untrusted/invalid signature, `unknown` verdict, registry outside the allowlist | `PACK_INTEGRITY_UNVERIFIED` |
| signed payload digest does not match the manifest it arrived with, or an unsupported `schemaVersion` | `PROVIDER_CONTRACT_CHANGED` |
| requested architecture is not pinned by the manifest | `ARCHITECTURE_UNSUPPORTED` |
| conformance outcome is not `pass` | `PACK_CONFORMANCE_FAILED` |

An `unknown` signature verdict is treated exactly like a forged one. A verifier
that cannot reach its key returns `unknown` and the pack does not run; the
alternative is a design where an outage silently disables signing.

The payload that gets verified is recorded at parse time (`signingPayload`) rather
than re-serialized from the parsed view, because the parser sorts arrays and fills
derived fields the signer never saw. `packManifestPayloadDigest` is exported so a
signing tool and this package cannot disagree about what "the manifest" means.

## A pack is never advertised as a managed product

`toPackResourceSemantics` sets three facts itself instead of accepting them:

- `realization` is always `"pack"`, so a `TrustPolicy` with `allowPack: false`
  genuinely excludes packs.
- the claim strategy is the pack's own ownership strategy —
  `hobo.pack-ownership.yard-owned/v1` or
  `hobo.pack-ownership.migrate-on-claim/v1`. `PACK_OWNERSHIP_STRATEGIES` has no
  `provider-claim` member: there is no provider account to transfer a container
  the operator started on their own compute.
- `sponsorExposureMinorUnits` is `0`, and `creatorAuthorityAfterClaim` is
  `absent`.

Continuity follows from ownership rather than from optimism. Yard-owned means
nothing transfers, so `{ endpoint: "preserved", data: "preserved" }`.
Migrate-on-claim means the endpoint is rebound and the data is copied, so
`{ endpoint: "rebound", data: "migrated", credentials: "rotated" }` — describing a
migration as a no-op would be the more attractive lie.

`@hobo/cloud` is a **dev** dependency: the projection is structural, so describing
a pack does not pull the control plane in.
`test/resource-definition-compat.test.ts` assigns the result to the real
`ResourceDefinitionSemantics`, runs the real `parseResourceDefinitionVNext`, and
asserts the candidate matches what `toSelectionCandidate` derives. If either type
drifts, that file stops compiling.

## Persistence is required, never defaulted

A pack that declares `persistence.requirement: "required"` must expose a
**required** `volume-name` configuration key, and `parsePackConfiguration` raises
`PACK_PERSISTENCE_REQUIRED` when a declared volume has no storage bound. A volume
with `externalStorageAllowed: false` cannot be satisfied by an external store.
Defaulting to container-local scratch space is how a database silently becomes
ephemeral, so there is no default to fall through to.

## Credentials

Custody **generates** the material and returns a locator; the pack process never
holds the password, so there is no variable to leak and no error message to redact
it out of. `parseSecretRef` rejects credential-shaped input, which doubles as the
check that catches a custody implementation returning the value itself
(`SECRET_CUSTODY_UNAVAILABLE`). `deposit` exists only for material an external
system produced first.

## Operations are argv arrays

`PackOperation.shell` is typed as the literal `false`, so "this is not a shell
string" is a compile-time fact. `assertArgvSafe` then refuses NUL and control
characters (a NUL truncates in `execve`, a newline forges log lines) and refuses
credential-shaped elements outright — argv is world-readable through `ps`, so a
credential travels by environment, stdin, or file descriptor. A database named
`x; rm -rf /` is deliberately *accepted*: without a shell it is one inert
argument, and rejecting it would push callers toward quoting, which is the actual
bug.

## Conformance stays offline by default

A conformance case is data: argv steps, TCP connects, HTTP GETs, workload
restarts. Cases declare what they need, and `offlineCases` /`containerCases` split
the suite so a default run never depends on a container runtime being installed.
`createReplayConformanceRunner` answers from recorded outcomes and treats an
unrecorded step as an error rather than an implicit pass, which is what keeps the
mandatory lane deterministic. The opt-in lane supplies a runner that really talks
to a container runtime.

## Parse, don't validate

Untrusted input crosses exactly one boundary and becomes a derived type:

| Raw input | Derived type | Impossible afterwards |
| --- | --- | --- |
| image reference string | `ParsedPinnedImageRef`, `ImageDigest` | a moving tag reaching a pull |
| manifest document | `ParsedPackManifest` | an unpinned image, a probe on an undeclared port, a default on a required field |
| parsed manifest + verifier | `VerifiedPackManifest` | execution before signature verification |
| `Record<string, string \| number \| boolean>` | `ParsedPackConfiguration` | an undeclared key, a plaintext password where a locator belongs, a persistent pack with no volume |
| locator string | `SecretRef` (branded, from `@hobo/bindings`) | a connection string travelling as a "ref" |
| case list | parsed `PackConformanceCase[]` | a half-run suite failing on a malformed case |

Downstream functions accept the derived type and therefore never re-check these
invariants. `PackId`, `PackVersion`, `ImageDigest`, and `PinnedImageRef` are
branded, so a bare string cannot be substituted.

## Command / event / actor / event-store story

This package is the **pure core**; it holds no state and performs no I/O. Pack
operations reach the durable control plane the same way every other HoBo
capability does:

- **Commands** — a Yard **actor** per pack instance accepts `InstallPack`,
  `StartPackWorkload`, `RunPackOperation`, `RotatePackCredential`,
  `MigratePackOwnership`. Each command carries the pack id, the pack version, and
  the verified image digest, so a command is replayable against a specific
  artifact rather than against "latest".
- **Events** — the actor emits `pack.Verified` (key id and payload digest, never
  the signature), `pack.WorkloadStarted` (image digest, architecture, bound
  volumes), `pack.OperationCompleted`, `pack.ConformanceRecorded`,
  `pack.CredentialRotated` (locator only), `pack.OwnershipMigrated`.
- **Event store** — the host appends to the durable SQLite-backed **event store**
  with per-stream OCC and a fencing token, so a stale writer cannot append after
  the workload moved. Container effects happen **outside** the store transaction,
  keyed by idempotency, so a retry restarts nothing twice.
- **Projections / materialized views** — the stream folds into the views the CLI
  and catalog read: installed packs with their pinned digests, current
  conformance outcome per profile, and the volume-to-storage map. The catalog view
  is exactly what `toPackResourceSemantics` produces, which is why selection can
  gate on `realization: "pack"` without a second registry.
- **Snapshots / read store** — periodic **snapshots** of the pack-instance
  aggregate back the **read store** that answers current status (`hobo status`);
  historical snapshots keep the digest a resource was last verified against
  auditable after the image is re-pinned.

Secrets never enter an event body. `pack.CredentialRotated` carries a `SecretRef`,
and `redactPackText` is applied to any operation detail that reaches an event, a
log, or a receipt.

## Contracts

- `data-models/pack_framework.proto` — the wire form of the manifest,
  signature, provenance, and conformance records.
- `data-models/pack_framework.cue` — the invariants: digest-pinned references
  only, one repository across architectures, a required volume-name key when
  persistence is required, no default on a required or secret-ref field,
  `shell: false`, and `realization: "pack"`.
- `contracts/pack-framework-oci-registry.pact.json` — the boundary with an OCI
  Distribution registry: manifest pull **by digest** and the
  `Docker-Content-Digest` response header, plus the interaction where the returned
  digest disagrees with the requested one.

## Sources

| Fact | Source | Checked |
| --- | --- | --- |
| A manifest reference "MUST be either (a) the digest of the manifest or (b) a tag"; pull is the one API category every conforming registry MUST support; a successful manifest `GET` "MUST contain the digest … in the header `Docker-Content-Digest`", and where the reference is a digest, "clients SHOULD verify the returned manifest matches this digest" | <https://github.com/opencontainers/distribution-spec/blob/main/spec.md> | 2026-08-08 (fetched) |
| Platform `os` / `architecture` / `variant` values that `PackArchitecture` mirrors | <https://github.com/opencontainers/image-spec/blob/main/image-index.md> | 2026-08-08 (not fetched — **unverified**) |

Every digest in this package's fixtures and contracts is a synthetic value. No
real published image digest is asserted here; the concrete pins live in the
capability packs.
