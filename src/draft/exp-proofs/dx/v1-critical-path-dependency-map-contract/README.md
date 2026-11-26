# V1 Critical Path Dependency Map Contract

Executable M0 proof for HOBO-484, defining the cross-project dependency map that separates private
beta blockers from GA blockers before release sequencing fan-out.

## Focused Gate

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\v1-critical-path-dependency-map-contract test
```

## Proof Surface

- `V1_CRITICAL_PATH_DEPENDENCY_MAP` records product UX, tenant model, billing, install, docs,
  testing, support, security, compliance, and operations dependencies.
- `validateCriticalPathDependencyMap` fails closed when the record loses required domains, owner
  routing, downstream gates, or known limitations.
- `criticalPathByLaunchGate` separates private beta, release-candidate, and GA blockers.

## Architecture Guardrail Evidence

- PACT: `architecture/pacts/v1_critical_path_dependency_map_contract.pact.json` fixes the release
  dependency boundary between the release program consumer and provider.
- Protobuf + CUE: `architecture/v1_critical_path_dependency_map_contract.proto` and
  `architecture/v1_critical_path_dependency_map_contract.cue` define the dependency map shapes and
  constraints.
- Parse, don't validate: downstream release code must parse these records into derived domain types
  for dependency domain, blocker type, upstream project, downstream gate, owner, and known limitation
  disposition before any workflow consumes them.
- Event architecture: the command `CriticalPathDependencyMapCommand` is submitted by the release
  owner actor, accepted as `CriticalPathDependencyMapAccepted` or denied as
  `CriticalPathDependencyMapDenied` events, appended to the release event store, projected into
  release-readiness and launch-dashboard materialized views, captured as launch snapshots, and
  exposed through read stores for release, support, security, legal, and operations review.

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Dependency map covers product UX, tenant model, billing, install, docs, testing, support, security, compliance, and operations. | Tests assert the required dependency domains in order. |
| Each dependency names blocker type, upstream project, downstream gate, and owner. | Tests assert every dependency has routing fields. |
| Critical path distinguishes beta blockers from GA blockers. | Tests assert private beta, release-candidate, and GA groupings. |
| Out-of-scope dependencies are recorded as known limitations. | Tests assert known limitation ids and validation failure when omitted. |

## Scope Guards

This proof deliberately does not implement product UX, tenant, billing, install, docs, testing,
support, security, compliance, operations, release go/no-go, legal approval, payment provider, or
runtime feature work.
