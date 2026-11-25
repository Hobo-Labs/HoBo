# Bootstrap Launch Smoke Matrix Contract

Executable M1 proof for HOBO-501, defining the launch smoke matrix that makes the Bootstrap
Installer installability claim reviewable without building production installer, auth, deploy, or
cleanup runtime.

## Focused Gate

```powershell
pnpm --filter @hobo/bootstrap-launch-smoke-matrix-contract test
```

## Proof Surface

- `BOOTSTRAP_LAUNCH_SMOKE_MATRIX` records SaaS, self-host, and local/dev bootstrap paths.
- `validateBootstrapLaunchSmokeMatrix` fails closed when required paths, stages, fixtures, mocked
  boundaries, unsupported states, or downstream result feeds disappear.
- `summarizeBootstrapLaunchEvidence` produces the release-notes, troubleshooting, and support
  handoff entries consumed by launch readiness work.
- `classifyBootstrapLaunchSmokeWork` routes adjacent production installer, support, release, Yard,
  provider, and live-deploy work to owning initiatives instead of expanding this issue's scope.

## Architecture Guardrail Evidence

- PACT: `architecture/pacts/bootstrap_launch_smoke_matrix_contract.pact.json` fixes the launch
  smoke matrix boundary between the Bootstrap Installer consumer and release/support handoff
  provider.
- Protobuf + CUE: `architecture/bootstrap_launch_smoke_matrix_contract.proto` and
  `architecture/bootstrap_launch_smoke_matrix_contract.cue` define matrix records, stage evidence,
  seed/auth evidence, unsupported states, and result feeds.
- Parse, don't validate: downstream M1 code must parse these records into derived domain types for
  path id, stage id, mocked boundary, fixture, unsupported-state, and result-feed target before any
  workflow consumes them.
- Event architecture: the command `BootstrapLaunchSmokeMatrixCommand` is submitted by the bootstrap
  readiness actor, accepted as `BootstrapLaunchSmokeMatrixAccepted` or denied as
  `BootstrapLaunchSmokeMatrixDenied` events, appended to the bootstrap readiness event store,
  projected into release, troubleshooting, and support materialized views, captured as launch
  snapshots, and exposed through read stores for release and support review.

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Smoke matrix covers SaaS bootstrap, self-host bootstrap, local/dev bootstrap, auth seed, first project, first deploy, failure recovery, and uninstall/cleanup where applicable. | Tests assert the three path ids and required stage ids for every path. |
| Each path names required fixtures, mocked boundaries, and unsupported states. | Tests assert path-level fixtures, mocked boundaries, unsupported states, and stage-level fixture/mock bindings. |
| Results feed release notes, troubleshooting, and support handoff. | Tests assert the three result feeds and summary output entries. |
| No production installer implementation is introduced. | Tests reject production installer scripts, live cloud provisioning, production auth, customer environment scans, and uninstall cleanup runtime. |

## Scope Guards

This proof deliberately does not build production installer scripts, native packages, package
publishing, live cloud provisioning, production auth, seed-token minting, real deploy execution,
secret persistence, customer environment scanning, uninstall cleanup runtime, or support ticket
workflow implementation.
