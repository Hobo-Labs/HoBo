# Hosted Broker GA Handoff Evidence Contract

Executable M4 proof for HOBO-530, proving the hosted broker GA handoff checklist without building
broker runtime code, Yard planner behavior, provider adapters, admin UI, Gatekeeper policy, or
live hosted broker operations.

## Focused Gate

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\cx\hosted-broker-ga-handoff-evidence-contract test
```

## Proof Surface

- `HOSTED_BROKER_GA_HANDOFF_EVIDENCE` records the M4 evidence set, owners, proof sources, Dogfood
  Yard readiness links, compatibility windows, rollback/restore limits, release/support entries,
  accepted risks, missing live-service proof, and parent readiness sync.
- `parseHostedBrokerGaHandoffEvidence` is the parser boundary: invalid records never reach
  downstream broker, Dogfood, release, or support consumers.
- `HostedBrokerGaHandoffEvidenceParseError` fails closed on pending required evidence, missing
  compatibility windows, speculative follow-ups, unsynced parent readiness changes, proofless GA
  publication, local-fixture-only GA claims, and manually edited receipt claims.

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| GA handoff checklist names required operational owners and proof sources. | Tests assert the owner checklist and required evidence IDs. |
| Dogfood Yard evidence links broker receipt behavior to deploy readiness. | Tests assert Resolution Receipt and Resolution Rejection links to deploy-readiness use. |
| Compatibility/versioning and rollback/restore limits are documented. | Tests assert receipt schema, broker environment, catalog snapshot, and rollback/restore records. |
| Release notes and support docs have broker-specific entries or explicit non-goals. | Tests assert release-note and support/debug entries are present. |
| Reject GA claims based only on local fixtures, docs, or manually edited receipts. | Adversarial tests assert publishable GA claims fail closed when they cite local fixtures or manual receipt edits. |

## Scope Guards

This proof deliberately does not implement a hosted broker runtime, signer, persistence layer,
planner, provider adapter, admin UI, Gatekeeper policy, support tooling, release automation, or live
provider operation. It records GA handoff evidence and leaves live hosted broker GA proof as an
explicit post-GA or release-owner decision.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for the GA handoff evidence record.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
