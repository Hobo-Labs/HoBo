# `@hobo/cd/sources` — Freight sources and pull discovery (WP2)

Freight enters HoBo CD by **pull**. A *Freight source* (Kargo's "Warehouse"
semantics, none of its API) is a named set of subscriptions for one Bindle.
Each poll reads the upstream (registry, Git host, package registry, HTTP
index, HoBo CI events or Rail approvals) forward from a high-water mark,
gates provenance, assembles one Freight per qualifying combination, and
records it through the Freight ledger. Webhooks only *nudge*: they schedule a
poll and never create Freight (I15).

Plan: [`docs/plans/0024-hobo-cd-swarm-instruction.md`](../../../../docs/plans/0024-hobo-cd-swarm-instruction.md)
§5 D3/D24, §6 I15, §9 WP2.

## Surface

| Export | What it is |
| --- | --- |
| `createFreightSources(d)` | The frozen `FreightSources` port: `define`, `list`, `poll`, `nudge`, `schedule`, `tick`. `d` is `CdFactories["createFreightSources"]`'s deps plus optional `telemetry: TelemetrySink`. |
| `createSubscriptionDrivers(d)` | One `SubscriptionDriver` per `SubscriptionKind` ([`drivers/`](drivers/README.md)). |
| `parseFreightSource(record, definedBy)` | The parse boundary for `FreightSourceRecord`. |
| `receiveWebhook(request, secrets)` | The authenticated webhook receivers ([`webhooks/`](webhooks/README.md)). |
| `assemble(input)` | Pure assembly rules. |
| `SOURCE_REASON`, `SOURCE_METRIC`, `WEBHOOK_RECEIVERS` | Public reason codes, metric names, receiver ids. |

## Design

**Parse, don't validate.** Every `FreightSourceRecord` the service stores came
through `parseFreightSource`, which returns a normalized, derived type (schema
stamped, defaults applied: SemVer selection without prereleases for versioned
kinds, `NEWEST_COMMIT` for a Git branch, `NEWEST_BUILD` for HoBo CI,
`INDEPENDENT` assembly, the frozen poll interval `CD_DEFAULTS.sourcePollIntervalMs`
and discovery limit `CD_DEFAULTS.sourceDiscoveryLimit`) or a typed refusal
listing every problem with a remediation. A poll interval below
`sourcePollIntervalMinMs` is refused, never clamped. Records are secret-free
(I9): URL userinfo or token shapes in any field are refused; credentials live
behind `credentialRef` and are resolved per read where discovery runs.
`data-models/sources.cue` mirrors the structural rules and is checked against
the parser in `test/sources/cue.test.ts`.

**Event architecture.** Commands append events to the event store; queries
fold them.

- Command `define` → event `source.Defined` on `cd-source-<name>` (stream-head
  CAS, idempotency key = definition digest; redefining identically is a no-op).
- Command `poll` → one `source.ArtifactDiscovered` per new artifact on the same
  stream. Its `meta` carries the subscription's new `cursor`, the `outcome`
  (`recorded` / `skipped` / `deferred` / `refused`), the `reasons`, the
  `freightIds` and the authorization `decisionId`.
- The per-source actor state (definition, cursor per subscription, discovery
  history, seen keys) is the fold of that stream; there is no snapshot because
  the stream is bounded by discoveries, and the fold is rebuilt on every poll.
- `list` is a read store: a projection (materialized view) over
  `source.Defined` that catches up from its last journal position.
- Freight is recorded **before** the cursor moves. A crash in between repeats
  the content-addressed (idempotent) record on the next poll instead of
  losing Freight (I12).

**Forward-only discovery.** Drivers keep a high-water mark in their cursor and
return only the newest `discoveryLimit` versions strictly above it, oldest
first. The service re-checks SemVer/lexical order against its own history and
skips anything not newer (`source-older-than-high-water`): an older tag is
never discovered after a newer one.

**Provenance.** With `requireProvenance`, the driver must fetch attestations
(OCI referrers); each is verified through the `ProvenanceVerifier` port with
the subscription's pinned `trustedBuilderIds` / `trustedSignerIdentities`.
An artifact without an attestation is skipped with `source-provenance-missing`;
one whose attestations all fail is skipped with `source-provenance-rejected`
plus the verifier's reasons. Skips are journaled and advance the cursor (the
fix is to publish a newer, signed version).

