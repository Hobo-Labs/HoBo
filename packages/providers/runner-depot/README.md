# @hobo/runner-depot

The REAL Depot execution-host adapter (HOBO-720): remote container builds
with shared-cache economics, plus Depot-managed Actions runners.

- **BuildMachineProvider** (`hobo:build-machine`, first-class) —
  `execute(build)` registers the build with the Depot BuildService
  (Connect RPC `CreateBuild` → per-build token), runs it through the
  BuildKit executor seam (the `depot` CLI in the live lane) and returns a
  pullable `ImageRef`. Every build surfaces a `build.CacheHitObserved`
  fact (observed hit ratio + metered units); only observed units debit
  the credit budget, so the second identical build demonstrates the
  shared-cache speedup in the log.
- **RunnerProvider** (`hobo:runner`) — the SAME job spec as
  runner-github/runner-blacksmith, dispatched onto Depot-managed runners
  (`runs_on: depot-ubuntu-22.04`).

## Economics

Declared facts (declared-provider source): runners at $0.004/min (half of
GitHub's list), build machines at $0.04/build-minute with 500 included
minutes/month and a declared warm-cache hit rate of 0.80. Dispatcher
routing across github/blacksmith/depot picks per declared effective cost
and records the rationale in `dispatch.Decided` (ADR-0071).

## Lanes

- **Replay lane (default):** injected mocked fetch + fixture executor;
  tests assert exact CreateBuild request formation and the recorded
  cache-fact sequence — no network. Successful build registration requires
  non-empty build IDs and tokens.
- **Live lane (credential-gated):** `owner://DEPOT_PROJECT_TOKEN`, a
  short-lived project token resolved through the owner store session
  (`ownerDepotTokenProvider`; the environment is never read) + the `depot` CLI executor; a missing
  executor or token fails closed with typed gates.

## Install

`hobo add runner-depot` registers the Capability Manifest (both ports,
brokered posture, cost + cache facts) into the durable registry stream
and approves it for Dispatcher routing (HOBO-710).
