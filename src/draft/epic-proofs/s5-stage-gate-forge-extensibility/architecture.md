# Reference Architecture

## Epic outcome

Stage 5 closes when a single CI-runnable drill proves the roadmap gate: `hobo forge <url>` → certified signed provider; stub port → promoted AI implementation through eval; gated live-fix with auto-rollback and trace-to-test retention.

## Personas

| Persona | Goal | Reference slice |
|---|---|---|
| Platform engineer | Certify a forged provider and deploy a Bindle | Forge command, Registry install, Bindle deploy journey |
| ML-ops engineer | Promote a generated stub implementation | Eval promotion gate with trace replay |
| SRE | Repair via gated live-fix | Canary auto-rollback with regression test retention |
| SecOps reviewer | Refuse tampered or unsigned supply chain | Install verification adversarial cases |

## Vertical slice map

| Slice | Boundaries | Observable outcome |
|---|---|---|
| Forge certification | Generation pipeline, sandbox validation, certify stage | `gen.PluginCertified` + provenance |
| Registry install | Signed artifact publish/install | Available to Matching, not auto-selected |
| Bindle deploy | Deploy orchestrator fixture | Resource `ready` with digest pin |
| Stub promotion | Eval promotion gate | `promote` outcome through four lenses |
| Live-fix rollback | Live-fix gated candidate | `rolled-back` + retained regression test |

## Guardrail evidence

Parse, don't validate: forge URL strings, rollout inputs, install candidates, and Pact fixtures cross a parser boundary before the epic simulation uses them. The parsed domain types are `ForgeDrillCommand`, `RegistryInstallDecision`, `BindleDeployPlan`, and `LiveFixRolloutPlan`; mocked providers receive only those derived types, not raw DTOs.

Event architecture: command handlers in epic actors emit events into an in-memory event-store. Materialized views and projections rebuild listing, deploy, and live-fix read models from that event stream; snapshots represent the current read model, and historical snapshots are retained in a read store so simulation reads never infer state from mutable provider internals.

## Scope review

In scope: epic rollup composing existing draft contracts, deterministic simulation, Pact inventory, adversarial negatives.

Out of scope: production `packages/forge`, real Firecracker, live model providers, production Registry transport, and full CLI binary wiring.
