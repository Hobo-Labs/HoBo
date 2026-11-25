# ADR - CLI Deploy Transcript Prototype

## Decision

Represent HOBO-573 as a deterministic experience proof package that renders terminal-first deploy
transcripts and equivalent MCP tool results from reference fixture records. The package is scoped to
artifact behavior: it proves how deploy success, policy denial, contract incompatibility, and stale
or unknown evidence should be communicated before production CLI/API/provider work exists.

## Alternatives

- Import the unmerged M1 blocker packages. Rejected because HOBO-573 must remain an independent
  draft POC and not depend on branch-local files from clean In Review blocker PRs.
- Build a production `hobo up` command. Rejected because the issue scope explicitly excludes
  production CLI behavior and live provider apply.
- Produce dashboard mockups instead of terminal transcripts. Rejected because HOBO-573 is
  terminal-first and later visual issues consume this evidence.

## Parse Boundary

This package follows **parse, don't validate**: raw fixture-like input crosses
`parseCliDeployTranscriptPrototype` once and becomes the parsed, derived domain types
`CliDeployTranscriptPrototype`, `CliDeployScenario`, and `DeployFixtureReference`. The renderer and
evaluator consume those parsed domain types instead of repeatedly checking raw DTOs.

## Event Architecture

Command: `RenderCliDeployTranscriptPrototype`.

Events: `cliDeployTranscriptPrototype.Accepted` when the transcript matrix satisfies every
acceptance path, and `cliDeployTranscriptPrototype.Rejected` when fixture, parity, or proof-mode
evidence is missing.

Actors: the app developer, platform engineer, agent/MCP caller, and support operator are modeled as
actors over the same reference fixture set.

Event store: tests treat the checked-in fixture matrix as the event-store input for replay.

Materialized view/projection: the transcript and MCP result are projections over the parsed fixture
records, not live provider state.

Snapshots: each scenario records stable DeploymentPlan, Deployment Set, Delta, Gatekeeper,
ResourceActor, projection, and log fixture ids as reviewable snapshots.

Read store: reviewers and later docs/tutorial slices consume the rendered transcript and MCP result
read models, while Linear remains authoritative for issue state.
