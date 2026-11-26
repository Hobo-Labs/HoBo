# POC Rollup Ledger: CLI, MCP & Developer Experience

| POC | Source | Related Linear | Persona | BDD scenario | Vertical slice | Service boundaries | Pact contracts | Reference impl status | Disposition | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| CLI shell contract | `src/draft/technical-proofs/hobo-cli-shell-contract` | HOBO-115 | App developer, AI agent operator | Canonical verbs route through one command registry | CLI/MCP shared command surface | CLI command path, operations manifest | `cli-command-path.pact.json`, `operations-manifest-boundary.pact.json` | in_progress | integrated | Kept canonical verb list and schema parity guard. |
| New scaffold contract | `src/draft/technical-proofs/hobo-new-scaffold-contract` | HOBO-118 | App developer | `hobo new snapshop -t api` creates deterministic fixture project | App developer local-to-Camp loop | CLI command path, runtime projection | `cli-command-path.pact.json`, `runtime-projection-boundary.pact.json` | in_progress | integrated | Used through app-developer journey. |
| Dev loop contract | `src/draft/technical-proofs/hobo-dev-loop-contract` | HOBO-122 | App developer | `hobo dev` hot-reloads and replays state | Local dev fidelity | Runtime projection boundary | `runtime-projection-boundary.pact.json` | in_progress | integrated | Kept deterministic replay and fork-lane concepts. |
| Plan preview contract | `src/draft/technical-proofs/hobo-plan-preview-contract` | HOBO-125 | App developer, GitOps operator, AI agent operator | `hobo plan --camp` is read-only and addressable | CLI/MCP shared plan path | CLI command path, MCP control surface | `cli-command-path.pact.json`, `mcp-control-surface.pact.json` | in_progress | integrated | Used by CLI, MCP, and GitOps simulation. |
| Up convergence contract | `src/draft/technical-proofs/hobo-up-convergence-contract` | HOBO-130 | App developer, SecOps, GitOps | `hobo up` converges only after gates pass | Governed deploy path | Runtime projection, identity/policy | `runtime-projection-boundary.pact.json`, `identity-policy-boundary.pact.json` | in_progress | integrated | Kept gate fail-closed and event evidence. |
| Down lifecycle contract | `src/draft/technical-proofs/hobo-down-lifecycle-contract` | HOBO-132 | GitOps operator | Preview Camp teardown is explicit and evented | CI preview lifecycle | Runtime projection | `runtime-projection-boundary.pact.json` | in_progress | integrated | Used through GitOps preview lifecycle. |
| Login/claim contract | `src/draft/technical-proofs/hobo-login-claim-contract` | HOBO-136 | App developer, AI agent operator | SVID-backed credentials are stored by reference | Identity handoff | Identity/policy boundary | `identity-policy-boundary.pact.json` | in_progress | integrated | Reference uses credential-hardening and MCP SVID harnesses instead of plaintext creds. |
| Inspect projection contract | `src/draft/technical-proofs/hobo-inspect-projection-contract` | HOBO-140 | App developer, DevOps, SRE | Inspect reads run or rollout projection state | Projection reads | Runtime projection | `runtime-projection-boundary.pact.json` | in_progress | integrated | Used through app-dev, SRE, and canary journeys. |
| Logs CLI contract | `src/draft/technical-proofs/hobo-logs-cli-contract` | HOBO-143 | DevOps, SRE | Logs expose progress without becoming control commands | Projection reads | Runtime projection | `runtime-projection-boundary.pact.json` | in_progress | integrated | Represented by event/log projections from role journeys. |
| Doctor contract | `src/draft/technical-proofs/hobo-doctor-contract` | HOBO-147 | App developer | `hobo doctor` reports toolchain, SVID, connectivity, and portability | DX health check | Runtime projection, identity/policy | `runtime-projection-boundary.pact.json`, `identity-policy-boundary.pact.json` | in_progress | integrated | Kept offline-capable deterministic fixture checks. |
| Codegen CLI contract | `src/draft/technical-proofs/hobo-codegen-cli-contract` | HOBO-152 | App developer | Generated fixture project remains portable | App developer loop | CLI command path, runtime projection | `cli-command-path.pact.json`, `runtime-projection-boundary.pact.json` | in_progress | integrated | Used by app-developer journey fixture writer. |
| Build Wasm provider contract | `src/draft/technical-proofs/build-wasm-provider-contract` | HOBO-156 | App developer | `hobo build` should remain in command surface | Build provider | CLI command path | `cli-command-path.pact.json` | not_started | deferred | Command is kept in parity checks; real build-provider host belongs to runtime/provider work. |
| Collect CLI contract | `src/draft/technical-proofs/hobo-collect-cli-contract` | HOBO-160 | App developer | Resource collection feeds plan/up and permission inference | App developer loop | CLI command path, runtime projection | `cli-command-path.pact.json`, `runtime-projection-boundary.pact.json` | in_progress | integrated | Used through app-developer journey resource collection. |
| Anonymous preview path contract | `src/draft/technical-proofs/anonymous-preview-path-contract` | HOBO-164 | App developer | `npx hobo up` creates bounded hosted preview | Anonymous preview | Identity/policy, runtime projection | `identity-policy-boundary.pact.json`, `runtime-projection-boundary.pact.json` | in_progress | integrated | Kept hosted preview as mocked, abuse-gated path. |
| MCP server contract | `src/draft/technical-proofs/hobo-mcp-server-contract` | HOBO-168 | AI agent operator | MCP tools expose CLI parity | MCP parity | MCP control surface, CLI command path | `mcp-control-surface.pact.json`, `cli-command-path.pact.json` | in_progress | integrated | Used tool specs, transport list, and parity assertion. |
| MCP SVID auth contract | `src/draft/technical-proofs/hobo-mcp-server-contract/src/mcp-svid-auth.ts` | HOBO-173 | AI agent operator, SecOps | Tool calls require SVID-scoped capability | MCP auth | MCP control surface, identity/policy | `mcp-control-surface.pact.json`, `identity-policy-boundary.pact.json` | in_progress | integrated | Deploy denial proves missing exact tool scope fails closed. |
| Operations manifests contract | `src/draft/technical-proofs/operations-manifests-contract` | HOBO-176 | AI agent operator | Agents discover CLI/MCP routes from manifests | Agent/docs discovery | Operations manifest boundary | `operations-manifest-boundary.pact.json` | in_progress | integrated | Generates and validates `llms.txt`, `llms-full.txt`, and `docs.json`. |
| VS Code extension contract | `src/draft/technical-proofs/vscode-extension-contract` | HOBO-180 | App developer | Editor can project CLI/MCP state | Editor DX | Runtime projection, operations manifest | `runtime-projection-boundary.pact.json` | not_started | deferred | Projection contracts are covered; editor UI is follow-up outside reference simulation. |
| CLI credential hardening contract | `src/draft/technical-proofs/cli-credential-hardening-contract` | HOBO-184 | App developer, SecOps | Static keys are refused and crash output is redacted | Credential hardening | Identity/policy boundary | `identity-policy-boundary.pact.json` | in_progress | integrated | Kept fail-closed static-key and redaction assertions. |
| Dev fidelity drift contract | `src/draft/technical-proofs/hobo-dev-fidelity-drift-contract` | HOBO-190 | App developer, SRE | Local mocked evidence cannot claim prod-ready | Fidelity honesty | Runtime projection boundary | `runtime-projection-boundary.pact.json` | in_progress | integrated | Kept mocked-vs-simulated labels and replay determinism. |
| MCP server hardening contract | `src/draft/technical-proofs/mcp-server-hardening-contract` | HOBO-194 | AI agent operator, SecOps | MCP tool scope, approval, revocation, and token scope are enforced | MCP security | MCP control surface, identity/policy | `mcp-control-surface.pact.json`, `identity-policy-boundary.pact.json` | in_progress | integrated | Kept delegated scope, destructive approval, token denial, and untrusted result rules; refreshed for the validated leaf hardening, with simulation and Pact evidence unchanged. |
| App developer journey contract | `src/draft/exp-proofs/dx/app-dev-journey-contract` | HOBO-198 | App developer | New/dev/inspect/up prove app path | App developer loop | CLI command path, runtime projection | `cli-command-path.pact.json`, `runtime-projection-boundary.pact.json` | in_progress | integrated | Primary happy-path simulation. |
| Platform engineer journey | no complete POC located in this epic pass | HOBO-203 | Platform engineer | Map Yard topology without crossing provider internals | Platform topology | Control plane, provider matching | deferred | not_started | split_follow_up | Requires platform-engineering/provider rollup to avoid crossing epic boundary. |
| GitOps CI journey contract | `src/draft/exp-proofs/dx/gitops-ci-journey-contract` | HOBO-208 | GitOps operator | CI plan is read-only and promotion uses keyless identity | CI control path | CLI command path, identity/policy, runtime projection | `cli-command-path.pact.json`, `identity-policy-boundary.pact.json`, `runtime-projection-boundary.pact.json` | in_progress | integrated | Kept OIDC, preview lifecycle, can-deploy skew, and rollback paths. |
| SecOps policy audit journey contract | `src/draft/exp-proofs/dx/secops-policy-audit-journey-contract` | HOBO-213 | SecOps reviewer | Mandatory deny ceiling blocks unsafe prod action | Policy audit | Identity/policy, CLI/MCP | `identity-policy-boundary.pact.json`, `mcp-control-surface.pact.json` | in_progress | integrated | Kept replayable `policy.Decided` and secret-leak checks. |
| SRE drift remediation journey contract | `src/draft/exp-proofs/dx/sre-drift-remediation-journey-contract` | HOBO-216 | SRE operator | Drift diagnosis waits for governed remediation | SRE repair path | Runtime projection, identity/policy | `runtime-projection-boundary.pact.json`, `identity-policy-boundary.pact.json` | in_progress | integrated | Kept read projection, approval guard, and replayable events. |
| DevOps self-host journey | no complete POC located in this epic pass | HOBO-219 | DevOps operator | Self-host Yard bootstrap | Self-host bootstrap | Provider/Yard bootstrap | deferred | not_started | split_follow_up | Belongs with platform/self-host bootstrap architecture, not CLI/MCP reference simulation. |
| DevOps canary rollout journey contract | `src/draft/exp-proofs/dx/devops-canary-rollout-journey-contract` | HOBO-224 | DevOps operator | Canary promotes on healthy SLO and rolls back on burn | Progressive delivery | Runtime projection, identity/policy | `runtime-projection-boundary.pact.json`, `identity-policy-boundary.pact.json` | in_progress | integrated | Kept rollout inspect/logs and reconstructable rollback state. |

