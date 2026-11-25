# @hobo/runner-blacksmith — Architecture Evidence

The REAL Blacksmith.sh execution-host adapter (HOBO-719): the design's named
fast-runner sibling of `@hobo/runner-github`, implementing the same pair of
execution-host ports — `RunnerProvider` (`hobo:runner`) and
`BuildMachineProvider` (`hobo:build-machine`). Blacksmith is a drop-in
substitution of the `runs-on` execution substrate of the GitHub Actions job
model, so the adapter reuses the injected-fetch GitHub client and job/track
flow from `@hobo/runner-github` and adds the Blacksmith posture on top:
fast-runner classes (`runs-on: blacksmith-*`, carried as the `runs_on`
dispatch input), sticky-disk Docker-layer caching, and Blacksmith's own
declared prices.

## Schema and constraints

- Protobuf records live in [`data-models/`](./data-models): the Blacksmith
  capability (with the pinned `runs_on` class), declared cost facts, the
  secretless auth posture and the cache-lane fact.
- CUE constraints in `data-models/runner_blacksmith.cue` bound every
  protobuf message (`runsOn` pinned to `blacksmith-*`, SKUs to
  `runner.minutes`/`build.minutes`, `cacheLane` to `sticky-disk`,
  `staticSecrets` to `false`).
- PACT boundary evidence lives under [`contracts/`](./contracts): the
  substituted workflow_dispatch, the brokered posture and the cache-lane
  fact — asserted against the recorded interactions in the replay-lane
  tests.

## Parse, don't validate

Manifests round-trip through `parseExecutionHostManifest` (the shared
execution-host parse, don't validate boundary from `@hobo/runner-github`)
into frozen derived parsed types, and `parsePublishedManifest` does the
same for the registry-facing well-known bundle — `staticSecrets` must
parse to `false`. Callers receive derived parsed domain types instead of
re-checking raw fields downstream.

## Port-level substitutability (the point of this adapter)

The SAME `RunnerJob` spec that runs on runner-github runs UNMODIFIED on
Blacksmith — the replay-lane conformance test feeds one job object to both
providers and asserts the same result/fact shape. What changes is the
substrate (`runs_on` input) and the economics: $0.004/min for the 4-vCPU
Linux class (vs GitHub's $0.006/min 2-core) with 3,000 free minutes/month,
declared-provider source. With both registered, the Dispatcher
(ADR-0071) gets its first real price/performance routing choice for the
same job shape, and min-cost routing picks the cheaper effective option.

## Event architecture

The adapter participates in the event-sourced control plane without
holding state of its own: routing decisions replay from `dispatch.Decided`
facts (the shared Dispatcher selection consumes the CreditLedgerView — a
materialized view / projection over metering facts, addressed by seq +
balance-hash snapshot); `run(job)` returns `runner.JobStarted` and
`runner.JobSucceeded`/`runner.JobFailed` facts, and every accelerated
build surfaces a past-tense `build.CacheLaneObserved` fact, all appended
by the caller's single-writer actor to the event store as commands become
facts. Read stores rebuild from the log at any time. Registration flows
through the HOBO-710 command/event loop: `hobo add runner-blacksmith`
appends `provider.Registered` + `provider.Approved` facts whose manifest
snapshot the Registry projection folds.

## Credentials

Secretless-first (HOBO-110): jobs dispatch with broker-minted short-lived
GitHub App installation tokens (never a PAT), and the Blacksmith org
relationship itself is held by the Yard broker
(`hobo:brokered-blacksmith-org-token`) — no static org token in any
Bindle, Camp or this package.