**Assembly.** `INDEPENDENT` pairs each new artifact with the latest artifact
of every other subscription; `SAME_VERSION` / `SAME_COMMIT` pair artifacts
sharing a version / commit once every subscription has one. The declaration
hash is the `SOURCE_TREE` member's digest when a declaration subscription
exists, otherwise the digest of the source definition. A `HOBO_RAIL` source
yields subject `RAIL` Freight: `bindle` = Rail id, `declarationHash` = Rail
digest, no artifacts (D24).

**Authorization.** `define` is `source.define`; a poll that records Freight
is `freight.record` (the ingress governs recording). The decision id is
journaled with every event.

**Scheduling.** `tick` polls `automatic` sources on their interval and any
source scheduled by `schedule` or `nudge`. Failures back off exponentially
from `sourceBackoffBaseMs` to `sourceBackoffMaxMs`, jittered into [50%, 100%]
by `sha256(source, attempt)` — deterministic and replayable (I8). A
rate-limit's `Retry-After` is a floor. Pending schedules and backoff state
are in-process only: a restart drops a nudge already answered `202` and
resets backoff. That is safe (nudges are hints; polling is the source of
truth), but a manual (`automatic: false`) source waits for the next nudge.

## Metrics (`TelemetrySink`)

| Name | Kind | Attributes |
| --- | --- | --- |
| `hobo.cd.source.polls` | counter | `source`, `outcome` (`ok` or the reason code) |
| `hobo.cd.source.poll.duration` | histogram (ms) | `source` |
| `hobo.cd.source.discovered` | counter | `source`, `subscription` |
| `hobo.cd.source.skipped` | counter | `source`, `code` |
| `hobo.cd.source.freight.recorded` | counter | `source` |
| `hobo.cd.source.freight.refused` | counter | `source`, `code` |
| `hobo.cd.source.nudges` | counter | `outcome` (HTTP status), `receiver` |
| `hobo.cd.source.backoff` | gauge (ms) | `source`, `code` |
| `hobo.cd.source.defined` | counter | `source` |

## Runbook

| Symptom | Cause | Action |
| --- | --- | --- |
| `hobo.cd.source.polls{outcome="source-rate-limited"}` rising; `backoff` gauge high | Registry quota exhausted | Nothing urgent: the source honours `Retry-After`. Raise `pollIntervalMs`, rely on webhook nudges, or set a `credentialRef` with a higher quota. |
| `source-auth-failed` | Credential missing, expired or under-scoped | Rotate the secret behind the subscription's `credentialRef` (scope `cd:source:read`); the next tick retries. |
| `source-git-capability-missing` | Git server without protocol v2 or `uploadpack.allowFilter` | Enable `protocol.version=2` and `uploadpack.allowFilter` on the server. Discovery never clones. |
| `source-transport-not-binary-safe` | The composed `HttpTransport` decodes binary bodies as UTF-8 | Compose a transport that returns binary content (packfiles, blobs, packages) as latin1, one char per byte. |
| `skipped` with `source-provenance-missing` | Image pushed without an attestation | Sign it (Sigstore bundle or in-toto attestation pushed as an OCI referrer) and publish a new tag; the skipped tag stays skipped (forward-only). |
| `skipped` with `source-provenance-rejected` | Attestation from an unpinned builder/signer | Compare the attestation with `trustedBuilderIds` / `trustedSignerIdentities`; fix the pin or re-sign. |
| `refused` with `source-freight-refused` | The ledger refused the manifest (e.g. digest not at its coordinate) | Read the ledger reasons in the event meta; fix the artifact and publish a newer version. |
| `deferred` events, no Freight | Assembly is waiting for another subscription | Check the missing subscription named in the reason; for `SAME_COMMIT` make sure images carry `org.opencontainers.image.revision`. |
| Nudges answered `401` | Sender secret differs from `webhook/<receiver>` (scope `cd:source:nudge`) | Re-share the secret with the sender. A `401` never schedules a poll. |
| Manual source missed an update after a restart | A `202` nudge was pending when the service restarted (schedules are in-process) | Re-send the nudge, or run `poll` for the source. Automatic sources catch up on their next interval. |
| Nudges answered `202` with `scheduled: []` | Payload names a repository no subscription matches | Compare the payload repository with the subscription locator (keys are normalized: host lowercased, `.git` dropped, Docker Hub `library/`). |
| A retired Rail was discovered earlier | It was approved, discovered, then retired in a later poll | Yank the Freight through the ledger (`freight.yank`); a Rail retired before discovery is never discovered. |

Rebuild: everything above is the fold of `cd-source-<name>`; dropping the
process loses only the in-memory poll schedule and backoff, and the next tick
polls every automatic source once.