## Cascade absorptions

Changes to referenced experience proofs that this rollup has taken in.

| Referenced proof | Change | Effect on this rollup |
|---|---|---|
| `src/draft/exp-proofs/dx/app-dev-journey-contract` | `data-models/proof.cue` | none |
| `src/draft/exp-proofs/dx/devops-canary-rollout-journey-contract` | `data-models/proof.cue` | none |
| `src/draft/exp-proofs/dx/gitops-ci-journey-contract` | `data-models/proof.cue` | none |
| `src/draft/exp-proofs/dx/secops-policy-audit-journey-contract` | `data-models/proof.cue` | none |
| `src/draft/exp-proofs/dx/sre-drift-remediation-journey-contract` | `data-models/proof.cue` | none |
| `src/draft/technical-proofs/anonymous-preview-path-contract` | anti-slop object/string boundary cleanup | Anonymous preview normalization and canonicalization retain the same bounded hosted-preview behavior and remain covered by the existing identity/policy and runtime projection evidence. |
| `src/draft/technical-proofs/hobo-dev-loop-contract` | latest validated leaf hardening | Dev-loop replay and projection evidence unchanged. |
| `src/draft/technical-proofs/hobo-doctor-contract` | latest validated leaf hardening | Doctor health-check behavior unchanged. |
| `src/draft/technical-proofs/hobo-login-claim-contract` | latest validated leaf hardening | Login/claim credential-reference behavior unchanged. |
| `src/draft/technical-proofs/hobo-logs-cli-contract` | latest validated leaf hardening | Logs projection behavior unchanged. |
| `src/draft/technical-proofs/hobo-up-convergence-contract` | latest validated leaf hardening | Up-convergence and fail-closed gate behavior unchanged. |

