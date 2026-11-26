# @hobo/runner-github — Architecture Evidence

The REAL GitHub Actions execution-host adapter (HOBO-718): the first
production implementation of the pair of execution-host ports from
control-plane.md — `RunnerProvider` (`hobo:runner`) and
`BuildMachineProvider` (`hobo:build-machine`) — promoted from the
`execution-host-provider-contract` draft proof, driven against the real
GitHub REST API (version 2022-11-28) through an injected-fetch client.

## Schema and constraints

- Protobuf records live in [`data-models/`](./data-models): the
  execution-host capability + cost facts, the secretless auth posture, the
  runner job/result records, the `dispatch.Decided` fact and the ImageRef.
- CUE constraints in `data-models/runner_github.cue` bound every protobuf
  message (ports pinned to `hobo:runner`/`hobo:build-machine`, SKUs to
  `runner.minutes`/`build.minutes`, `staticSecrets` to `false`, digests to
  `sha256:`).
- PACT boundary evidence lives under [`contracts/`](./contracts): the
  workflow_dispatch request, run tracking, the secretless posture and the
  GHCR digest resolution — asserted against the recorded interactions in
  the replay-lane tests.

## Parse, don't validate

`parseExecutionHostManifest` is the parse, don't validate boundary for
Dispatcher-facing manifests (frozen derived manifest or structured errors);
`parsePublishedManifest` does the same for the registry-facing well-known
bundle, and the secretless posture is parse-enforced (`staticSecrets` must
be `false`). Callers receive derived parsed domain types instead of
re-checking raw fields.

## Real API, honest lanes

`run(job)` fires a `workflow_dispatch`, correlates the newest dispatched
run and polls it to completion; `execute(build)` dispatches the build
workflow and resolves the published GHCR container-package version digest
into a pullable `ImageRef`. The `fetch` transport is injected: the replay
lane exercises exact request formation + response parsing against the
recorded responses with no network, and the live lane is credential-gated
behind `HOBO_GITHUB_LIVE=1`. Missing credentials fail closed with the
typed `GITHUB_CREDENTIALS_MISSING` gate rather than limping into 401s.

## Dispatcher cost routing (ADR-0071)

`selectExecutionHost` ranks ONLY the registered providers of a category by
effective marginal cost against the `CreditLedgerView` (Plan 5): a host
with free-tier headroom costs zero, an exhausted one falls back to its
transcribed declared list price ($0.006/min for the hosted Linux runner, 2,000
included minutes/month), and ties break deterministically by provider id.
Free-tier exhaustion therefore re-routes the next job to the cheapest
remaining registered runner. Credit exhaustion on the build-machine side
throws the typed `credit.exhausted` failure BEFORE any dispatch.

## Event architecture

The adapter participates in the event-sourced control plane without
holding state of its own: every selection emits a past-tense
`dispatch.Decided` fact carrying the objective, the CreditLedgerView
snapshot (seq + balance hash + reservation id) and every ranked candidate,
so the routing decision replays from the log; `run(job)` returns
`runner.JobStarted` and `runner.JobSucceeded`/`runner.JobFailed` facts for
the caller's single-writer actor to append to the event store. Read stores rebuild from the
log — the CreditLedgerView is a materialized view over metering facts, and
identical inputs always produce the identical decision (asserted in
tests). Registration flows through the HOBO-710 command/event loop:
`hobo add runner-github` appends `provider.Registered` + `provider.Approved`
facts whose manifest snapshot the Registry projection folds.

## Credentials

Secretless-first (HOBO-110): the Yard broker holds the GitHub App
relationship and mints SHORT-LIVED installation tokens per operation —
never a PAT, never a static secret in a Bindle, Camp or this package. The
client only ever sees the expiring token through the injected
`BrokeredTokenProvider`.
