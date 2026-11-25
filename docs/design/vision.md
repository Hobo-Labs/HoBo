---
type: Reference
title: "Vision, Positioning & Guiding Principles"
description: "HoBo is an **AI-native meta-cloud** — a meta cloud-orchestration layer that is **security-first**, **AI-native**, **platform-engineering & GitOps built-in**, and — beyond portabili"
tags: [hobo, design]
---

# Vision, Positioning & Guiding Principles

## Plan 00

> **Platform-engineering framing (Humanitec parity):** HoBo embraces the Internal Developer Platform **"5-plane"** framing — it is the **Integration & Delivery plane orchestrator** — and the **developer-vs-platform-engineer separation of concerns**: developers declare *what* (IfC resources), platform engineers declare *how* via **Resource Definitions** matched per environment ([Plan 25](./platform-engineering.md#plan-25)). "Agnostic by default, optimizable on demand" also means "simple for developers, governable by platform teams."

HoBo is an **AI-native meta-cloud** — a meta cloud-orchestration layer that is **security-first**, **AI-native**, **platform-engineering & GitOps built-in**, and — beyond portability — **patchable**. It competes head-on with **Convex, [Lakebed](../competitors/lakebed.md), and Nitric**. The AI-native promise is concrete: a built-in roster of **Operator Agents (the Crew)** runs the platform ([Plan 40](./operators-sre.md#plan-40)), and HoBo **generates, self-heals, and persists** the app — infrastructure and UI — across a five-layer **generated stack** — data · business · message · intelligence · UI ([Plan 23](./generated-stack.md#plan-23)) — AI-generated adapters/projections/handlers + self-optimizing trained methods + design.md-driven app UI ([ADR-0056](./adr/03-data-plane.md#adr-0056)). HoBo's cloud is **only the cross-cloud orchestration plane**; everything else runs on the user's chosen providers.

**Pitch:** *"Write your app once. HoBo — the AI-native meta-cloud — decides how to host it, and gets out of the way when you want control. Built for humans and the agents that work for them."* The programmable surface is **WIT/WASM** (the Component Model / wasmCloud); **TypeScript is the first reference implementation, not a requirement** — any Component-Model language authors against the same WIT interfaces ([ADR-0069](./adr/01-architecture-core.md#adr-0069)).

### Principles (design north stars)
1. **Agnostic by default, optimizable on demand.** Provider-specific options are always a `.with(...)` away, never required.
2. **Everything is replayable.** Deployments, workflows, actor state, and *token issuance* are events in an append-only log → audit, recovery, and time-travel for free.
3. **Agents are users, not afterthoughts.** Every capability is reachable via SDK, CLI, **and** MCP, with first-class agent identity.
4. **Ports over platforms.** Cloud, IaC, and build/VM are all the same ports/adapters shape. New backends are adapters, ideally AI-generated.
5. **Self-host = hosted.** The Yard is itself a HoBo bindle (dogfood); the only difference is who runs it.
6. **Conformance is the contract.** Every port ships a contract test suite; any adapter (human- or AI-written) must pass it.
7. **Nested scopes.** `Junction` (cross-cloud / hybrid; connects Yards) ⊃ `Yard` (a **provider-specific** cross-Camp scope — **owns provider selection**, one provider's cross-Camp policy + that provider's control plane) ⊃ `Camp` (a **provider-neutral** deployment target until Yard-attached; **infers** provider from the Yard and provides the durable runtime under it; **movable across Yards via Trails**) ⊃ `Bindle` (the app's provider-agnostic config). HoBo defines its **own runtime ports** rather than adopting any vendor's runtime concept ([README glossary](./index.md#glossary--naming-thematic-all-tunable), [yard-first-placement](./adr/yard-first-placement.md)).
8. **Secretless-first.** Config and secrets resolve to *references* (per Camp), not stored values; access prefers workload identity + brokered short-lived tokens over static secrets ([Plan 21](./authoring-resources-wiring.md#plan-21)).
9. **Patchable, not just portable.** Portability moves the *app* across backends ([ADR-0024](./adr/07-portability-extensibility.md#adr-0024)); **patchability** lets you change *HoBo itself* — swap any engine, add any adapter, fork the Yard, and persist AI/human patches — with conformance as the trust bridge ([Plan 23](./generated-stack.md#plan-23)/[ADR-0057](./adr/07-portability-extensibility.md#adr-0057)).
10. **AI-native operations & generation.** Built-in **Operator Agents** (SRE/Endpoint Monitor/GitOps/Platform Engineer) run the platform ([Plan 40](./operators-sre.md#plan-40)); the **generated stack** ([Plan 23](./generated-stack.md#plan-23)) generates/self-heals/persists the app (adapters/projections/handlers/trained methods + design.md-driven UI) across data·business·message·intelligence·UI — one loop, one trust boundary, one persistence mechanism ([ADR-0056](./adr/03-data-plane.md#adr-0056)).
11. **Security-first.** Agentic auth (SVID/OIDC, brokered short-lived tokens), policy gates at every phase, and **continuous/live security scanning + remediation** ([Plan 6](./ai-native-agent-auth.md#plan-06)/[Plan 12](./security-networking.md#plan-12)/[Plan 29](./contracts-policy-flags.md#plan-29)) — the SRE/security operator + OCSF audit close the loop.

### Configuration surfaces
- **Client-configurable** (per app/team): **IaC providers** ([Plan 4](./control-plane.md#plan-04)), **auth** ([Plan 6](./ai-native-agent-auth.md#plan-06)/[Plan 6](./ai-native-agent-auth.md#plan-06)), and **secrets / vars / config-as-a-service** ([Plan 21](./authoring-resources-wiring.md#plan-21)).
- **Cloud-configurable** (the orchestration plane): **trainable code** — model, evals, training data ([Plan 23](./generated-stack.md#plan-23)/[ADR-0025](./adr/03-data-plane.md#adr-0025)) — and **cross-cloud integrations** (the Junction, [ADR-0043](./adr/07-portability-extensibility.md#adr-0043); cross-Camp state, [ADR-0040](./adr/01-architecture-core.md#adr-0040)).

### Non-goals
- Being a general PaaS UI for non-developers.
- Replacing Terraform/Pulumi (HoBo *orchestrates* them).
- **SaaS-business functions** — billing, subscriptions, invoicing, tax/VAT, chargeback, monetization, rev-share. HoBo is not a payments/commerce product ([ADR-0064](./adr/07-portability-extensibility.md#adr-0064)).

## Plan 17

### The one-line position
**HoBo is an AI-native meta-cloud — a cloud-agnostic *control plane* and durable runtime that maps a single app description onto any mix of real providers — agnostic by default, optimizable on demand, and operable by agents end to end.** The programmable surface is **WIT/WASM** (the Component Model / wasmCloud); **TypeScript is the first reference implementation, not a requirement** — any Component-Model language can author against the same WIT interfaces ([ADR-0069](./adr/01-architecture-core.md#adr-0069)). It competes head-on with **Convex, [Lakebed](../competitors/lakebed.md), and Nitric**; it is not a single PaaS, not "just IaC," and not Kubernetes-only.

**Default runtime + open providers.** The default host is **self-hosted wasmCloud** (lattice on k8s / Coolify / bare metal — no managed-cloud dependency; wasm-in-container is the zero-infra floor, [ADR-0031](./adr/01-architecture-core.md#adr-0031)). The provider set is an **open seed list** — self-host, **Hetzner**, **Cloudflare**, **Vercel**, AWS/Azure/GCP, Fly — behind swappable ports, with the generation pipeline generating more on demand; it's documented to *prove* portability, never to cap it ([providers matrix](./control-plane.md#plan-04), [ADR-0024](./adr/07-portability-extensibility.md#adr-0024)).

### The landscape (and the gap HoBo fills)
| Product | Category | Cloud-agnostic? | Escape hatch | Runtime model | Agent/AI-native? | Self-host? |
|---|---|---|---|---|---|---|
| **Lakebed** | Agent-native PaaS | ❌ (own runtime) | endpoints/env only | sync RPC | reads contracts; basic auth | ❌ |
| **Vercel + Workflow SDK** | PaaS + durable exec | partial (runtime ports) | Vercel-native | durable workflows/steps | DurableAgent | runtime self-host |
| **SST** (v3 "Ion") | IfC framework (Pulumi/TF) | ◐ (AWS-centric; 150+ providers, non-portable) | raw Pulumi/TF resources | serverless + containers (Fargate) | no | ✅ (OSS core; Console SaaS) |
| **Encore** | Backend framework | ✅ (AWS/GCP) | config overrides | typed services | no | ✅ |
| **Nitric** | Cloud-agnostic framework (IfC) | ✅ | plugin/custom provider (Go) | functions/resources | no | ✅ |
| **Wing** | Cloud language | ✅ | `bring` modules | preflight/inflight | no | ✅ |
| **Pulumi** | IaC SDK | ✅ | full SDK | n/a (provisioning) | no | ✅ |
| **Crossplane** | K8s control plane | ✅ | compositions | reconcilers (CRDs) | no | ✅ (k8s) |
| **Radius** | App platform | ✅ | recipes | app model | no | ✅ |
| **Humanitec** | Platform Orchestrator (IDP) | ✅ | Resource Definitions + drivers | k8s-centric (v2 any-compute) | MCP (2026) | ✅ (self-host) |
| **Score / KubeVela / OAM** | Workload spec | ✅ | traits/policies | k8s-centric | no | ✅ |
| **Nomad + Nomad Pack** | Workload scheduler/orchestrator | ✅ (schedule-anywhere; backing services stay environment-specific) | task drivers + custom plugins | HCL jobspecs → allocations | no | ✅ |
| **wasmCloud** | Wasm actor/provider runtime | ✅ | capability providers + links | components + providers | no | ✅ |
| **Fermyon Spin / SpinKube** | Wasm serverless | ✅ (wasm) | spin triggers/components | wasm components | no | ✅ |
| **.NET Aspire** | App composition/orchestration | partial | annotations / custom resources | containers + projects | no | ✅ |
| **HoBo** | **AI-native control plane** | **✅** | **typed `.with(...)` + WIT links** | **wasm components + actors + durable workflows + sagas (event-sourced)** | **agents as principals; Capability Manifest; generation pipeline (providers+impls); MCP** | **✅ (the Yard is a Bindle)** |

**The gap:** every cloud-agnostic option above is either (a) IaC-flavored (you still think in infra), (b) Kubernetes-bound, or (c) not AI-native — and the wasm runtimes (wasmCloud/Spin) and orchestrators (Aspire) solve *runtime/wiring* — and schedulers (Nomad) solve *placement* — but not multi-cloud provisioning, agents, or durable workflows. Every AI-native option (Lakebed, Vercel) is single-runtime / locked-in. **No one combines cloud-agnostic ports/adapters (as WIT interfaces) + a wasm-default polyglot runtime + a Vercel-grade durable runtime + Nitric-style IfC/`.allow()` + Aspire-style wiring + agents-as-first-class + AI-generated providers AND implementations + a self-hostable control plane.** That intersection is HoBo. (Detailed Nitric and Lakebed captures + parity in [`docs/competitors/nitric`](../competitors/nitric.md) / [`docs/competitors/lakebed`](../competitors/lakebed.md).) (Detailed Nomad capture + parity in [`docs/competitors/nomad`](../competitors/nomad.md#primitive-mapping); displacement recorded in [ADR-0106](./adr/01-architecture-core.md#adr-0106).)

### What HoBo borrows (deliberately)

> The full aggregate portrait — every influence with posture, borrowing, and
> divergence — lives in [`lineage.md`](./lineage.md); this list stays the
> founding-borrow summary.
- **From Vercel Workflows:** the durable `workflow`/`step` feel and the **runtime** ports/adapters for the runtime.
- **From Lakebed:** ruthless onboarding, machine-readable contracts (`llms.txt`), server authority — and we extend "machine-readable" from the app to *operations* (MCP).
- **From Crossplane/Radius:** reconciliation + the dev-vs-platform separation (here: the provider-agnostic `bindle()` vs provider-specific `camp()`/`yard()` scope objects, and provider recipes/equivalence classes).
- **From Pulumi:** real-language IaC via the Automation API as our primary mechanism.
- **From SPIFFE/OAuth/MCP-auth:** keyless workload identity + token brokering for agents.
- **From Nitric:** the full resource catalog, inline `.allow()` → least-privilege, and Infrastructure-from-Code (default authoring) — see [Plan 21](./authoring-resources-wiring.md#plan-21).
- **From WASI/Component Model + wasmCloud:** ports as **WIT interfaces**, providers as **capability providers**, `bind` as **links**, and a polyglot wasm-default runtime — see [Plan 20](./wasm-runtime-wit.md#plan-20).
- **From .NET Aspire:** `WithReference` wiring, uniform config for any component/container, annotations, and the **manifest IR** — see [Plan 21](./authoring-resources-wiring.md#plan-21). Detailed capture + parity in [`docs/competitors/aspire`](../competitors/aspire.md).
- **From HashiCorp Nomad (founding pillar; runtime since pivoted):** heterogeneous workload orchestration/scheduling, bin-packing-style placement, and federation — realized in HoBo through the self-hosted wasmCloud lattice default ([ADR-0031](./adr/01-architecture-core.md#adr-0031)) and the Junction ⊃ Yard ⊃ Camp scopes; the Nomad→wasmCloud pivot is an accepted decision, with the full concept-by-concept mapping in [`docs/competitors/nomad`](../competitors/nomad.md#primitive-mapping).
- **From Humanitec:** **Resource Definitions + Matching** (dynamic configuration management — the platform-rules layer, [Plan 25](./platform-engineering.md#plan-25)), the **Driver** taxonomy + Resource Packs + Workload Profiles ([Plan 25](./platform-engineering.md#plan-25)), **Deployment Sets/Deltas** + environment types/cloning/ephemeral ([Plan 25](./platform-engineering.md#plan-25)), the **Agent**/GitOps/**Pipelines** ([Plan 25](./platform-engineering.md#plan-25)), and the IDP **5-plane** framing (HoBo = the Integration & Delivery plane orchestrator). HoBo's edges: auditable matching (`match.Decided`), wasm-first, event-sourced replay, AI-generated definitions, OSS core — see [`docs/competitors/humanitec`](../competitors/humanitec.md).

> **The head-on competitor set:** as an **AI-native meta-cloud**, HoBo competes directly with **Convex, Lakebed, and Nitric** — Convex (a reactive TypeScript backend-as-a-service whose end-to-end codegen + Management/OAuth API corroborate HoBo's generated-clients ([Plan 20](./wasm-runtime-wit.md#plan-20)) and control-plane/provisioning APIs ([Plan 4](./control-plane.md#plan-04)), and which HoBo now targets as a deploy-target CloudProvider via `@hobo/provider-convex` ([ADR-0144](./adr/07-portability-extensibility.md#adr-0144)) — head-on competitor *and* supported backend ([`docs/competitors/convex`](../competitors/convex.md))), Lakebed (agent-native PaaS, above; [`docs/competitors/lakebed`](../competitors/lakebed.md)), and Nitric (cloud-agnostic IfC framework, above). HoBo's edge over all three is the agnostic-ports + durable event-sourced runtime + agents/generation pipeline intersection.
>
> **Adjacent products (not head-on competitors), captured for reference:** **shoo.dev** — a zero-config Google-sign-in broker (PKCE + ES256/JWKS) that composes with HoBo's identity model for *end-user* auth, orthogonal to HoBo's *workload/agent* identity ([Plan 6](./ai-native-agent-auth.md#plan-06), [`docs/competitors/shoo`](../competitors/shoo.md)).

### Intent lineage (five pillars)

HoBo's founding composed intent is **"HashiCorp Nomad + .NET Aspire + Nitric with some FinOps and agent-native experiences."** This subsection is the canonical intent→design map inside the design suite; the ongoing audit register lives at [`GAPS.md`](../../GAPS.md).

| Pillar | Original contribution | Where it lives in the design |
|---|---|---|
| **P1 Nomad** | heterogeneous workload orchestration/scheduling, bin-packing placement, federation | [`control-plane.md`](./control-plane.md#plan-04), [`platform-engineering.md`](./platform-engineering.md#plan-25), [`adr/01-architecture-core.md`](./adr/01-architecture-core.md); accepted wasmCloud pivot ([ADR-0031](./adr/01-architecture-core.md#adr-0031)), mapping in [`../competitors/nomad.md`](../competitors/nomad.md#primitive-mapping) |
| **P2 Aspire** | local-dev orchestration, app composition/wiring, dev dashboard, polyglot DX | [`developer-experience.md`](./developer-experience.md#plan-07), [`sdk-api.md`](./sdk-api.md#plan-02), [`authoring-resources-wiring.md`](./authoring-resources-wiring.md#plan-21), [`../competitors/aspire.md`](../competitors/aspire.md) |
| **P3 Nitric** | cloud-agnostic Infrastructure-from-Code, portable resource ports, `.allow()` least privilege | [`authoring-resources-wiring.md`](./authoring-resources-wiring.md#plan-21), [`wasm-runtime-wit.md`](./wasm-runtime-wit.md#plan-20), [`../competitors/nitric.md`](../competitors/nitric.md) |
| **P4 FinOps** | cost as a first-class input: estimates, budgets, showback, cost-aware placement | [`reliability-observability-cost.md`](./reliability-observability-cost.md#plan-05), [`finops-budget-routing-control-plane.md`](./finops-budget-routing-control-plane.md), [ADR-0071](./adr/01-architecture-core.md#adr-0071) |
| **P5 Agent-native** | agents as first-class principals and operators: identity, MCP, Crew, generation | [`ai-native-agent-auth.md`](./ai-native-agent-auth.md#plan-06), [`operators-sre.md`](./operators-sre.md#plan-40), [`generated-stack.md`](./generated-stack.md#plan-23) |

The only accepted intent-level pivot is Nomad's scheduler/runtime role moving to wasmCloud; intent-pillar coverage is traced in [`traceability.md`](./traceability.md#intent-pillar-coverage).

### Defensible differentiators (the moat)
1. **AI-native operations, not just AI-readable apps** — agents deploy, optimize, and self-heal via MCP with first-class identity + audit.
2. **Capability Manifest standard + Registry** — a network effect: providers self-describe capabilities/auth, agents self-provision, and the **generation pipeline** auto-generates missing providers (no community bottleneck).
3. **Event-sourced everything** — replay/time-travel/audit across both control and data planes is a property competitors would have to re-architect to match.
4. **Genuine agnostic + escape hatch in one model** — the same Bindle ships to one provider or many, with typed provider-specific optimization that doesn't fork the code. The agnosticism extends to the **integration surface**: auth IdPs (WorkOS/Auth0/Supabase Auth/Entra), artifact repos (npm/NuGet/PyPI/OCI), and operator integrations (issue trackers, knowledge bases) are all **swappable ports, only-registered-considered, auto-generatable** ([ADR-0073](./adr/07-portability-extensibility.md#adr-0073)) — no vendor is wired in.
5. **Contracts, policy & evals are native graph artifacts, not bolted-on tools** — consumer-driven compatibility (`can-deploy`, [Plan 29](./contracts-policy-flags.md#plan-29)), a unified policy plane with obligations ([Plan 29](./contracts-policy-flags.md#plan-29)), and eval-gated promotion ([Plan 23](./generated-stack.md#plan-23)) compose into one `hobo verify`. The four-lens taxonomy (**Contract / Eval / Policy / Trace**) is built in, and **engines sit behind ports** — Pact/OPA/Cedar are *optional adapters*, never the conceptual model or a dependency.
6. **Incremental, not greenfield-only** — `hobo import` adopts an existing Terraform/Pulumi/Lakebed/FaaS estate **in place** and coexists with un-migrated infra (strangler-fig), so teams move onto HoBo without a big-bang rewrite ([ADR-0041](./adr/07-portability-extensibility.md#adr-0041)) — a path Lakebed's closed runtime doesn't offer.
7. **A built-in operator workforce (the Crew)** — SRE / Endpoint Monitor / GitOps / Platform Engineer ship as **autonomous, audited, policy-gated Yard services** ([Plan 40](./operators-sre.md#plan-40)), not a DIY agent kit; competitors expose APIs, HoBo ships the operators that drive them.
8. **A generated, self-healing stack — infrastructure and app/UI** — HoBo generates/self-heals/persists across **data·business·message·intelligence·UI** ([Plan 23](./generated-stack.md#plan-23)) via **AI-generated adapters** (providers/implementations behind ports), **self-optimizing runtime functions** (`"use training"`), and **design.md-driven UI generation** (OpenUI/json-render/mcp-apps behind the `ui-render` port) bound to the typed reactive data plane ([ADR-0056](./adr/03-data-plane.md#adr-0056)).
9. **Patchable, not just portable** — beyond "same app, N clouds," you can derive your own HoBo (swap any engine, fork the Yard) and persist AI/human patches, with conformance as the trust bridge ([Plan 23](./generated-stack.md#plan-23)/[ADR-0057](./adr/07-portability-extensibility.md#adr-0057)) — closed PaaS offers neither guarantee.
10. **Nitric's building blocks, on the Component Model** — HoBo matches Nitric's runtime building-block set (apis, kv, buckets, queues, topics, secrets, sql, schedules, websockets, jobs) but realizes each as a **WIT interface**, so **providers code against WIT** (not per-language Go plugins; auto-generatable) and the membrane is **wRPC** — wasmCloud's WIT-native RPC, generated from the same WIT — instead of plain gRPC. A **thin SDK** is typed sugar over the runtime with no cloud logic, deny-by-default falls out of linking, and one contract drives local/cross-process/lattice ([ADR-0069](./adr/01-architecture-core.md#adr-0069)). The **SDK itself is WIT-first** — every language SDK is `wit-bindgen`'d against a canonical **`hobo:sdk`** WIT package + a **conformance-gated idiom layer** (hand-authored or SWE-operator-generated), so multi-language support is a generation+parity task, not N hand-written reimplementations that drift ([ADR-0072](./adr/01-architecture-core.md#adr-0072)) — where Nitric ships per-language plugin SDKs. DX edge: `hobo dev` auth is a **contract-satisfied fixture** — the bypass cannot drift from prod because the same `auth` contract gates deploy ([ADR-0070](./adr/02-identity-security.md#adr-0070)).
11. **Cost routing that turns multi-cloud into a budget — the Dispatcher** — because HoBo already runs the *same* deterministic selector across **only the providers you register**, cost optimization is a native capability, not a spreadsheet exercise: a **`maximize-credits`** objective ranks every placement, CI-runner/build-machine dispatch, and (stateless) traffic decision by **effective marginal cost** from a credit/budget ledger — so HoBo **burns free GitHub-Actions/Blacksmith/Depot/cloud credits first and rotates as each is exhausted or resets**, with the choice deterministic + auditable (`dispatch.Decided`) ([ADR-0071](./adr/01-architecture-core.md#adr-0071)). A single-cloud PaaS structurally cannot do this; multi-cloud IaC makes you wire it by hand.
12. **Govern HoBo itself, not just the infra (enterprise lockdown)** — orgs lock down **HoBo's own control-plane surface** (who registers providers, changes policy, sets cost routing, runs the generation pipeline, approves deploys, reads audit), because every control-plane action is a **deny-by-default, RBAC-gated, audited** policy decision over a `hobo:*` taxonomy, with **mandatory SCP-style policy rules (deny-ceilings)** at the Yard/Junction that lower scopes can't widen and **SSO/SCIM** role binding ([ADR-0074](./adr/02-identity-security.md#adr-0074)). The Crew operators obey the same RBAC. A closed PaaS governs its own surface only as far as its dashboard exposes; raw IaC governs the infra but not "who may change the platform."
13. **Progressive delivery is the core, behind open ports — the Harness** — releasing a change isn't a bolt-on: the **Harness** ([ADR-0083](./adr/02-identity-security.md#adr-0083)) is a first-class core that takes a deployed change to users through three pluggable standard-shaped ports over OTEL — **OpenFeature** (flags), **OpenDelivery** (canary/blue-green/rollouts + Flagger-style automated rollback), **OpenExperiment** (A/B + stats) — built-in defaults with adapters for Argo Rollouts/Flagger/Spinnaker and Statsig/GrowthBook/Optimizely. The deploy gate decides *whether*, the Harness decides *how*; the core pattern only changes if the industry's dominant release pattern does.

### Who HoBo is NOT for (honest scoping)
- Teams happy on a single cloud with deep native tooling and no agnostic need (SST or the AWS CDK is simpler). Detailed SST capture + parity in [`docs/competitors/sst`](../competitors/sst.md).
- Pure-Kubernetes shops already invested in Crossplane/KubeVela (HoBo can sit on top, but it's not k8s-first).
- Apps that need bare-metal/extreme-perf control where any abstraction is a liability.

### Key risks (and how the design hedges)
- **Lowest-common-denominator trap** → mitigated by the `.with(...)` escape hatch + `require`/`prefer` so power is never out of reach.
- **Abstraction leakage / debugging across providers** → mitigated by event-sourced replay + the topology/cost graph showing exactly where things landed.
- **Provider breadth is a treadmill** → mitigated by the generation pipeline + conformance suite (AI generates, contracts certify).
- **Trusting AI-generated infra code** → mitigated by sandboxed conformance + signed provenance ([Plan 12](./security-networking.md#plan-12)).
- **"Yet another abstraction" skepticism** → mitigated by matching Lakebed's onboarding and letting users drop to provider-native instantly.
