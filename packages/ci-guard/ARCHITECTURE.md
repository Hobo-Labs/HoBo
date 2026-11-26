# @hobo/ci-guard — Architecture Evidence

Production CI fabric guard (HOBO-586). Historical HOBO-6 draft remains under
`src/draft/technical-proofs/ci-fabric-oidc-e2e-contract/`.

## Parse, Don't Validate

Untrusted workflow YAML and contract JSON cross exactly one parser boundary:
`parseCiFabricContract(input: JsonValue | undefined): CiFabricContract`.
`JSON.parse` is decoded into the package-local `JsonValue` tree (`src/json.ts`)
before that call. Downstream modules (`validateCiFabricContract`, fixture
runner, CLIs) accept only the refined parsed domain types — never raw DTOs plus
repeated boolean checks.

## Event Architecture

The fixture runner appends append-only `e2e.*` lifecycle events to
`test-results/e2e-events.jsonl`:

- **Command** — `runExampleFixture` with phase `deploy-and-assert` | `teardown` | `sweep-orphans`
- **Event** — `e2e.FixtureDeployed`, `e2e.LiveUrlAsserted`, `e2e.FixtureTornDown`, `e2e.OrphanSwept`
- **Actor** — simulated sandbox fixture runner (deterministic, labeled simulate mode)
- **Event store** — JSONL file; prior lines are never rewritten
- **Materialized view / projection** — summaries derive from the event log
- **Snapshot** — latest event per type for a run id
- **Read store** — CI artifacts read the JSONL tail

## Boundaries

- Consumer `@hobo/ci-guard` (this POC) ↔ provider `hobo-oidc-token-broker` (PACT in `contracts/pacts/`)
- Workflow validator reads `.github/workflows/*.yml` as untrusted text at the seam
