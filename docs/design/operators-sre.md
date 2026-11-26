---
type: Reference
title: "Operator Agents & SRE"
description: "This capability doc covers the operator-agent Crew and the deep-dive SRE model that lives within it."
tags: [hobo, design]
---

# Operator Agents & SRE

This capability doc covers the operator-agent Crew and the deep-dive SRE model that lives within it.

## Plan 40

> **Disambiguation (one word, four meanings):** **Operator Agent** = an autonomous principal in the Crew (this plan). **Agents-as-users** = *external/customer* agents acting on a developer's behalf ([Plan 6](./ai-native-agent-auth.md#plan-06)). The **`agent()` primitive** = the SDK runtime building block both use ([Plan 2](./sdk-api.md#plan-02)). The **[Relay](./platform-engineering.md#plan-25)** = the outbound network proxy, *not* an agent at all. The **[generation pipeline](./generated-stack.md#plan-23)** = a generation *pipeline*, not a principal.

### Why built-in (batteries-included), not just skills
HoBo is AI-native: the work a software + platform team does — triage incidents, watch endpoints, drive delivery, author platform rules, **write/refactor application code, generate the app's UI** — is exactly what an agent can do against HoBo's event-sourced, MCP-complete surface. Rather than leave each team to wire its own, HoBo **ships the Crew as built-in Yard services** ([ADR-0054](./adr/03-data-plane.md#adr-0054), FinOps roster extension [ADR-0117](./adr/03-data-plane.md#adr-0117)): opinionated, audited, policy-gated, sandboxed under enforced AI governance out of the box, while still **pluggable** — each agent's "brain" is an **engine behind a port** (built-in default; optional externals like HolmesGPT), and each is disableable / overridable per Yard. They are the AI-native realization of goals "AI SRE / AI GitOps / AI policy enforcement / AI software & UX."

### The shared model (every Crew member)
- **Principal identity.** Each agent is a named workload with an **SVID** and **per-agent policy** ([Plan 6](./ai-native-agent-auth.md#plan-06)/[Plan 29](./contracts-policy-flags.md#plan-29)): scoped capabilities, **spend caps**, and **high-risk → require-approval** gates (destroy/prod/over-budget resolve via a dashboard/Slack hook). Least-privilege by `.allow()` ([Plan 21](./authoring-resources-wiring.md#plan-21)).
- **Event-sourced runs.** Every observation, decision, tool call, token grant, and approval is an event ([Plan 11](./data-plane.md#plan-11)) → replayable, auditable ("why did the SRE agent roll back at 02:14?"), and resumable.
- **MCP-surfaced.** Each agent exposes its actions as MCP tools ([Plan 6 §MCP](./ai-native-agent-auth.md#plan-06)) so a human or an external agent can invoke, inspect, or override it — same identity/token model.
- **Engines behind ports.** The reasoning engine is a `*-engine` port with a built-in default and optional external providers (never on the SDK surface) — consistent with `training-engine`/`policy-engine`/`contract-engine` ([ADR-0025](./adr/03-data-plane.md#adr-0025)/[Plan 29](./contracts-policy-flags.md#plan-29)/[Plan 29](./contracts-policy-flags.md#plan-29)).
- **Human-in-the-loop by default for write actions.** Read/diagnose is autonomous; mutations ride the policy plane's effects/obligations (auto / canary-with-auto-rollback / require-approval), keyed by a computed safety envelope: blast radius + environment + reversibility + self-causation guards ([Plan 5](./reliability-observability-cost.md#plan-05)/[Plan 29](./contracts-policy-flags.md#plan-29)/[ADR-0094](./adr/02-identity-security.md#adr-0094)).
- **Sandboxed under enforced AI governance by default** ([ADR-0061](./adr/02-identity-security.md#adr-0061)/[ADR-0054](./adr/03-data-plane.md#adr-0054)). Every operator's reasoning + tool calls run in a capability-scoped sandbox with **NVIDIA NeMo Guardrails** + the **Microsoft AI governance / Responsible AI toolkit** as the default guardrail layer — moderation, jailbreak/PII checks, capability-scoped tool access. This is enforced, not optional; `guardrail.Blocked` + `policy.Decided` make every block replayable.

```mermaid
flowchart TB
  subgraph CREW["the Crew (built-in Yard operator agents)"]
    SRE["SRE"]
    EM["Endpoint Monitor"]
    GO["GitOps"]
    PE["Platform Engineer"]
    SWE["SWE"]
    UX["UX Designer"]
    FIN["FinOps"]
  end
  FIN -->|forecast / anomaly / commitment / optimization proposals| ADV["FinX advisory outputs -> gated Deltas (ADR-0039/0071)"]
  EM -->|SLO burn / drift signals| SRE
  SRE -->|gated live-fix| FIX["live-fix + canary/rollback (Plan 23/5)"]
  GO -->|promote / can-deploy| DEP["pipelines + gates (Plan 28/29)"]
  PE -->|author / auto-generate| DEFS["Resource Defs + policy packs (Plan 25/30/33)"]
  SWE -->|implement / refactor / repair| CODE["business + message code behind ports (Plan 23/33/41)"]
  UX -->|generate / maintain| UI["app UI via ui-render: design.md + OpenUI/json-render/mcp-apps (ADR-0056)"]
  CREW -->|identity + policy + events + MCP + enforced governance| YARD["the Yard (Plan 4)"]
```

### The roster
| Operator Agent | Owns | Composes (existing) | Optional external engine | Surfaces / events |
|---|---|---|---|---|
| **SRE** | incident detection → root-cause → **gated remediation** | live-fix ([Plan 23](./generated-stack.md#plan-23)), observability ([Plan 5](./reliability-observability-cost.md#plan-05)), drift + canary/auto-rollback ([Plan 5](./reliability-observability-cost.md#plan-05)), chaos findings ([ADR-0047](./adr/02-identity-security.md#adr-0047)) | **HolmesGPT** behind a port ([docs/technologies/holmesgpt-sre-agent.md](../technologies/holmesgpt-sre-agent.md)) | MCP `diagnose`/`heal`; rides `incident.*`/live-fix + `policy.Decided` |
| **Endpoint Monitor** | synthetic probes, health/SLO watch, drift surfacing | SLO/alerting ([ADR-0045](./adr/02-identity-security.md#adr-0045)), observability ([Plan 5](./reliability-observability-cost.md#plan-05)), drift ([Plan 5](./reliability-observability-cost.md#plan-05)) | external synthetic-check provider behind a port | emits `slo.BudgetBurned`/`alert.*`/drift → **feeds SRE** |
| **GitOps** | drive *when/what* deploys; promotion across env-groups | pipelines + publishers ([Plan 25](./platform-engineering.md#plan-25)), `can-deploy` ([Plan 29](./contracts-policy-flags.md#plan-29)), env-group saga ([ADR-0028](./adr/01-architecture-core.md#adr-0028)) | external GitOps controller (Argo/Flux) as publisher | MCP `promote`/`rollback`; rides `pipeline.*`/`deployment.*` |
| **Platform Engineer** | author + **auto-generate** Resource Definitions/Packs + policy packs | Matching ([Plan 25](./platform-engineering.md#plan-25)), packs ([Plan 25](./platform-engineering.md#plan-25)), policy ([Plan 29](./contracts-policy-flags.md#plan-29)), generation pipeline ([Plan 23](./generated-stack.md#plan-23)) | — (generation pipeline is the engine) | MCP `propose-definition`/`propose-pack`; AI counterpart to the human persona ([ADR-0019](./adr/07-portability-extensibility.md#adr-0019)) |
| **SWE** (software engineer) | implement / refactor / repair **business + message** code behind ports; **generate per-language idiom-layer SDKs** from `hobo:sdk` ([ADR-0072](./adr/01-architecture-core.md#adr-0072)) | generation pipeline ([Plan 23](./generated-stack.md#plan-23)), `"use training"` + persisted code-mutation ([Plan 23](./generated-stack.md#plan-23)/[ADR-0048](./adr/03-data-plane.md#adr-0048)), the generated stack ([Plan 23](./generated-stack.md#plan-23)), `wit-bindgen`/jco + the SDK conformance gate ([Plan 29](./contracts-policy-flags.md#plan-29)/[Plan 9](./generated-stack.md#plan-09)) | external coding-agent engine behind a port | MCP `implement`/`refactor`/`repair`; opens gated Deltas/PRs, rides `gen.*`/`impl.*`/`crew.*` |
| **UX Designer** | generate + maintain the app **UI** against **design.md** | `ui-render` port — OpenUI / json-render / mcp-apps ([ADR-0056](./adr/03-data-plane.md#adr-0056)); typed from the domain ([ADR-0051](./adr/03-data-plane.md#adr-0051)), reactive to materializations ([ADR-0050](./adr/03-data-plane.md#adr-0050)); persisted-mutation ([ADR-0048](./adr/03-data-plane.md#adr-0048)) | OpenUI / json-render / mcp-apps or custom adapter behind `ui-render` | MCP `generate-ui`/`update-ui`; design.md is the trust gate; rides `crew.*`/`policy.Decided` |
| **FinOps** | forecasts · anomaly signals · commitment recommendations · optimization proposals (**advisory-only**) | MeteringView + showback ([ADR-0039](./adr/02-identity-security.md#adr-0039)), CreditLedgerView + off-path Dispatcher advisory ([ADR-0071](./adr/01-architecture-core.md#adr-0071)), spend breaker + costAvailabilityProfile ([Plan 5](./reliability-observability-cost.md#plan-05)), FinX surface ([FinOps control plane](./finops-budget-routing-control-plane.md)) | external cost-recommendation engine behind a port | MCP `forecast`/`recommend-commitment`/`propose-optimization`; opens gated Deltas/PRs; rides `crew.*`/`spend.*`/`policy.Decided`; AI counterpart to the human FinOps-owner persona ([usage metering](./usage-metering.md)) |

> **The SRE operator has a deep-dive** ([SRE deep-dive](#sre-incident-management-runbooks--self-healing) below, [ADR-0058](./adr/03-data-plane.md#adr-0058)): the **Incident** aggregate + `incident.*` events, the diagnose → classify → **auto-fix / propose / escalate** decision tree, the runtime+contract **failure-taxonomy → safe-fix** map, declarative **runbooks**, MTTD/MTTR SLOs, on-call escalation, and postmortem-as-replay.

> **Operator integration ports** ([ADR-0073](./adr/07-portability-extensibility.md#adr-0073)): the Crew drives swappable, policy-gated **`issue-tracker`** (JIRA/GitHub Issues/Linear — the SRE syncs an Incident → ticket, the SWE files repair issues, GitOps links deploys) and **`knowledge`** (Confluence/Obsidian/Wikis — runbooks + postmortems-by-replay published, design notes) ports, reusing the `notify`/receiver-port pattern ([ADR-0059](./adr/03-data-plane.md#adr-0059)); these writes ride `crew.ActionApplied` + `policy.Decided` — no new event families. Named/auto-generatable seams.

### Events
Crew run lifecycle reuses the durable-agent run model ([Plan 11](./data-plane.md#plan-11) `run.*`); add a thin **`crew.*`** family for roster-level facts: `crew.AgentDispatched` (which operator, why — the triggering signal), `crew.ActionProposed` (action + blast radius + policy decision ref), `crew.ActionApplied`/`crew.ActionDenied` (ride `policy.Decided`), `crew.HandoffRequested` (one operator escalates to another or to a human). Domain remediation/promotion facts ride the existing `incident.*`/live-fix and `pipeline.*`/`deployment.*` families — **no per-agent event silos**.

### Verification
- A simulated SLO breach → **Endpoint Monitor** emits burn → **SRE** is dispatched (`crew.AgentDispatched`), diagnoses from projections, proposes a fix; a **prod** fix requires approval (`policy.Decided` → `crew.ActionApplied` only after approve), a **low-risk** fix auto-applies as a canary and auto-rolls-back on regression — all replayable.
- **GitOps** promotes staging→prod only when `can-deploy` is green; a skew blocks with a precise reason ([Plan 29](./contracts-policy-flags.md#plan-29)).
- Each agent's `CredentialAudit` ([Plan 5](./reliability-observability-cost.md#plan-05)) answers "what did this operator access, with which token, when?".
- The **SWE** operator opens a gated Delta/PR for a business-code repair (region-scoped AST edit + provenance, [ADR-0048](./adr/03-data-plane.md#adr-0048)); prod requires approval, the diff is reviewable + round-trippable.
- The **UX Designer** generates UI that violates **design.md** → the design-system gate blocks it ([ADR-0056](./adr/03-data-plane.md#adr-0056)); a conforming change lands via the same persisted-mutation + policy gate.
- A jailbreak/PII-laden prompt to any operator is blocked by the enforced guardrail layer → `guardrail.Blocked` + `policy.Decided`, replayable ([ADR-0061](./adr/02-identity-security.md#adr-0061)).
- Swapping the SRE engine to HolmesGPT (or disabling an operator) is a per-Yard config change; the deterministic core is unaffected.
- **FinOps** recommends a savings-plan purchase → `crew.ActionProposed` + gated Delta with a require-approval obligation; it is never auto-purchased; the decision is replayable via `policy.Decided`.

### Scope
- The roster as built-in Yard services on the shared model (identity/policy/events/MCP/engine-behind-port, sandboxed under enforced AI governance); read/diagnose autonomous, writes gated. **SRE · Endpoint Monitor · GitOps · Platform Engineer · SWE · UX Designer · FinOps**, plus built-in engines + the HolmesGPT (SRE) reference adapter.
- Each operator is a **principal under org RBAC** ([ADR-0074](./adr/02-identity-security.md#adr-0074)): its actions on HoBo's own control-plane surface are role-gated and bounded by the org's mandatory policy rules — an operator can never exceed its assigned role (e.g. a GitOps operator without the Deployer role can *propose* but not *promote*).
- Multi-agent planning/negotiation rides `crew.HandoffRequested`; agent-authored *new* operators and third-party operators ride `@hobo/agent-skills` ([Plan 10](./architecture.md#plan-10)).

### SRE: incident management, runbooks & self-healing

The SRE operator from the roster above is the one Crew member whose remediation loop deserves a full model. It binds the platform's response primitives — alerting/SLO ([ADR-0045](./adr/02-identity-security.md#adr-0045)), pipelines ([Plan 25](./platform-engineering.md#plan-25)), live-fix ([Plan 23](./generated-stack.md#plan-23)), drift + auto-rollback ([Plan 5](./reliability-observability-cost.md#plan-05)), chaos ([ADR-0047](./adr/02-identity-security.md#adr-0047)) — into a governed incident lifecycle: a first-class **Incident** aggregate behind `incident.*`, an enumerated runtime failure→fix playbook, a transparent decision tree, and declarative runbooks.

#### The Incident aggregate
An **Incident** is an [aggregate](./sdk-api.md#plan-02) (an actor; [ADR-0053](./adr/03-data-plane.md#adr-0053)) on stream `incident:<id>` — single-writer, **rebuildable from the log**. It is the **command point** that correlates the loose signals (`alert.Fired`, `slo.BudgetBurned`, `resource.DriftDetected`, `compat.GateFailed`, `spend.CircuitTripped`, `golden.Failed`/`golden.Drifted` — [ADR-0082](./adr/02-identity-security.md#adr-0082)) into one governed object: `{ id, severity, impact, status, timeline, causedBy (causation/correlation chain), owner }`. Lifecycle events ([Plan 11](./data-plane.md#plan-11)): `Opened → Triaged → RootCauseIdentified → RemediationProposed → RemediationApplied|Failed → Resolved → PostmortemFiled`, plus `SLABreached` on MTTD/MTTR overrun. Correlation uses the envelope's existing `correlationId`/`causationId` ([Plan 11](./data-plane.md#plan-11)) — multiple alerts fold into **one** incident, not N pages. These `incident.*` facts are what the **operations dashboard** renders (open incidents, MTTD/MTTR) and what a project's **status page** publishes as incident history + postmortem-as-replay ([Plan 49](./developer-experience.md#plan-49)) — internally in full, publicly as curated `statuspage.IncidentPosted` updates.

#### The SRE operator decision tree
The SRE operator runs a documented decision tree. On a signal it runs: **diagnose** (read projections; optional **HolmesGPT** engine behind a port, [docs/technologies/holmesgpt-sre-agent.md](../technologies/holmesgpt-sre-agent.md)) → **classify** (the taxonomy below) → **decide** one of three branches, each policy-gated + event-sourced:
```mermaid
flowchart TB
  SIG["signal: alert.Fired / slo.BudgetBurned / resource.DriftDetected / compat.GateFailed"] --> INC["Incident opened (aggregate, Plan 11)"]
  INC --> DIAG["SRE: diagnose from projections (optional HolmesGPT behind a port)"]
  DIAG --> CLASS{"classify: runtime + contract taxonomy"}
  CLASS -->|low-risk, reversible, in-budget, conformance-green| AUTO["auto-fix: live-fix canary + auto-rollback (Plan 23/5)"]
  CLASS -->|needs human review| PROP["propose: open a gated Delta / PR (Plan 26/30)"]
  CLASS -->|high-impact or unknown| ESC["escalate: page on-call + obligation deadline"]
  AUTO --> GATE["policy gate (Plan 30): allow / canary / require-approval"]
  PROP --> GATE
  GATE --> RES["incident.Resolved"]
  ESC --> RES
  RES --> PM["postmortem-as-replay: regression test + runbook/prompt update"]
```
- **auto-fix** when the fix is **low-risk, reversible, within blast-radius + spend budget, and conformance-green** -> applied as a live-fix canary with auto-rollback; the safety rail also checks idempotency, cooldowns, and "do not re-act on your own effect" before any second write in the same scope ([Plan 23](./generated-stack.md#plan-23)/[Plan 5](./reliability-observability-cost.md#plan-05)/[ADR-0094](./adr/02-identity-security.md#adr-0094)).
- **propose** when ambiguous or prod → open a gated **Delta/PR** ([Plan 25](./platform-engineering.md#plan-25)/[Plan 29](./contracts-policy-flags.md#plan-29)); a human approves.
- **escalate** when high-impact or unclassifiable → page **on-call** (below). Each decision is `crew.ActionProposed`/`crew.ActionApplied` + `policy.Decided` + the `incident.*` fact — fully replayable ("why did SRE auto-fix at 02:14?").

**A2H — agent-to-human handoff ([ADR-0082](./adr/02-identity-security.md#adr-0082)).** The escalate branch is the **A2H** lane, formalized: a typed handoff package (the failing check / golden diff, proposed fixes, blast radius, the decision required) routed over the **`hobo:notify` transport** ([ADR-0059](./adr/03-data-plane.md#adr-0059)) + on-call as a **policy obligation with a deadline** ([Plan 29](./contracts-policy-flags.md#plan-29)); it rides `crew.HandoffRequested` (no new event family), and the human's decision — **apply fix / re-bless a golden sample / abort** — is event-sourced and audited. A signal whose source suite/case is marked **`requiresHuman`** (e.g. a security or money-touching golden), whose blast radius is uncomputable, or whose follow-on signal may have been caused by the operator's own prior remediation **skips auto-fix/propose and enters A2H directly** ([ADR-0094](./adr/02-identity-security.md#adr-0094)); missing the deadline re-escalates. Agent-to-agent delegation (one operator handing to another) is the same `crew.HandoffRequested` over the principal model + MCP — no separate protocol.

#### Runtime failure-taxonomy → safe-fix map
One table unifies the scattered taxonomies (Plan 5 runtime classes + Plan 23/29 contract classes). **Live-fix is the *applier*; this is the *classifier*.**
| Failure class | Signal | Canonical safe-fix strategy |
|---|---|---|
| **Transient** (429/503, blip) | error-rate spike, retries | retry w/ backoff; circuit-break the dep ([Plan 5](./reliability-observability-cost.md#plan-05)) |
| **Provider-degraded / region** | provider error-rate, latency | fail over Camp/region; widen canary hold ([ADR-0035](./adr/07-portability-extensibility.md#adr-0035)) |
| **Capacity-exhausted** | saturation, queue depth | scale (Workload Profile); shed load; backpressure |
| **Durable-but-recoverable** (node crash) | run interrupted | replay-resume the saga ([Plan 11](./data-plane.md#plan-11)/[Plan 5](./reliability-observability-cost.md#plan-05)) |
| **Partial failure** (mid-saga) | step failed | compensate in reverse-dep order ([Plan 5](./reliability-observability-cost.md#plan-05)) |
| **Poison message** | repeated consumer failure | dead-letter + quarantine; loosen/repair handler |
| **Drift** (out-of-band change) | `resource.DriftDetected` | resync to desired Set; or propose ([Plan 5](./reliability-observability-cost.md#plan-05)) |
| **Split-brain / state divergence** | lease/fencing conflict | fence + reconcile from owner ([ADR-0040](./adr/01-architecture-core.md#adr-0040)) |
| **Contract skew** (producer broke consumer) | `compat.GateFailed` | dual-publish window / deploy-order / shim ([Plan 29](./contracts-policy-flags.md#plan-29)) |
| **Semantic drift** (trained method) | eval regression | revert to champion; keep candidate in shadow ([Plan 23](./generated-stack.md#plan-23)) |
| **Security anomaly** | live-scan finding ([Plan 12](./security-networking.md#plan-12)) | rotate credential; tighten `.allow()`; bump dep |
| **Runaway spend** | `spend.CircuitTripped` | halt spend-incurring actions; require approval ([ADR-0039](./adr/02-identity-security.md#adr-0039)) |
| **Cost-induced degradation** | `spend.DegradationRequired` | shed QoS by priority through `costAvailabilityProfile` tiers; SRE proposes cost-efficient remediation, gated ([ADR-0039](./adr/02-identity-security.md#adr-0039)) |
| **Cost anomaly** (spend deviates from baseline) | `cost.AnomalyDetected` | SRE *proposes* rightsizing/commitment remediation as a gated obligation ([ADR-0115](./adr/02-identity-security.md#adr-0115)); enforcement stays with breakers/tiers ([ADR-0039](./adr/02-identity-security.md#adr-0039)) |
Each strategy is reversible + gated; an unclassifiable failure → escalate (never silent action). Cost-induced degradation is a first-class incident class: the SRE operator handles it by *proposing* cost-efficient remediation (e.g. *"hold 99% to stay under budget while the leak is fixed"*) as a gated obligation, and **postmortem-by-replay shows exactly which load was shed and when** ([ADR-0039](./adr/02-identity-security.md#adr-0039)).

#### Declarative runbooks
The missing first-class concept. A **runbook** codifies response: **trigger** (alert / SLO-burn / drift / incident-severity) → **diagnosis steps** (MCP queries the SRE runs) → **gated fix actions** (each blast-radius-bounded). Runbooks are **event-sourced** (`runbook.*`), **versioned + signed** like Resource Packs ([Plan 25](./platform-engineering.md#plan-25)), and **built on the Pipelines engine** ([Plan 25](./platform-engineering.md#plan-25)) — the incident-response sibling of deploy pipelines (same triggers/rules/gated-steps model, different triggers + actions). HolmesGPT runbooks / StackStorm are **optional engines behind the port** ([docs/technologies/stackstorm.md](../technologies/stackstorm.md)).
```ts
defineRunbook("high-5xx-on-api", {
  on: { alert: "api.5xx-burst", severity: ">=SEV2" },
  diagnose: ["tail_logs api", "get_drift api", "slo_status api.availability"],   // MCP reads
  fix: [
    { when: "provider-degraded", do: "failover", camp: "prod-azure", gate: "auto" },
    { when: "capacity-exhausted", do: "scale", to: { min: 6 }, gate: "auto" },
    { when: "unknown",            do: "escalate", to: "on-call" },
  ],
});
```
The SRE operator *executes* runbooks; a runbook with no matching `fix` escalates. `hobo runbook exec --incident <id>`.

#### MTTD / MTTR as SLOs
SRE performance is measured as code ([Plan 5](./reliability-observability-cost.md#plan-05)/[ADR-0045](./adr/02-identity-security.md#adr-0045)): `sre.mttd` (signal → `crew.AgentDispatched`) and `sre.mttr` (`incident.Opened` → `incident.Resolved`) are **OpenSLO SLOs with error budgets**. Burn is a **policy input**: MTTR-SLO burn can **freeze risky deploys** or **require a deeper postmortem** (a `can-deploy` dimension), exactly like availability-SLO burn. `incident.SLABreached` fires on overrun.

#### On-call & escalation (lean)
Escalation is modeled as a **policy obligation with a deadline**. `incident.Opened` (SEV≥threshold) creates an obligation: *notify on-call, require ack within N minutes*; **unsatisfied-by-deadline → escalate** up the ladder ([Plan 29](./contracts-policy-flags.md#plan-29) obligations + [ADR-0045](./adr/02-identity-security.md#adr-0045) routing). The **on-call** is a receiver/principal; PagerDuty/OpsGenie/Slack are receiver providers behind the alerting port. The obligation-deadline mechanism carries escalation; rotation-calendar machinery rides the same receiver/obligation model when added.

#### Postmortem-as-replay
The incident's event stream **is** the timeline, so a **blameless postmortem** is generated from the replay (what fired, what SRE decided, which gate, MTTD/MTTR, what fixed it). A failed remediation or a chaos finding becomes a **permanent regression test** (the [ADR-0047](./adr/02-identity-security.md#adr-0047)/[Plan 23](./generated-stack.md#plan-23) pattern); the postmortem's findings feed **candidate runbook / SRE-prompt updates**, promoted through the same gated, eval'd path as any generated artifact ([Plan 23](./generated-stack.md#plan-23)).

#### SRE events & ports
- **New:** `incident.*` + `runbook.*` ([Plan 11](./data-plane.md#plan-11), defined there). **Reused:** `crew.*` (above), `policy.Decided` ([Plan 29](./contracts-policy-flags.md#plan-29)), `alert.*`/`slo.*` ([ADR-0045](./adr/02-identity-security.md#adr-0045)), live-fix + `resource.DriftDetected` ([Plan 23](./generated-stack.md#plan-23)/[Plan 5](./reliability-observability-cost.md#plan-05)), `chaos.*` ([ADR-0047](./adr/02-identity-security.md#adr-0047)).
- **Ports/engines behind ports:** the SRE reasoning engine (built-in default; **HolmesGPT** optional), the runbook engine (built-in Pipelines; **StackStorm** optional), alert receivers (PagerDuty/OpsGenie/Slack). No new SDK surface for app developers.

#### SRE verification
- A simulated provider-degradation: alert → **one** `incident.Opened` (multiple alerts correlate), SRE classifies *provider-degraded* → auto-fix failover (low-risk) applied as a canary, `incident.Resolved`, postmortem generated by replay — all event-sourced.
- A prod contract skew (`compat.GateFailed`): SRE *proposes* (not auto), opens a gated Delta with the shim fix; approval required.
- An unclassifiable SEV1: SRE *escalates*; on-call obligation unsatisfied by deadline → escalates up; `incident.SLABreached` if MTTR SLO burns.
- A runbook with no matching `fix` escalates; `hobo runbook exec` is replayable.

#### Epic reference implementation

The Operators/SRE epic rollup is now represented by the common reference implementation at [`../../src/draft/epic-proofs/operators-sre-crew/README.md`](../../src/draft/epic-proofs/operators-sre-crew/README.md). It synthesizes the Crew POCs into four executable vertical slices: provider-degradation remediation, production contract-skew approval, runaway remediation fail-closed escalation, and DR failover integrity. Boundary providers remain mocked; the contract inventory records Pact fixtures for SLO signals, projections, policy, remediation, A2H notify, issue tracker, knowledge, replicated event log, and chaos fault injection.

#### SRE scope
- The Incident aggregate + `incident.*`/`runbook.*`; the SRE decision tree; the failure-taxonomy→fix map; declarative runbooks on the Pipelines engine; MTTD/MTTR SLOs; obligation-deadline escalation; postmortem-as-replay.
- On-call rotation calendars + paging-vendor specifics, a richer runbook authoring DSL ([Hobo Code](./authoring-resources-wiring.md#plan-21)), and HolmesGPT/StackStorm adapters all ride the existing obligation/runbook/engine-behind-port seams.