All of these are the same edit, applied across 58 draft proofs at once. Each
ships a `data-models/proof.proto` declaring `message ProofIdentity { string
slug = 1; string layer = 2; }` beside a `proof.cue` that defined a bare
anonymous `slug`/`layer` record — a record with no name to tie it to the
message it is supposed to constrain, which is what `architecture:guard`
reports as `missing-cue-constraints`. The record is now the named definition
`#ProofIdentity`, embedded at top level so the file still reads as the same
concrete data.

One constraint changed with it: `slug: string` became `slug: string & !=""`.
The old form restated proto3's declared type and refused nothing, so a proof
identifying itself with the empty string validated. Measured with cue v0.14.0,
old against new: `slug: ""` goes 0 → 1 and nothing else moves — a well-formed
record stays 0, `slug: 7` stays 1, `layer: "ux"` stays 1.

No disposition, evidence path, Linear link, or acceptance claim in the table
above moves. No proof in this epic identifies itself with an empty slug, so
nothing that validated before stops validating.

## Cascade absorptions (batch five)

| Referenced proof | Change | Effect on this rollup |
|---|---|---|
| `src/draft/technical-proofs/operations-manifests-contract` | latest validated leaf hardening | Operations-manifest and bounded CLI/MCP evidence unchanged. |

## Cascade absorptions (83d9b5c92)

| Referenced proof | Change | Effect on this rollup |
|---|---|---|
| `src/draft/technical-proofs/vscode-extension-contract` | final validated leaf hardening | CLI/MCP experience evidence unchanged. |
