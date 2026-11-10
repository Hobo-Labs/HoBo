# HoBo — Design Plan Suite

> A suite of inter-related design plans for **HoBo**, a **WIT/WASM** programmable surface (Component Model / wasmCloud) + cloud control plane — TypeScript is the first reference implementation, not a requirement ([ADR-0069](./adr/01-architecture-core.md#adr-0069)).
> This began as a **design-first repository** and is not yet a shipped HoBo product; it now pairs the design suite with a production `packages/` workspace (60+ package manifests, ~160k lines of non-test TypeScript) plus executable draft proof/contract packages under `src/draft/<kind>/<slug>` and validation scripts. Proofs prove design claims before production implementation; honest-scope caveats live in [live-provider-matrix](./live-provider-matrix.md) and the README status summary. The design is a set of capability docs plus contract records; each plan keeps a stable `#plan-NN` anchor so areas can still be cited precisely.

## Index

Each capability doc is one coherent decision area; some absorb more than one plan (the folded plan keeps its `#plan-NN` anchor in the host doc). Contract records pin public surfaces that cross multiple capability docs. Post-core cross-cutting capability deltas get their own discoverable row here, plus a Linear owner, proof README, traceability row, and executable `src/draft/<kind>/<slug>` proof instead of being folded into completed epics.

| Doc | Covers | Plans |
|---|---|---|
| [`vision.md`](./vision.md#plan-00) | Vision, positioning & guiding principles | 00, 17 |
| [`lineage.md`](./lineage.md) | The aggregate portrait & credits: every influence with posture, what's borrowed, divergence, and capture link | — |
| [`architecture.md`](./architecture.md#plan-10) | Reference architecture + monorepo/package layout | 10 |
| [`control-plane.md`](./control-plane.md#plan-04) | The Yard control plane; providers, IaC & build/VM adapters | 04 |
| [`sdk-api.md`](./sdk-api.md#plan-02) | SDK / API design (the four-layer model) | 02 |
| [`sdk-contracts.md`](./sdk-contracts.md) | Canonical public SDK signatures, defaults, conformance coverage, and implementation issue mapping | 02, 21 |
| [`closure-builder-public-api.md`](./closure-builder-public-api.md) | V1 explicit Bindle closure-builder public contract for `@hobo/bindles` | 02, 21 |
| [`technical-standards.md`](./technical-standards.md) | Cross-cutting implementation standards: latest stable TypeScript, Protobuf data contracts, CUE invariants/derivative object definitions, parse-don't-validate, and PACT boundary testing | — |
| [`fuzzing.md`](./fuzzing.md) | OSS-Fuzz-style CI: fast-check control-plane properties, narrow Jazzer.js harnesses, Schemathesis PR API fuzz, RESTler/Toxiproxy nightly against simulators only | — |
| [`build-s0-stage-gate-acceptance.md`](./build-s0-stage-gate-acceptance.md) | S0 stage gate acceptance: signed hello-bindle through CI with toolchain guards green; runnable signal is `.github/workflows/stage-gate-s0.yml` plus `@hobo/stage-gate` tests | — |
| [`build-s1-stage-gate-acceptance.md`](./build-s1-stage-gate-acceptance.md) | S1 stage gate acceptance: production runtime-port/component-host/sdk-parity conformance, offline `hobo dev` on hello-bindle, and replay==live re-pointed onto `@hobo/conformance`/`@hobo/cli`/`@hobo/runtime-local`; runnable signal is `.github/workflows/s1-stage-gate.yml` | — |
| [`dx-sdk-resilience-semantics.md`](./dx-sdk-resilience-semantics.md) | DX SDK resilience semantics vocabulary, acceptance matrix, and proof sequencing for retry/cancel/deadline/lifecycle behavior; contract-surface visibility via ADR-0136 | — |
| [`package-namespaces.md`](./package-namespaces.md) | Canonical package/import ownership for `@hobo/*` namespaces (incl. `@hobo/storage-sqlite`, `@hobo/runtime-browser`/`-wasm`/`-oci`/`-cloud-native`, `@hobo/stations`, `@hobo/trails`, `@hobo/connectivity`, EffectSpec ownership) | 02, 10, 21 |
| [`provider-redaction.md`](./provider-redaction.md) | `@hobo/provider-redaction`: the one redactor for provider text, why it is a leaf outside `@hobo/core`, and how its patterns are proved linear and never weaker than what they replaced | — |
| [`package-decomposition.md`](./package-decomposition.md) | Target package topology: request/declaration/capability manifests as independently maintained contracts (protobuf+CUE documents, WIT interfaces), broker/resolver separation, provider families, station core + CLI + the `station-local` runtime-discovery boundary, and one `@hobo/host` composition root | — |
| [`extension-points.md`](./extension-points.md) | **ADR-0156** normative extension-point catalog: every plug-in seam's id, owner, registration semantics, discovery, and gate; `hobo.plugin/v1` packaging rules for external providers; recorded follow-ups | — |
| [`adr/03-data-plane-sqlite-default.md`](./adr/03-data-plane-sqlite-default.md) | **ADR-0135** — SQLite default EventStore/runtime journal behind ports; single-owner partitions | — |
| [`adr/03-data-plane-effects-resiliency.md`](./adr/03-data-plane-effects-resiliency.md) | **ADR-0136** — EffectSpec on Contract IR + visible secondary ResilienceProfile | — |
| [`adr/03-data-plane.md`](./adr/03-data-plane.md#adr-0137) | **ADR-0137** — Session Replay on every App Kit (`@hobo/replay`); privacy-first; `replay.*`; Kit ≠ WIT membrane | — |
| [`adr/01-architecture-core.md`](./adr/01-architecture-core.md#adr-0138) | **ADR-0138** — Messaging plane unification; Kafka first-class capability provider; Dapr optional Camp runtime / ActorHost dual realization | 20, 21, 02 |
| [`messaging-dapr-kafka-note.md`](./messaging-dapr-kafka-note.md) | Maintenance note for Messaging + Kafka + Dapr surfaces, fidelity honesty, permanent non-goals | — |
| [`adr/yard-first-placement.md`](./adr/yard-first-placement.md) | Yard-first placement: Yard owns provider selection; Camp provider-neutral until attached; Camps movable via Trails | — |
| [`devx-devenv-nix.md`](./devx-devenv-nix.md) | DevX: devenv-first local shells; Nix optional IaC only — never default multi-cloud path ([ADR-0006](./adr/01-architecture-core.md#adr-0006)) | — |
| [`adr/01-architecture-core.md`](./adr/01-architecture-core.md#adr-0131) | **ADR-0131** — Station occupancy (hard control-plane isolation; Rails; pure Conductor) | — |
| [`stations.md`](./stations.md) | Station narrative home: occupancy, capabilities (`hobo.station-capability/v1`), localhost discovery (`hobo-code init`), dev-scenario dogfooding (ADR-0131/0155) | — |
| [`yard-bindings.md`](./yard-bindings.md) | Yard bindings narrative home: the Yard as capability→product binding authority, the seeded localhost Yard on Station init, `plan`/`init`/`handle` phases, the OOB test harness + CI preview lanes, and the drizzle-kit/Better Auth defaults (ADR-0157–0161; Alchemy-informed) | — |
| [`adr/01-architecture-core.md`](./adr/01-architecture-core.md#adr-0155) | **ADR-0155** — Station capabilities typed manifest; discovery-gated `hobo-code init`; dogfooded dev-scenario `station()` declarations | — |
| [`adr/02-identity-security.md`](./adr/02-identity-security.md#adr-0132) | **ADR-0132** — Continuous identity migration (dual-path; zero Bindle config) | — |
| [`adr/02-identity-security.md`](./adr/02-identity-security.md#adr-0134) | **ADR-0134** — HoBo Trails (app-owned continuous migration recipes; composes `identity.continuous`) | — |
| [`adr/07-portability-extensibility.md`](./adr/07-portability-extensibility.md#adr-0130) | **ADR-0130** — Hierarchical DNS-valid naming (`.hobo.localhost` / `.hobo.test`; never bare `.hobo`) | — |
| [`adr/07-portability-extensibility.md`](./adr/07-portability-extensibility.md#adr-0140) | **ADR-0140** — Launch ship targets A/B/C (OSS public · local-first npm · hosted beta/GA); default order A→B→C | — |
| [`adr/07-portability-extensibility.md`](./adr/07-portability-extensibility.md#adr-0143) | **ADR-0143** — TrafficRouting port: portable multi-backend routing intent with explicit partial realization | — |
| [`adr/07-portability-extensibility.md`](./adr/07-portability-extensibility.md#adr-0144) | **ADR-0144** — External-spec posture (Crossplane/OAM/CNAB mapped at the boundary, never depended on); Resource Definition versioning; thin SaaS adapters with typed impedance | — |
| [`adr/01-architecture-core.md`](./adr/01-architecture-core.md#adr-0145) | **ADR-0145** — Traits: declaratively attached operational behavior anchored on manifest annotations; trait-kind map over the nine existing mechanisms | — |
| [`adr/02-identity-security.md`](./adr/02-identity-security.md#adr-0146) | **ADR-0146** — Typed legal geography (JurisdictionId, DataClassification), fail-closed `evaluateResidency` + residency gate/policy pack, control→evidence packs | — |
| [`launch-ship-targets.md`](./launch-ship-targets.md) | Human-facing summary of ADR-0140 ship targets, S-stage interim cutlines, and claim rules | — |
| [`instances/`](./instances/README.md) | Populated readiness dashboard, go/no-go, accepted-risk, and residual human-blocker **instances** (dated snapshots; contracts stay in sibling docs) | — |
| [`pre-public-secret-scan.md`](./pre-public-secret-scan.md) | Target A runbook: full-history gitleaks before repo-public flip; evidence rules | — |
| [`adr/07-portability-extensibility.md`](./adr/07-portability-extensibility.md#adr-0147) | **ADR-0147** — HoBo Yard v2 (HIGHBALL): Phaser browser host required; `@hobo/yard-world` shared world model; OTLP-observed yard; provenance-badged signals | — |
| [`adr/07-portability-extensibility.md`](./adr/07-portability-extensibility.md#adr-0148) | **ADR-0148** — Pixel-RPG identity: sourced CC0 pixel art replaces the traced rubberhose surface | — |
| [`asset-sourcing-policy.md`](./asset-sourcing-policy.md) | Asset sourcing policy for the HIGHBALL! game surface: PD trace plates, CC0 audio, OFL fonts, re-inked references, license allowlist + CREDITS.md provenance | — |
| [`ai-native-agent-auth.md`](./ai-native-agent-auth.md#plan-06) | AI-native platform, agent auth & end-user auth | 06 |
| [`stage-3-agent-autonomy-acceptance.md`](./stage-3-agent-autonomy-acceptance.md) | Stage-3 (Agent Autonomy) acceptance record: scope in/out, promoted epic proofs, resolved stage-3 hooks, runnable stage gate | 06 |
| [`data-plane.md`](./data-plane.md#plan-32) | Event model & the data plane: sourcing/replay, reactivity, projections, migrations, search | 11, 32 |
| [`reliability-observability-cost.md`](./reliability-observability-cost.md#plan-05) | Reliability/HA, observability & cost/FinOps | 05 |
| [`finops-budget-routing-control-plane.md`](./finops-budget-routing-control-plane.md) | Post-core standards-first FinOps budget routing control plane: resource intent, metric contracts, Pareto routing, stability, decision graph, feedback governance, and DX/OpsX/FinX surfaces | — |
| [`provider-pricing-commercial-terms.md`](./provider-pricing-commercial-terms.md) | Provider commercial terms and deterministic fail-closed quotes in `@hobo/pricing`; dispatcher v1 unchanged (ADR-0176) | — |
| [`provider-pricing-scorecard.md`](./provider-pricing-scorecard.md) | Acceptance scorecard for provider pricing design (§1, §10, §12–§14); CI-enforced via `@hobo/pricing` design-scorecard eval | — |
| [`hosting-budget-transitions.md`](./hosting-budget-transitions.md) | Budgeted hosting placement and movement: effects, financial reservations, durable reconciliation, observed recovery and settlement | — |
| [`ci-runner-balancing-example.md`](./ci-runner-balancing-example.md) | CI runner balancing reference example + dogfood record: credit-aware dispatch of this repo's CI across GitHub-hosted, self-hosted, and third-party runner providers (`examples/ci-runner-balancing/`) | — |
| [`ci-relay-mesh.md`](./ci-relay-mesh.md) | Proposal: the CI relay as a mesh of equal nodes. Each node reads GitHub's queue and starts its own runners; nodes agree on who starts a job by weighted rendezvous ranking and a per-rank delay, so no relay is a single point of failure. Claiming core implemented in `@hobo/ci/mesh`; not yet wired | — |
| [`security-networking.md`](./security-networking.md#plan-12) | Security, networking & multi-tenant applications | 12, 50 |
| [`developer-experience.md`](./developer-experience.md#plan-07) | Developer experience: dashboards, CLI, status pages & availability | 07, 49 |
| [`cli-spec.md`](./cli-spec.md) | Canonical CLI verb surface + lifecycle semantics | — |
| [`hobo-code-isolation-runbook.md`](./hobo-code-isolation-runbook.md) | HoBo Code isolation platform matrix, promotion, and mandatory cleanup runbook (`hobo-code` binary / `@hobo/code`, ADR-0139) | — |
| [`deployment-dashboard-topology-explorer.md`](./deployment-dashboard-topology-explorer.md) | Productization M0 scope and acceptance for Deployment Dashboard & Topology Explorer | — |
| [`plan-diff-viewer.md`](./plan-diff-viewer.md) | Productization M0 scope and acceptance for Plan/Diff Viewer | — |
| [`security-verification.md`](./security-verification.md) | V1 vulnerability disclosure and security launch-blocker process | — |
| [`threat-model-security-review.md`](./threat-model-security-review.md) | Productization M0 scope and acceptance for v1 threat-model and security-review gates | — |
| [`anonymous-claim-threat-model.md`](./anonymous-claim-threat-model.md) | Threat boundaries and required controls for guest leases, claim bundles, sponsor-backed deployment, and migrate-on-claim (ADR-0151) | — |
| [`adr/03-data-plane.md`](./adr/03-data-plane.md#adr-0153) | **ADR-0153** — `@hobo/patterns` catalog, ontology-vector retrieval, explicit `hobo-code template` / `/template` zero-LLM route | — |
| [`pre-launch-outcome-contract.md`](./pre-launch-outcome-contract.md) | Productization M0 contract for pre-launch outcome baselines and v1 value evidence | — |
| [`ai-generation-launch-posture.md`](./ai-generation-launch-posture.md) | Productization M0 launch posture for AI-generation safety claims, limitations, and review routing | — |
| [`launch-blocker-taxonomy.md`](./launch-blocker-taxonomy.md) | Productization M0 launch-blocker severity taxonomy and go/no-go exception posture | — |
| [`v1-readiness-dashboard.md`](./v1-readiness-dashboard.md) | Productization M0 dashboard contract for V1 release readiness fields, source-of-truth rules, missing-evidence states, and scope boundaries | — |
| [`go-no-go-decision-record.md`](./go-no-go-decision-record.md) | Productization M0 go/no-go decision record and risk-acceptance workflow | — |
| [`organization-workspace-model.md`](./organization-workspace-model.md) | Productization M0 scope and acceptance for organization, workspace, project, tenant, and environment ownership | — |
| [`workspace-activation-telemetry-contract.md`](./workspace-activation-telemetry-contract.md) | Productization M0 contract for first-run workspace activation telemetry and privacy boundaries | — |
| [`e2e-test-matrix.md`](./e2e-test-matrix.md) | Productization M0 scope and acceptance for the E2E Test Matrix project | — |
| [`performance-load-tests.md`](./performance-load-tests.md) | Productization M0 scope, launch envelope, capacity assumptions, deterministic fixtures, threshold handoffs, and acceptance for Performance & Load Tests | — |
| [`chaos-resilience-tests.md`](./chaos-resilience-tests.md) | Productization M0 scope and acceptance for Chaos & Resilience Tests scenarios, steady-state hypotheses, blast-radius limits, abort rules, evidence handoffs, and follow-up gates | — |
| [`persona-operating-profile.md`](./persona-operating-profile.md) | Productization M0 contract for persona operating profile fields and v1 recommendation memory boundaries | — |
| [`launch-e2e-persona-matrix.md`](./launch-e2e-persona-matrix.md) | Productization M0 contract for launch e2e persona journeys and pass/fail thresholds | — |
| [`wasm-runtime-wit.md`](./wasm-runtime-wit.md#plan-20) | WASM/WASI runtime & WIT interface reference | 20 |
| [`authoring-resources-wiring.md`](./authoring-resources-wiring.md#plan-21) | Authoring: resource catalog, wiring/manifest, config & the Hobo Code DSL | 21 |
| [`twelve-factor-under-hobo.md`](./twelve-factor-under-hobo.md) | 12-factor under HoBo: links + config capability, not password-in-env (ADR-0141/0142) | — |
| [`platform-engineering.md`](./platform-engineering.md#plan-25) | Platform engineering: Matching, environments, drivers/packs, Relay/GitOps/pipelines | 25 |
| [`contracts-policy-flags.md`](./contracts-policy-flags.md#plan-29) | Contracts & compatibility, the policy plane & feature flags | 29 |
| [`generated-stack.md`](./generated-stack.md#plan-23) | AI generation, the generated stack, patchability & verification/testing | 23, 09 |
| [`operators-sre.md`](./operators-sre.md#plan-40) | Operator Agents (the Crew) & SRE incident management | 40 |
| [`governance-planes.md`](./governance-planes.md#plan-46) | Governance: compliance/data governance & AI safety | 46 |
| [`worked-example.md`](./worked-example.md#plan-19) | End-to-end worked example | 19 |
| [`walkthrough.md`](./walkthrough.md) | Role-organized ideal-state walkthrough: one app, six workflows (app dev · platform eng · GitOps · SecOps · DevOps · SRE) | — |
| [`billing-launch-policy.md`](./billing-launch-policy.md) | Productization M0 launch billing policy for plans, credits, invoices, payment failures, refunds, and provider/legal boundaries | — |
| [`usage-metering.md`](./usage-metering.md) | Productization M0 scope and acceptance for usage facts, showback dimensions, reconciliation evidence, and support/audit boundaries | — |
| [`usage-to-invoice-reconciliation.md`](./usage-to-invoice-reconciliation.md) | Productization M1 contract for usage-event to invoice-line evidence, corrections, late events, replay, disputes, privacy, and audit handoff | — |
| [`entitlements-plan-limits.md`](./entitlements-plan-limits.md) | Productization M0 scope and acceptance for plan tiers, entitlement categories, limit decisions, support overrides, and follow-up gates | — |
| [`tax-currency-receipt-obligations.md`](./tax-currency-receipt-obligations.md) | Productization M0 launch posture for tax, currency, receipts, invoice metadata, and unsupported jurisdictions | — |
| [`tenant-data-lifecycle.md`](./tenant-data-lifecycle.md) | Productization M0 tenant data inventory, deletion/export obligations, retention posture, residency sensitivity, and customer assurance handoffs | — |
| [`customer-assurance-evidence-packet.md`](./customer-assurance-evidence-packet.md) | Productization M0 customer assurance packet outline for DPA needs, subprocessors, evidence owners, launch limitations, and support/security handoffs | — |
| [`compliance-evidence-pack.md`](./compliance-evidence-pack.md) | Productization M0 scope and acceptance for customer assurance packet sections, owner/source boundaries, evidence states, gap routing, and unsupported claim limits | — |
| [`product-notifications-lifecycle.md`](./product-notifications-lifecycle.md) | Productization M0 taxonomy for product lifecycle notifications, preferences, delivery evidence, and scope boundaries | — |
| [`sbom-vulnerability-notice-evidence.md`](./sbom-vulnerability-notice-evidence.md) | Productization M0 evidence contract for SBOMs, dependency vulnerability posture, third-party notices, artifact provenance, and customer assurance readiness | — |
| [`release-artifact-provenance-retention.md`](./release-artifact-provenance-retention.md) | Productization M0 handoff for release artifact provenance, retention, invalidation/yank, offline bundles, and support/debug access | — |
| [`artifact-store.md`](./artifact-store.md) | Productization M0 scope and acceptance for artifact classes, custody states, access evidence, retention handoffs, yanks, and support-safe artifact evidence | — |
| [`package-cache.md`](./package-cache.md) | Productization M0 scope and acceptance for package cache subjects, digest evidence, invalidation, offline availability, and support handoffs | — |
| [`npm-publish-allowlist.md`](./npm-publish-allowlist.md) | First-publish npm allowlist, `0.1.0-alpha.x` prerelease policy, dual-bin (`@hobo/hobo` only), manual `workflow_dispatch` publish dry-run | — |
| [`live-provider-matrix.md`](./live-provider-matrix.md) | Honest matrix: provider/IaC realize vs cred-gated live apply vs in-memory/stub (H-E5) | — |
| [`marketplace-publisher-trust-evidence.md`](./marketplace-publisher-trust-evidence.md) | Productization M0 evidence contract for marketplace publisher trust tiers, review evidence, and launch limitations | — |
| [`marketplace-payout-hooks.md`](./marketplace-payout-hooks.md) | Productization M0 scope and acceptance for publisher payout-readiness states, tax/identity handoffs, billing reconciliation, and payout launch limitations | — |
| [`marketplace-ux.md`](./marketplace-ux.md) | Productization M0 scope and acceptance for marketplace browse, trust warnings, installability outcomes, org-catalog visibility, accessibility, and support handoffs | — |
| [`publisher-portal.md`](./publisher-portal.md) | Productization M0 scope and acceptance for publisher profile, maintainer roles, listing evidence, review status, payout-readiness handoffs, support wording, and follow-up gates | — |
| [`capability-review-approval.md`](./capability-review-approval.md) | Productization M0 scope and acceptance for capability review states, approval outcomes, trust-tier evidence, yanking, escalation, and follow-up gates | — |
| [`provenance-retention.md`](./provenance-retention.md) | Productization M0 scope and acceptance for artifact provenance, retention classes, audit export, support handoff, and customer assurance evidence | — |
| [`meta-cloud-broker.md`](./meta-cloud-broker.md) | Productization M0 scope and acceptance for hosted broker authority, broker artifacts, Resolution Receipts, Resolution Rejections, and follow-up gates | — |
| [`hobo-broker.md`](./hobo-broker.md) | Runtime architecture of the HoBo Broker: policy-governed brokering of Bindle/Camp/Yard/Junction placements across providers, wrapping the policy (OPA-shaped), contract (Gatekeeper/PACT), billing, delivery (Argo), and connector-registry planes (`@hobo/broker`) | — |
| [`stage-2-first-cloud-yard-acceptance.md`](./stage-2-first-cloud-yard-acceptance.md) | Production Build S2 acceptance record: stage gate, decided open questions (first provider, IaC stack model, drift policy, deployed wasm-host), owning lanes, promoted epic proofs, and target packages for First Cloud + Yard | — |
| [`stage-4-multi-cloud-acceptance.md`](./stage-4-multi-cloud-acceptance.md) | Production Build S4 acceptance record: five-part multi-cloud gate, package map, promoted epic proofs, overlay/Planner/Crossplane hook decisions, Matching placement, and S4-02..S4-09 follow-up gate | — |
| [`stage-5-forge-extensibility-acceptance.md`](./stage-5-forge-extensibility-acceptance.md) | Production-build Stage-5 (Forge & Extensibility) acceptance record: stage gate restatement, package ownership map, generation-hook decisions D1–D4, promoted proof evidence, and follow-up gate | — |
| [`launch-support-escalation.md`](./launch-support-escalation.md) | Productization M0 launch support escalation matrix, incident communication templates, and support gap routing | — |
| [`incident-communications.md`](./incident-communications.md) | Productization M0 scope and acceptance for incident communication states, templates, customer-safe publication gates, support handoffs, and follow-up gates | — |
| [`public-status-page-incident-communication.md`](./public-status-page-incident-communication.md) | Productization M0 public status-page scope, component taxonomy, incident states, maintenance notices, update cadence, and customer communication boundaries | — |
| [`status-page-sidecar.md`](./status-page-sidecar.md) | Default status-page sidecar implementation record: station/primitives/project/bindle availability slices, event-sourced projection, redaction-gated publishing, Statuspage-v2 JSON interop, ADR-0145 default-on trait | — |
| [`support-workflow.md`](./support-workflow.md) | Productization M0 scope and acceptance for support intake, triage states, customer-safe evidence, owner routing, redaction/access boundaries, and follow-up gates | — |
| [`support-sla-channels.md`](./support-sla-channels.md) | Productization M0 support SLA language, channel coverage, response targets, unsupported request routing, and owner signoff boundaries | — |
| [`enterprise-deployment-hardening.md`](./enterprise-deployment-hardening.md) | Productization M0 scope for enterprise deployment hardening postures, evidence handoffs, customer-facing claim limits, and follow-up gates | — |
| [`example-apps.md`](./example-apps.md) | Productization M0 scope and acceptance for example apps | — |
| [`tutorials-walkthroughs.md`](./tutorials-walkthroughs.md) | Productization M0 scope and acceptance for Tutorials & Walkthroughs | — |
| [`troubleshooting-guides.md`](./troubleshooting-guides.md) | Productization M0 scope and acceptance for Troubleshooting Guides | — |
| [`launch-demo-golden-path.md`](./launch-demo-golden-path.md) | Productization M0 golden path and proof asset checklist for the launch demo | — |
| [`launch-messaging-claims.md`](./launch-messaging-claims.md) | Productization M0 evidence register for launch claims and demo assets | — |
| [`v1-critical-path-dependencies.md`](./v1-critical-path-dependencies.md) | Productization M0 dependency map for beta and GA release critical path blockers | — |
| [`outcome-activation-rail.md`](./outcome-activation-rail.md) | Productization M0 scope and acceptance for the v1 outcome activation rail | — |
| [`workspace-onboarding-ux.md`](./workspace-onboarding-ux.md) | Productization M0 scope and acceptance for Workspace & Onboarding UX | — |
| [`customer-onboarding.md`](./customer-onboarding.md) | Productization M0 scope and acceptance for Customer Onboarding pilot entry, first-run success criteria, support handoffs, and follow-up gates | — |
| [`accessibility-usability-launch-baseline.md`](./accessibility-usability-launch-baseline.md) | Productization M0 launch baseline for accessibility, usability, evidence, and exception boundaries | — |
| [`release-notes-upgrade-guide.md`](./release-notes-upgrade-guide.md) | V1 release notes and upgrade-guide outline contract | — |
| [`release-channels.md`](./release-channels.md) | Productization M0 scope and acceptance for release channel taxonomy, states, evidence gates, and follow-up boundaries | — |
| [`known-limitations-register.md`](./known-limitations-register.md) | Customer-facing v1 known limitations, scope-out states, support/docs/messaging handoffs, and beta/GA review checkpoints | [`known-limitations-register-contract`](../../src/draft/exp-proofs/cx/known-limitations-register-contract/README.md) |
| [`docs-portal.md`](./docs-portal.md) | Productization M0 scope and acceptance for docs portal content areas, source ownership, search metadata, support handoffs, known limitations, and follow-up gates | — |
| [`beta-pilot-feedback.md`](./beta-pilot-feedback.md) | Productization private-beta cohort, feedback intake, triage, release-candidate exit, and GA handoff evidence contract | — |
| [`customer-onboarding.md`](./customer-onboarding.md) | Productization M0 first-customer onboarding script, success criteria, support handoff, and pilot-note routing contract | — |
| [`dogfood-yard.md`](./dogfood-yard.md) | Productization M0 dogfood Yard acceptance scenarios and telemetry evidence | 04, 05, 07, 40 |
| [`upgrade-migration-engine.md`](./upgrade-migration-engine.md) | Productization M0 scope and acceptance for upgrade paths, migration dry-run, rollback evidence, and support handoff | — |
| [`upgrade-test-suite.md`](./upgrade-test-suite.md) | Productization M0 scope and acceptance for upgrade scenario coverage, fixtures, evidence fields, result states, and suite handoffs | — |
| [`bootstrap-installer.md`](./bootstrap-installer.md) | Productization M0 scope and acceptance for SaaS, self-host, and local/dev bootstrap installer paths | — |
| [`backup-restore.md`](./backup-restore.md) | Productization M0 scope and acceptance for backup sources, restore paths, RPO/RTO drill evidence, and recovery handoffs | — |
| [`settings-project-lifecycle.md`](./settings-project-lifecycle.md) | Productization M0 settings and project lifecycle scope, state model, ownership, and evidence gate | — |
| [`environment-lifecycle.md`](./environment-lifecycle.md) | Productization M0 scope and acceptance for environment classes, lifecycle states, transition owners, support evidence, and follow-up gates | — |
| [`admin-console.md`](./admin-console.md) | Productization M0 scope and acceptance for Admin Console navigation, read models, action intents, audit/redaction, and support/security boundaries | — |
| [`admin-support-breakglass-boundaries.md`](./admin-support-breakglass-boundaries.md) | Productization M0 boundary for admin/support emergency access, approval, audit, TTL, notification, revocation, and unsupported actions | — |
| [`audit-explorer.md`](./audit-explorer.md) | Productization M0 scope and acceptance for Audit Explorer audit facts, tenant-first filters, export evidence, redaction, and support/security/governance boundaries | — |
| [`support-debug-tools.md`](./support-debug-tools.md) | Productization M0 scope and acceptance for support-safe diagnostic bundles, recovery routes, redaction, incident handoff, and support/debug boundaries | — |
| [`member-rbac-administration.md`](./member-rbac-administration.md) | Productization M0 scope and acceptance for member lifecycle, RBAC administration, role boundaries, and audit handoff | — |
| [`tenant-isolation-quotas.md`](./tenant-isolation-quotas.md) | Productization M0 scope and acceptance for tenant isolation axes, quota dimensions, owning boundaries, and M1 evidence gates | — |
| [`org-catalogs.md`](./org-catalogs.md) | Productization M0 scope and acceptance for org catalog kinds, approval states, evidence fields, owner handoffs, and scope boundaries | — |
| [`resource-garbage-collection.md`](./resource-garbage-collection.md) | Productization M0 scope and acceptance for resource garbage classes, cleanup eligibility, orphan evidence, owner handoffs, and safe cleanup boundaries | — |
| [`teardown-recovery.md`](./teardown-recovery.md) | Productization M0 scope and acceptance for teardown states, dependency-drain evidence, recovery decisions, cleanup/support handoffs, and safe teardown boundaries | — |
| [`drift-reconciliation.md`](./drift-reconciliation.md) | Productization M0 scope and acceptance for drift classes, reconciliation states, source-of-truth evidence, owner handoffs, and follow-up gates | — |
| [`stage-6-production-hardening-acceptance.md`](./stage-6-production-hardening-acceptance.md) | Stage-6 (Production Hardening) acceptance record: ratified HA/DR/canary/FinOps hooks, promoted epic proofs, restated stage gate, and the S6-02..S6-10 follow-up gate | — |
| [`compatibility-matrix.md`](./compatibility-matrix.md) | Productization M0 browser, device, platform, CLI bootstrap, and support-routing compatibility matrix | — |

**Decisions** live in [`adr/`](./adr/index.md) — 4 thematic decision docs plus standalone/split-out ADR files (each decision is a `#adr-NNNN` section). The current ADR/Plan -> Linear coverage gate is [`traceability.md`](./traceability.md). Executable draft proofs and contract packages live under [`../../src/draft/`](../../src/draft/): technical proofs in [`../../src/draft/technical-proofs/`](../../src/draft/technical-proofs/), experience proofs in [`../../src/draft/exp-proofs/`](../../src/draft/exp-proofs/), epic rollups in [`../../src/draft/epic-proofs/`](../../src/draft/epic-proofs/) and registered in [`../../src/draft/epic-proofs/_registry.md`](../../src/draft/epic-proofs/_registry.md), and project MVP rollups in [`../../src/draft/projects/`](../../src/draft/projects/). Registry `Status` is operational metadata: `complete` means the linked rollup PR has merged, while `in_review` is reserved for an open rollup PR.

**Stage gates:** [`build-s1-stage-gate-acceptance.md`](./build-s1-stage-gate-acceptance.md) is the production S1 acceptance record (runtime-port/component-host/sdk-parity conformance, offline `hobo dev`, replay == live); [`proofs/s1-stage-gate/index.md`](./proofs/s1-stage-gate/index.md) is the originating draft-proof record it re-points from. The standing S1 CI lane is `.github/workflows/s1-stage-gate.yml`; the S2 and S3 gates are `.github/workflows/s2-stage-gate.yml` (First Cloud + Yard, evidence in [`stage-2-first-cloud-yard-acceptance.md`](./stage-2-first-cloud-yard-acceptance.md)) and `.github/workflows/s3-stage-gate.yml` (Agent Autonomy, evidence in [`stage-3-agent-autonomy-acceptance.md`](./stage-3-agent-autonomy-acceptance.md)).

**Archived planning material** (not part of the current design state — revived when the work is scoped): the **roadmap / build sequence** and the formal **requirements suite** (BRD/PRD/TRD + BR→FR/NFR→TR traceability) live in [`../archive/`](../archive/); the archived roadmap's stages 0–6 are superseded by the M0–M4 phase model ([ADR-0116](./adr/07-portability-extensibility.md#adr-0116)). The design-relevant scope boundary and NFR/SLO targets are kept in the design itself ([ADR-0063](./adr/07-portability-extensibility.md#adr-0063)/[ADR-0064](./adr/07-portability-extensibility.md#adr-0064)/[ADR-0021](./adr/07-portability-extensibility.md#adr-0021)).

**Competitor references** live in [`../competitors/`](../competitors/). Displaced-alternative lineage is recorded as ADRs — e.g. the Nomad scheduler pillar ([ADR-0106](./adr/01-architecture-core.md#adr-0106), parity in [`../competitors/nomad.md`](../competitors/nomad.md#primitive-mapping)).

**Scope.** The suite covers one designed platform surface plus its launch program, with two distinct bounds. (1) **Platform capability surface:** every numbered plan is in scope, bounded by the AI-native-meta-cloud-minus-monetization line ([ADR-0063](./adr/07-portability-extensibility.md#adr-0063)/[ADR-0064](./adr/07-portability-extensibility.md#adr-0064)) — HoBo the product ships no billing/monetization capability (no `billing` port, invoicing, tax, rev-share, or subscriptions); build sequencing/phasing of this surface is deferred planning (archived). (2) **Productization & launch records:** the "Productization M0/M1" rows in the index above (for example [`billing-launch-policy.md`](./billing-launch-policy.md), [`usage-metering.md`](./usage-metering.md), [`usage-to-invoice-reconciliation.md`](./usage-to-invoice-reconciliation.md), [`entitlements-plan-limits.md`](./entitlements-plan-limits.md), [`tax-currency-receipt-obligations.md`](./tax-currency-receipt-obligations.md), [`marketplace-payout-hooks.md`](./marketplace-payout-hooks.md)) describe how the hosted HoBo offering itself is launched, billed, and operated as a business — vendor operating records with their own M0/M1 phasing, not platform capabilities, so they do not move the ADR-0064 cut line; their release-readiness evidence phases through the M0-M4 gates recorded in [ADR-0116](./adr/07-portability-extensibility.md#adr-0116).

**Reading order.** New to HoBo: [Vision](./vision.md#plan-00) → [Architecture](./architecture.md#plan-10) → [Worked example](./worked-example.md#plan-19), then the two deep plans [SDK](./sdk-api.md#plan-02) and [AI-native/agent-auth](./ai-native-agent-auth.md#plan-06). Want it by role: the [Walkthrough](./walkthrough.md) takes one app through six clean workflows — app developer, platform engineer, GitOps, SecOps, DevOps, and SRE — each with its own loop and one shared verb (`hobo up`). Runtime/authoring model: [WASM/WASI](./wasm-runtime-wit.md#plan-20) → [Resources/`.allow()`/wiring](./authoring-resources-wiring.md#plan-21) → [AI implementations](./generated-stack.md#plan-23). Evaluating vs alternatives: [Positioning](./vision.md#plan-17) + [`docs/competitors/`](../competitors/). Auditing decisions: the [ADR docs](./adr/index.md).

---

## Context

**Problem.** Shipping software still forces application developers to become part-time platform engineers: picking clouds, wiring IaC, designing for HA, and operating infra. Tools today force a bad trade — either an opinionated closed PaaS (simple but locked-in, e.g. **Lakebed**) or raw multi-cloud IaC (powerful but heavy). Neither is built for the world that's coming, where **AI agents are the primary builders and deployers**.

**What HoBo is.** An *intermediary cloud control plane* with a developer-centric, cloud-agnostic programmable surface that is **WIT/WASM** (the Component Model / wasmCloud) — **TypeScript is the first reference implementation, not a requirement**; any Component-Model language authors against the same WIT interfaces ([ADR-0069](./adr/01-architecture-core.md#adr-0069)). Developers describe their app once through **PaaS / SaaS / CaaS / IaaS abstractions**; a **provider pattern** (ports & adapters) maps those abstractions onto real providers. You can map the whole app to a single provider ("just host this on Azure, figure it out"), split tiers across providers, or pin specific boundaries to specific providers — and drop to typed **provider-specific options** when you want to optimize. IaC tools (Pulumi, Crossplane, Terraform/OpenTofu) and image/VM tools (Dagger, Packer, Vagrant, Firecracker) are themselves pluggable via the same ports/adapters pattern.

**Why it wins.** Write cloud-agnostic code that ships anywhere; reach for provider-native power only when you want to. The API *feels like* [Vercel Workflows](https://workflow-sdk.dev/) for its durable `workflow`/`step` ergonomics, but the durable runtime is **HoBo-native and provided per [Camp](#glossary--naming-thematic-all-tunable)** (no dependency on any single vendor's runtime). The whole system is **AI-native**: actor-model + choreography sagas over a replayable event store, agents as first-class authenticated users, a machine-readable **auth/capability standard** so agents self-provision credentials with zero developer effort, and AI-generated provider plugins instead of relying on a community to write them.

**Intended outcome.** A self-hostable (or hosted) **hobo-cloud** orchestrator + an SDK such that a developer (or an agent) can `hobo up` an app and have it land on real infrastructure — agnostic by default, optimizable on demand.

### Competitive frame vs Lakebed (what we deliberately do differently)

Full capture + parity tracker: [`docs/competitors/lakebed`](../competitors/lakebed.md#primitive-mapping).

| Dimension | Lakebed | HoBo |
|---|---|---|
| Unit of deploy | "Capsule" (one full-stack TS app on their runtime) | **Bindle** (app topology mapped to *any* provider mix) |
| Cloud model | Single closed hosted runtime | **Cloud-agnostic** ports/adapters, multi-provider, self-hostable |
| IaC | Hidden, none exposed | Pluggable **IaC providers** (Pulumi/Crossplane/Terraform/OpenTofu) |
| Runtime model | Synchronous RPC (queries/mutations) | **Actors + durable workflows + choreography sagas** over a replayable event store |
| Agents | Agent-readable contracts; basic guest/Google auth | **Agents as first-class authenticated principals**; auto-token issuance via a capability standard; durable AI agents; MCP control surface |
| Extensibility | Community / first-party | **AI-generated provider plugins** gated by conformance tests |

---

## Glossary & naming (thematic, all tunable)

HoBo's metaphor is the itinerant worker who travels light. Names are proposals; technical meaning is what matters.

The canonical term source is [`glossary.md`](./glossary.md). The canonical event-family source is [`event-families.md`](./event-families.md). Naming note: `hobo:sdk` is the WIT contract/package; `@hobo/sdk` is the operator SDK. The `docs:design-lint` gate fails on duplicate glossary terms, broken internal links or anchors, unindexed ADR references, `hobo:sdk`/`@hobo/sdk` ambiguity, and event families used outside the catalog.

## Technical standards

All implementation-facing design work follows the cross-cutting standards in [`technical-standards.md`](./technical-standards.md): latest stable TypeScript over vanilla JavaScript, Protobuf for data contracts, CUE for invariants/dependent constraints and derivative object definitions, parse-don't-validate at trust boundaries, and PACT-style contract tests for integration edges. These standards reinforce the suite's existing WIT/WASM portability model by catching schema, compatibility, and invariant drift before runtime.

## Keeping docs current

When a draft package, validation script, workflow, or public contract changes, update this design suite or the nearest proof/contract README in the same change. CI runs `pnpm run docs:freshness` so implementation-facing changes cannot merge without a documentation update.

- [Contract-First Testing Strategy](./contract-first-testing.md)

## HoBo.CI SDK family

[HoBo.CI contracts and routing](../../packages/ci/README.md),
[GitHub Actions relay](../../packages/ci-gh-actions/README.md) (one core; hosted
as a Node service by `hobo ci serve` and the container image, on
[Vercel](../../packages/ci-vercel/README.md), and by the box worker daemon),
[Azure Pipelines self-hosted integration](../../packages/ci-ado/README.md), and
[implementation plan with live acceptance gates](../plans/hobo-ci/README.md).
