# CLI, MCP & Developer Experience Architecture

## Architecture role

The selected epic owns the developer and agent control surface. The reference implementation therefore treats CLI verbs and MCP tools as one contract surface, then runs persona journeys through mocked downstream boundaries.

## Personas and slices

| Persona | BDD scenario | Vertical slice | Reference role |
|---|---|---|---|
| App developer | Build, inspect, and deploy Snapshop without cloud-specific code | CLI local-to-Camp loop | Proves `new`, `dev`, `plan`, `up`, `inspect`, `doctor`, `logs`, `codegen`, `collect`, and anonymous preview fit one path. |
| AI agent operator | Run SVID-bound MCP plan and fail-closed deploy | MCP parity and auth | Proves CLI/MCP parity, tool input validation, SVID scoping, token denial, and audit events. |
| GitOps operator | Run CI preview and guarded promotion | CI control path | Proves read-only plan, keyless OIDC, preview lifecycle, no mutation on can-deploy skew, and rollback command evidence. |
| SecOps reviewer | Deny unsafe prod object delete and preserve replay evidence | Policy audit | Proves mandatory deny ceiling, policy.Decided replay input, and credential audit evidence. |
| SRE operator | Diagnose drift and wait for gated remediation | Drift remediation | Proves projection diagnosis, approval guard, replayable event stream, and CLI read projections. |
| DevOps operator | Promote canary and roll back on SLO burn | Progressive rollout | Proves `hobo up --strategy canary`, inspect/log progress, SLO gate reuse, and rollback reconstruction. |

## Service boundaries

| Boundary | Consumer | Provider | Mock strategy | Contract |
|---|---|---|---|---|
| CLI command path | Reference simulation and tests | `hobo` command registry/POC command handlers | In-process command registry plus POC harnesses | `cli-command-path.pact.json` |
| MCP control surface | Agent MCP client | `@hobo/mcp` SVID-bound server | Fixture SVID verifier, in-memory audit sink, deterministic handlers | `mcp-control-surface.pact.json` |
| Runtime projection boundary | CLI/MCP reference app | Dev loop, plan/up, inspect/logs, doctor, Camp projections | Local fixture project, deterministic events, in-memory projection stores | `runtime-projection-boundary.pact.json` |
| Identity and policy boundary | CLI/MCP reference app | Identity, token broker, OIDC STS, policy gate | In-memory credential store, fixture OIDC/STSes, deterministic policy decisions | `identity-policy-boundary.pact.json` |
| Operations manifest boundary | Agents and docs clients | `llms.txt`, `llms-full.txt`, `docs.json` | Generated manifests served from memory | `operations-manifest-boundary.pact.json` |

## Scope review

The accepted POCs map to the selected epic because they prove command surfaces, agent surfaces, auth/credential behavior, local-fidelity honesty, and role workflows that use the CLI/MCP surface. The implementation keeps their behavior and testable contracts, not their production assumptions.

Discarded or deferred details:

- Real cloud provider drivers, Yard bootstrap, provider matching internals, and platform-engineering topology stay outside this epic.
- VS Code UI implementation is deferred because the epic reference path only needs the underlying projection/manifest contract.
- Wasm provider build output is deferred because production build-provider host behavior belongs to runtime/provider work.
- Live HTTP, STS, registry, or cloud calls are not used; all simulation providers are mocked.

Adversarial decisions:

- MCP deploy without exact scope must fail closed.
- Static cloud keys must be rejected and redacted from failure reports.
- Local-dev claims from mocked or camp-only evidence must not become prod-ready claims.
- Policy denial must preserve replayable `policy.Decided` evidence.
- Canary rollback and SRE remediation must be reconstructable from events, not inferred from final state alone.
## Guardrail evidence

Parse, don't validate: incoming command payloads, Pact fixtures, and protobuf/CUE-backed scenario records cross a parser boundary before the epic simulation uses them. The parsed domain types are the scenario commands, boundary fixtures, and role-flow records described above; mocked providers receive only those derived domain types, not raw DTOs.

Event architecture: command handlers in the epic actors emit events into an in-memory event-store. Materialized views and projections are rebuilt from that event stream, snapshots represent the current read model, and historical snapshots are retained in a read store so CLI, MCP, operator, and simulation reads never infer state from mutable provider internals.
