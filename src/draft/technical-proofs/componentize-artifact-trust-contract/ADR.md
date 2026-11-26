# Componentize Artifact Trust — Architecture Evidence

Draft POC for S0-10 artifact signing and install verification. Carries architecture-guard evidence
required by `scripts/check-architecture-guardrails.mjs`.

## Schema And Constraints

- Protobuf data shapes live in [`data-models/`](./data-models).
- CUE constraints bound every protobuf type in that schema.
- A PACT contract under [`contracts/pacts/`](./contracts/pacts) records the publish→verify boundary.

## Parse, Don't Validate

Untrusted install candidates cross exactly one verification boundary:
`verifyInstallCandidate({ candidate: unknown, trustBoundary })` returns parsed `InstallVerdict` derived
types. Trust boundaries and artifact refs are constructed via `createTrustBoundary` and
`createArtifactPayload` so invalid values are unrepresentable past those constructors. CUE constraints
in `data-models/artifact_trust.cue` bound the same derived types.

## Event Architecture

Artifact trust state is modeled as append-only events with a projection read model:

- **Command** — `publishSignedArtifact` (publish) and install verification requests.
- **Event** — `artifact.Published`, `artifact.InstallVerified`, `artifact.InstallRefused`.
- **Actor** — the artifact trust aggregate applies events in order; nothing mutates the catalog directly.
- **Event store** — handlers append `ArtifactTrustEvent` records to the durable log.
- **Materialized view / projection** — `verifiedArtifactCatalog(events)` folds install-verified events.
- **Snapshot** — catalog entries `{ ref, availableToMatching: true, selectedByMatching: false }`.
- **Read store** — Matching consumers query the catalog projection, never the raw candidate payload.

No runtime engine, projector, or event store ships in this POC; the event helpers name the command,
event, actor, and projection boundaries for promotion into `packages/componentize/`.
