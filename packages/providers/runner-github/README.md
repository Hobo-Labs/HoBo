# @hobo/runner-github

The REAL GitHub Actions execution-host adapter (HOBO-718): both
execution-host ports from control-plane.md, driven against the real GitHub
REST API.

- **RunnerProvider** (`hobo:runner`) — `run(job)` fires a
  `workflow_dispatch` on the configured workflow (default
  `hobo-runner.yml`), tracks the run to completion and returns a
  `RunnerResult` with past-tense `runner.*` facts.
- **BuildMachineProvider** (`hobo:build-machine`) — `execute(build)` runs
  the build workflow (default `hobo-build.yml`) on a GitHub-hosted machine
  and resolves the published GHCR image digest into a pullable `ImageRef`.
  An over-budget build throws the typed `credit.exhausted` failure before
  any dispatch.

## Dispatcher routing

`createExecutionHostRegistry` + `selectExecutionHost` (promoted from the
`execution-host-provider-contract` draft proof) rank registered hosts by
effective marginal cost against the `CreditLedgerView` and record the pick
as a `dispatch.Decided` fact. GitHub declares its real list price
($0.006/min hosted Linux runner) and free tier (2,000 min/month), so it
wins while free headroom remains and loses to the cheapest remaining
registered host once exhausted.

## Lanes

- **Replay lane (default):** the `fetch` transport is injected; tests
  exercise exact request formation + response parsing against the
  PACT-recorded responses with no network.
- **Live lane (credential-gated):** a caller holding the owner store session
  passes `ownerTokenProvider(credentials)`, which resolves
  `owner://GITHUB_INSTALLATION_TOKEN` (a short-lived installation token — no
  PATs; the environment is never read), with `HOBO_GITHUB_OWNER`,
  `HOBO_GITHUB_REPO` and optionally `HOBO_GITHUB_WORKFLOW`, to dispatch and
  track a real run.

## Install

`hobo add runner-github` registers the Capability Manifest (both ports,
auth posture, cost facts) into the durable registry stream and approves it
for Dispatcher routing (HOBO-710).
