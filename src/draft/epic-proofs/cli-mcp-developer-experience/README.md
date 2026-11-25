# CLI, MCP & Developer Experience Reference Implementation

This epic reference implementation composes the CLI, MCP, local-dev, auth, role-flow, and DX hardening POCs into one runnable architecture slice. It does not implement production CLI binaries, real Yard services, real cloud providers, or live MCP transports. Every service boundary is mocked and contract-pinned.

## Vertical slices

```gherkin
Feature: Developer can move from local authoring to governed deployment

  Persona: App developer

  Scenario: Build, inspect, and deploy a Snapshop app without cloud-specific code
    Given a generated HoBo project and a deterministic local dev loop
    When the developer runs new, dev, plan, up, inspect, doctor, and logs surfaces
    Then the same command contract supports mocked Camp deployment and projection reads
```

```gherkin
Feature: Agent tools use the same control surface as the CLI

  Persona: AI agent operator

  Scenario: Run MCP plan/deploy through an SVID-bound session
    Given the MCP server advertises CLI-parity tools
    When an agent calls plan with valid SVID scope and deploy without required scope
    Then plan succeeds, deploy fails closed, and audit events carry policy decisions
```

```gherkin
Feature: Operators can audit and repair deployment journeys

  Persona: GitOps, SecOps, SRE, and DevOps operators

  Scenario: Exercise CI, policy denial, drift remediation, and canary rollout paths
    Given deterministic mocked identity, policy, runtime, gateway, and projection providers
    When each role runs its documented HoBo path
    Then the simulation exposes read-only previews, blocked unsafe actions, replay evidence, and rollback state
```

## Running the epic simulation

Command:

```bash
npm.cmd --prefix src\draft\epic-proofs\cli-mcp-developer-experience run simulate
```

What this proves:

- CLI command registry and MCP tools stay parity-checked.
- App-dev, GitOps, SecOps, SRE, and DevOps role journeys run against deterministic mocked boundaries.
- Credential hardening, SVID-bound MCP calls, local-dev fidelity labels, and operations manifests fail closed when scoped too broadly.
- The validated MCP server hardening proof is included in this rollup; its deterministic simulation contract is unchanged.
- Pact fixture inventory matches the boundaries the simulation exercises.

Mocked boundaries:

- CLI command path: in-process command registry and POC harnesses.
- MCP control surface: SVID verifier, token broker, and MCP server are fixture-bound.
- Runtime local/Camp projection: dev loop, plan/up, inspect/log projections, and doctor checks are deterministic fixtures.
- Identity/policy gateway: SVID, OIDC, policy.Decided, token audit, and credential store are in-memory.
- Operations manifest discovery: generated `llms.txt`, `llms-full.txt`, and `docs.json` are served from memory.

Contracts:

- `contracts/pacts/cli-command-path.pact.json`
- `contracts/pacts/mcp-control-surface.pact.json`
- `contracts/pacts/runtime-projection-boundary.pact.json`
- `contracts/pacts/identity-policy-boundary.pact.json`
- `contracts/pacts/operations-manifest-boundary.pact.json`

## Cascade absorption

The anonymous preview proof replaced broad runtime type checks with exact
object and string tags. The CLI/MCP rollup's bounded preview path, policy
denials, and runtime projection contracts remain unchanged and continue to be
covered by the existing deterministic simulation.

The dev-loop, login, logs, doctor, and up-convergence proof changes are
absorbed without changing the bounded CLI/MCP journeys or fail-closed gates.


Operations-manifest changes are absorbed without changing the bounded CLI/MCP journeys or fail-closed gates.

## Architecture Evidence

> **Promotion (S1-20 / HOBO-610):** production CLI shell + `hobo new` live in [`packages/cli`](../../../../packages/cli/). This epic proof still pins CLI↔MCP parity via `contracts/pacts/cli-command-path.pact.json`.

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Cli Mcp Developer Experience.
- `architecture/pacts/` — PACT contract for the package boundary.
- `architecture.md` — parse-don't-validate and event-architecture evidence.

## Cascade reconciliation (83d9b5c92)

The `vscode-extension-contract` technical proof refresh is absorbed without changing the CLI/MCP experience evidence.
