# DX Resource Lifecycle Fixture Corpus

This package is the executable experience proof for HOBO-572. It defines the
deterministic resource-lifecycle fixture corpus consumed by SDK compile
consumers, CLI transcript generators, control-plane API examples, docs snippets,
and later visual mockups.

The proof stays in the experience layer: it records reference fixture contracts,
not production SDK, CLI, provider, planner, ResourceActor, support, or visual UI
implementation.

## Audience

- App developer validating the smallest deploy/manage/migrate path.
- Platform engineer reviewing provider-agnostic resource and migration facts.
- GitOps operator consuming deterministic deploy and rollback transcripts.
- SecOps reviewer checking denial and contract-incompatibility evidence.
- DevOps operator consuming import/adopt and no-op plan fixtures.
- SRE/support operator reading redacted logs, projections, and evidence packs.
- Agent/MCP caller receiving the same typed fixture envelopes as the CLI.

## Scope

In scope:

- Deploy, manage, migrate, rollback, import/adopt, drift, stale projection,
  policy denial, contract incompatibility, and support-evidence fixture paths.
- Resources, links, manifest IR, DeploymentPlan, Deployment Set, Delta,
  Gatekeeper decision, ResourceActor event, projection, log, drift,
  import/adopt, and migration-phase fixture facts.
- Concrete `dx.lifecycle.<scenario>.<fact-kind>.v1` fixture facts on every
  scenario, all sourced from `fixture-corpus`, redacted, tenant-safe, and
  aligned to the scenario proof mode.
- Proof-mode labels with `reference fixture` as the default.
- Protobuf, CUE, Pact, fixture JSON, and type-consumer boundary expectations.

Out of scope:

- Live providers, customer data, real secrets, generated production catalog data,
  cloud credentials, production support tooling, and one-off fixtures embedded
  inside mockups.
- Production SDK/CLI/API behavior, Planner/Gatekeeper/ResourceActor runtimes,
  visual application implementation, and launch claims.

## Proof

Run the focused proof with:

```powershell
pnpm --prefix src\draft\exp-proofs\dx-resource-lifecycle-fixture-corpus test
```

The tests prove:

- every required lifecycle scenario and artifact is present;
- every scenario carries shared resources, links, manifest IR, DeploymentPlan,
  Deployment Set, Delta, Gatekeeper decision, ResourceActor event, projection,
  log, drift, import/adopt, migration-phase, and support-evidence facts;
- fixtures are deterministic, redacted, tenant-safe, and reference-labeled by
  default;
- protobuf, CUE, and Pact boundaries are named for later packages;
- SDK, CLI, API, docs, and visual consumers can share the corpus without
  reauthoring domain facts;
- scope-out creep fails closed.

## Architecture Evidence

- `architecture/` - protobuf data shapes and CUE constraints for the corpus.
- `architecture/pacts/` - Pact interaction for the package boundary.
- `ADR.md` - parse-don't-validate derived type, experience decision, and event
  architecture evidence.
