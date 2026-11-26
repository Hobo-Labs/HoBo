# Dogfood Yard M1 Evidence Contract

Executable M1 proof for HOBO-455, defining the dogfood/alpha evidence gate for
V1 Dogfood Yard & Hosted Operations.

## Focused Gate

```powershell
npm.cmd --prefix src\draft\exp-proofs\dogfood-yard-m1-evidence-contract test
```

## Proof Surface

- `DOGFOOD_YARD_M1_EVIDENCE` records the required scenario fixtures, safe telemetry bundle,
  rollback/recovery evidence, gap classification ledger, and release cutline dependency map.
- `parseDogfoodYardM1Evidence` fails closed when dogfood evidence drifts into Yard runtime
  build work, production provider calls, live customer data, or beta/GA readiness claims.
- `classifyDogfoodM1Decision` routes adjacent admin, bootstrap, release-notes, and cutline work
  to their owning initiatives rather than expanding this issue.

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Required evidence for this phase is listed and mapped to owning projects. | Tests assert the five required evidence records and owner projects. |
| Blockers and accepted risks are recorded. | `gapRoutes` distinguishes beta blockers, launch notes, and follow-up work. |
| Cross-project dependencies are reflected in the release cutline. | `cutlineDependencies` names release cutline, release notes, admin, bootstrap, and reliability owners. |
| Follow-up execution issues are created only where evidence is missing. | `followUpPolicy.createOnlyWhereEvidenceMissing` is asserted. |
| Parent release readiness impact is captured without claiming readiness. | Scenario records include cutline impact while the parser rejects readiness claims. |

## Scope Guards

This proof deliberately does not build Yard runtime, hosted operations runtime, admin UI, bootstrap
installer, provider adapters, observability pipelines, release notes, or release cutline decisions.
It does not call production providers or use live customer data.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for Dogfood Yard M1 evidence.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
