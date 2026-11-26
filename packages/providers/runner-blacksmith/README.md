# @hobo/runner-blacksmith

The REAL Blacksmith.sh execution-host adapter (HOBO-719): the fast-runner
sibling of `@hobo/runner-github`, implementing both execution-host ports by
substituting the `runs-on` substrate of the GitHub Actions job model.

- **RunnerProvider** (`hobo:runner`) — the SAME job spec that runs on
  runner-github runs unmodified here; `run(job)` dispatches the workflow
  (default `hobo-runner-blacksmith.yml`) with the Blacksmith runner class
  (`runs_on: blacksmith-4vcpu-ubuntu-2204`) and tracks the run to a
  `RunnerResult`.
- **BuildMachineProvider** (`hobo:build-machine`) — `execute(build)` runs
  the build workflow (default `hobo-build-blacksmith.yml`) on a Blacksmith
  fast machine with sticky-disk Docker-layer caching, resolves the
  published GHCR digest into a pullable `ImageRef`, and surfaces a
  `build.CacheLaneObserved` fact. Over-budget builds throw the typed
  `credit.exhausted` failure before any dispatch.

## Economics

Declared cost facts (declared-provider source): $0.004/min for the 4-vCPU
Linux class — below GitHub's $0.006/min 2-core — with 3,000 free minutes/month.
With GitHub and Blacksmith both registered, the Dispatcher's min-cost
objective routes each job to the cheaper effective option and records the
rationale in `dispatch.Decided` (ADR-0071).

## Lanes

- **Replay lane (default):** injected mocked fetch; tests assert the exact
  substituted workflow_dispatch against the PACT-recorded interactions —
  no network.
- **Live lane (credential-gated):** the shared GitHub client's live lane
  applies (broker-minted installation tokens; no PATs); Blacksmith runner
  classes require the org's Blacksmith integration, held by the broker.

## Install

`hobo add runner-blacksmith` registers the Capability Manifest (both
ports, brokered posture, cost facts) into the durable registry stream and
approves it for Dispatcher routing (HOBO-710).
