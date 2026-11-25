# @hobo/runner-depot — Architecture Evidence

The REAL Depot execution-host adapter (HOBO-720): the build-machine
specialist of the M3 trio, implementing `BuildMachineProvider`
(`hobo:build-machine`) FIRST-CLASS against Depot's BuildService API and
`RunnerProvider` (`hobo:runner`) via Depot-managed GitHub Actions runners
(`runs-on: depot-*`, reusing the shared job model from
`@hobo/runner-github`).

## Schema and constraints

- Protobuf records live in [`data-models/`](./data-models): the Depot
  capability + cost facts (incl. the declared shared-cache hit rate), the
  secretless auth posture, the BuildService build handle and the observed
  cache-hit fact.
- CUE constraints in `data-models/runner_depot.cue` bound every protobuf
  message (SKUs pinned to `runner.minutes`/`build.minutes`, the cache lane
  to `depot-shared-cache`, hit ratios to `[0,1]`, `staticSecrets` to
  `false`).
- PACT boundary evidence lives under [`contracts/`](./contracts): the
  CreateBuild registration, the brokered posture and the two-build
  cache-speedup fact sequence — asserted against the recorded interactions
  in the replay-lane tests.

## Parse, don't validate

Manifests round-trip through the SHARED `parseExecutionHostManifest`
parse, don't validate boundary from `@hobo/runner-github` into frozen
derived parsed types; `parsePublishedManifest` covers the registry-facing
well-known bundle (`staticSecrets` must parse to `false`); the client
refuses CreateBuild responses missing `build_id`/`build_token` and the
provider refuses non-`sha256:` digests. Callers receive derived parsed
domain types instead of re-checking raw fields.

## Real API, honest lanes

`execute(build)` registers the build with the real Depot BuildService
(Connect RPC `CreateBuild` → per-build token) through an injected-fetch
client, then hands it to the BuildKit executor seam — the live lane
drives the `depot` CLI on Depot infrastructure; the replay lane injects a
fixture executor. A missing executor fails closed with the typed
`DEPOT_EXECUTOR_MISSING` gate and missing credentials with
`DEPOT_CREDENTIALS_MISSING` — nothing fabricates an image.

## Shared-cache economics (the point of this adapter)

Depot's shared BuildKit cache changes the METERED WORK of the identical
build: the second run of the same BuildSpec does less. Every build
surfaces a past-tense `build.CacheHitObserved` fact (observed hit ratio +
metered units, `observed-executor` source), only OBSERVED units debit the
credit budget, and the manifest declares the expected warm hit rate —
so a warm-cache Depot build can legitimately outrank a "free" cold
GitHub build once the CreditLedgerView folds those facts. Dispatcher
routing across github/blacksmith/depot picks per declared effective cost
and `dispatch.Decided` explains each pick (ADR-0071), asserted in the
three-way routing test.

## Event architecture

The adapter participates in the event-sourced control plane without
holding state of its own: commands become past-tense facts —
`dispatch.Decided` for routing (carrying the CreditLedgerView snapshot:
seq, balance hash, reservation id), `runner.JobStarted`/`JobSucceeded`/
`JobFailed` for jobs, `build.CacheHitObserved` for builds — all appended
by the caller's single-writer actor to the event store. The
CreditLedgerView is a materialized view / projection over those metering
facts; read stores rebuild from the log at any time. Registration flows
through the HOBO-710 command/event loop: `hobo add runner-depot` appends
`provider.Registered` + `provider.Approved` facts whose manifest snapshot
the Registry projection folds.

## Credentials

Secretless-first (HOBO-110): the Yard broker holds the Depot OIDC trust
relationship and mints SHORT-LIVED project tokens per operation
(`hobo:brokered-depot-project-token`); each build additionally runs under
its own expiring per-build token from CreateBuild. No static Depot token
in any Bindle, Camp or this package.
