---
type: Reference
title: "Performance & Load Tests"
description: "Source issues: HOBO-440, HOBO-502."
tags: [hobo, design]
---

# Performance & Load Tests

Source issues: HOBO-440, HOBO-502.

Executable proofs live in
[`src/draft/exp-proofs/dx/performance-load-tests-scope-contract`](../../src/draft/exp-proofs/dx/performance-load-tests-scope-contract/README.md)
and
[`src/draft/exp-proofs/dx/launch-performance-capacity-envelope-contract`](../../src/draft/exp-proofs/dx/launch-performance-capacity-envelope-contract/README.md).
Branch evidence is summarized in
[`proofs/hobo-440-performance-load-tests`](./proofs/hobo-440-performance-load-tests/README.md)
and
[`proofs/hobo-502-launch-performance-capacity-envelope`](./proofs/hobo-502-launch-performance-capacity-envelope/README.md).

## M0 Scope And Acceptance Record

Performance & Load Tests exists to define which launch-readiness workload scenarios, capacity
envelopes, thresholds, abort rules, evidence records, and owner handoffs are required before HoBo
can claim beta, release-candidate, or GA performance confidence. It is not the load runner, a live
provider stress lane, a benchmark lab, an autoscaling implementation, or a release decision.

HoBo needs accepted M0 scope for Performance & Load Tests before downstream load automation,
capacity evidence, SLO tuning, provider exercises, support artifacts, or release-cutline work can
depend on it. The accepted record must say who the tests serve, which evidence dimensions every
scenario carries, how gaps route, which adjacent projects own implementation, and which M1 proof
assets must exist before M2+ automation work fans out.

## Launch Envelope Record

Performance & Load Tests also needs an accepted launch envelope before beta, release-candidate, or
GA work can claim performance readiness. The launch envelope defines target workflows, expected
beta load, latency and cost thresholds, capacity assumptions, deterministic fixture shape,
non-goals, and handoffs to support and release notes when a threshold is missed. It does not run
production load tests or tune capacity.

## Primary Personas

| Persona | Need |
|---|---|
| Release owner | Know which performance evidence gates beta, release-candidate, and GA readiness and which gaps block launch claims. |
| Platform engineer | Understand workload models, fixture boundaries, and capacity envelopes before building load-test automation. |
| SRE operator | Map latency, saturation, SLO burn, abort, and rollback evidence into operational launch decisions. |
| FinOps reviewer | See expected-load and capacity assumptions without turning this M0 issue into cost-routing or billing work. |
| Support operator | Receive retained evidence, limitation notes, and owner handoffs for performance incidents and customer questions. |

## Scope In

- Define the M0 Performance & Load Tests product scope, accepted personas, and launch-readiness
  goal.
- Define mandatory scenario dimensions: journey, workload model, expected load, environment,
  fixture data, mocked/live boundary, measured signal, capacity envelope, pass threshold, fail
  threshold, abort rule, owner, and release phase.
- Define service, UX, security, and support boundaries for performance evidence without building
  the load-test execution system.
- Define M1-ready evidence for scenario inventory, workload model fixture, capacity envelope
  schema, threshold and abort policy, and evidence retention/support handoff.
- Define follow-up gate rules so M1/M2/M3/M4 performance automation, CI lanes, provider exercises,
  SLO tuning, and support artifacts wait for accepted M0 scope.

## Scope Out And Non-Goals

- Do not build a load runner, benchmark lab, browser performance lab, or CI execution lane.
- Do not execute production load tests, use live customer traffic, or claim production capacity.
- Do not run live provider stress tests, production load, real cloud mutations, or autoscaling
  implementation work.
- Do not build chaos experiment orchestration, resilience drill execution, or the full Golden Suite.
- Do not make beta, release-candidate, or GA go/no-go decisions.
- Do not implement provider pricing, usage billing, invoices, payment collection, tax, refunds,
  Dispatcher/CreditLedger routing, rate limits, or entitlement enforcement.
- Do not create downstream M1-M4 execution issues before the M0 scope and envelope are accepted.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Performance & Load Tests defines accepted scenarios, workload models, thresholds, evidence fields, and owners; service teams own the later runner, CI lane, provider fixtures, and persistence. |
| UX | UX scope is limited to evidence fields needed by launch status, plan review, and diagnostics; product screens, dashboards, and visual performance reports are outside M0. |
| Security | Performance evidence must preserve tenant isolation, redaction, safe synthetic data, and no-secret load logs; scanners, policy gates, and vulnerability handling stay in Security Verification. |
| Support | Support receives retained run evidence, limitation notes, abort reasons, and owner handoffs; ticket routing, SLA promises, and incident communication execution remain separate. |

## Required Scenario Dimensions

| Dimension | Meaning |
|---|---|
| Journey | The named beta, release-candidate, or GA path whose performance confidence depends on the scenario. |
| Workload model | The deterministic shape of concurrency, rate, duration, data size, and operation mix. |
| Expected load | The accepted load level for this phase; not a customer-visible capacity promise by itself. |
| Environment | The local, staged, release-candidate, SaaS, self-host, or fixture-backed context for evidence. |
| Fixture data | Synthetic inputs used by the scenario, with tenant and secret-safety boundaries. |
| Mocked/live boundary | The explicit split between simulated, fixture-backed, and live dependencies. |
| Measured signal | Latency, saturation, throughput, error rate, SLO burn, resource pressure, or cost signal. |
| Capacity envelope | The accepted upper and lower assumptions for load, duration, resources, and abort conditions. |
| Pass threshold | The evidence required for the scenario to count as accepted performance evidence. |
| Fail threshold | The condition that blocks launch confidence or routes to follow-up. |
| Abort rule | The condition that stops the test to protect shared systems, cost, or evidence quality. |
| Owner | The project or role responsible for evidence quality and gap routing. |
| Release phase | Whether the row matters for beta, release-candidate, GA, or post-GA. |

## Target Workflows

| Workflow | Persona | Launch tier | Evidence owner |
|---|---|---|---|
| First `hobo plan` / plan-diff | App developer | Beta required | Plan/Diff Viewer |
| First deploy smoke path | App developer | Beta required | Bootstrap Installer |
| Release readiness dashboard refresh | Release owner | RC required | V1 Release Program & Cutline |
| Support evidence lookup | Support operator | Beta required | Support Workflow |

## Expected Beta Load

| Load assumption | Source |
|---|---|
| Up to 25 private-beta workspaces, 5 concurrent active onboarding flows, and 2 concurrent first-deploy flows. | V1 Beta Pilot & Feedback Loop |
| Every release-candidate run may execute deterministic smoke fixtures for SaaS, self-host, local, and cost-envelope replay paths. | Bootstrap Installer |
| Support evidence lookup is optimized for launch triage, not bulk analytics or billing exports. | Support Workflow |

## Thresholds

| Threshold | Beta target | GA target | Miss handling |
|---|---|---|---|
| First plan p95 latency | <= 15s using deterministic fixture inputs | <= 8s using accepted launch fixture inputs | Route to Plan/Diff Viewer with fixture id and trace evidence; list as beta limitation if still above target. |
| First deploy smoke p95 elapsed time | <= 15m for synthetic SaaS path | <= 8m for accepted SaaS path and documented self-host path | Route to Bootstrap Installer with bootstrap artifact and failing step; narrow install claims to the passing path. |
| Readiness dashboard refresh p95 | <= 30s against fixture project set | <= 10s against accepted launch project set | Route to Release Program & Cutline with source-of-truth field id; avoid describing the dashboard as live if unmet. |
| Support evidence lookup p95 | <= 20s for known issue/workspace refs | <= 10s for known issue/workspace refs | Route to Support Workflow with tenant/workspace redaction state; exclude fast lookup from support SLA text if unmet. |
| Cost per launch smoke run | <= 5 USD equivalent per synthetic run | <= 2 USD equivalent per synthetic run or accepted exception | Route to Usage Metering and Entitlements before adding smoke volume; disclose high-cost smoke limitations. |

## Capacity Assumptions

| Assumption | Boundary |
|---|---|
| Launch envelope assumes hosted control-plane defaults from [Plan 05](./reliability-observability-cost.md#plan-05), not tuned production capacity. | Capacity changes require a later M1/M2 load-test issue. |
| Self-host path names minimum fixture resources but does not prove customer production sizing. | Customer production sizing remains release-note and support guidance until drill evidence exists. |
| Envelope fixtures use synthetic or replayable data only. | No live tenant traffic or customer data is used for launch-envelope proof. |

## Fixture Shape

| Fixture | Data set | Measurement mode | Production execution |
|---|---|---|---|
| Local smoke | Local deterministic sample workspace with one project, one plan, one deploy record, and no provider calls. | Node contract fixture | No |
| SaaS beta synthetic | Synthetic hosted workspace and first-deploy artifact ids. | Contract fixture with stubbed provider timings | No |
| Self-host synthetic | Synthetic self-host bootstrap path, minimum resource class, and unsupported-state rows. | Contract fixture with declared resource envelope | No |
| Cost envelope replay | Usage, billing, and entitlement fixture facts with deterministic cost counters. | Event replay fixture | No |

## Cost Guardrails

| Owner | Rule | Boundary |
|---|---|---|
| Usage Metering | Every cost threshold must trace to accepted usage fact classes and dimensions. | This record does not create a metering projection or ingest live usage. |
| Billing & Credits | Envelope cost misses route to invoice/support wording but do not generate invoices. | This record does not add payment, invoice, refund, tax, or provider billing integration. |
| Entitlements & Plan Limits | Capacity and cost limits that become customer-visible must map to entitlement policy before launch. | This record does not enforce quota, abuse response, rate limits, or suspension. |

## Authoritative Dependencies

- [reliability-observability-cost.md#plan-05](./reliability-observability-cost.md#plan-05)
  defines SLOs, error-budget gates, observability signals, capacity targets, and cost visibility
  consumed by performance evidence.
- [e2e-test-matrix.md](./e2e-test-matrix.md) defines launch journey rows and fixture boundaries
  that performance scenarios extend with expected-load evidence.
- [launch-e2e-persona-matrix.md](./launch-e2e-persona-matrix.md) defines persona journey
  thresholds that later performance rows must not silently weaken or override.
- [pre-launch-outcome-contract.md](./pre-launch-outcome-contract.md) defines outcome and safe-test
  evidence that performance/load claims compare against before launch.
- [Usage Metering](./usage-metering.md) owns usage fact classes, attribution dimensions, and
  reconciliation/support evidence.
- [Billing Launch Policy](./billing-launch-policy.md) owns invoice, payment, refund, credit, tax,
  and provider boundary language.
- [V1 Release Notes and Upgrade Guide](./release-notes-upgrade-guide.md) owns customer-facing
  release wording when thresholds are missed.
- [Launch Support Escalation](./launch-support-escalation.md) owns support routing and support SLA
  language.
- [ADR-0045](./adr/02-identity-security.md#adr-0045) pins SLO-as-code and error-budget gating as
  the reliability contract behind performance thresholds.
- [ADR-0082](./adr/02-identity-security.md#adr-0082) pins Golden Suites and A2H handoff so load
  evidence can fail closed without becoming a launch bypass.

## Owning Initiative Dependencies

| Owner | Consumes from Performance & Load Tests | Boundary |
|---|---|---|
| Performance & Load Tests | Accepted scenario dimensions, launch envelope, capacity evidence checklist, threshold policy, and follow-up gate. | This page defines scope and acceptance; it does not build the performance runner. |
| E2E Test Matrix | Journey, persona, fixture, mocked/live boundary, owner, and release-phase rows. | E2E journey inventory remains the owner of end-to-end row coverage. |
| V1 Release Program & Cutline | Performance evidence state, known gaps, and accepted limitations in beta/RC/GA decisions. | Release go/no-go and accepted-risk workflows remain release-program scope. |
| Reliability, Observability & Cost | SLO, latency, saturation, burn-rate, capacity, and cost signal semantics. | Telemetry pipelines, SLO computation engines, budgets, and alerting stay in reliability/FinOps scope. |
| Support Workflow | Retained evidence, abort reasons, threshold miss handling, and owner handoffs for performance incidents and customer questions. | Support queues, SLA commitments, escalation, and customer communication execution stay in Support Workflow. |
| Security Verification | Safe synthetic data, tenant isolation, redaction, and secret-free evidence requirements. | Security scanners, policy engines, and vulnerability handling stay in Security Verification. |

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Scenario inventory | Performance & Load Tests | Design record | Every launch-relevant journey names expected load, measured signal, thresholds, owner, and release phase. |
| Workload model fixture | Platform engineering | Reference fixture | Synthetic workload inputs are deterministic, tenant-safe, and explicit about mocked/live boundaries. |
| Capacity envelope schema | SRE operator | Contract test | Capacity evidence has stable fields for load, duration, saturation, latency, error budget, and abort state. |
| Threshold and abort policy | Reliability, Observability & Cost | Contract test | Threshold breaches fail closed, preserve raw evidence, and route to owner review instead of silent pass. |
| Evidence retention and support handoff | Support Workflow | Support handoff | Support can explain load-test state, limitations, and next owner without owning the runner implementation. |
| Envelope fixture | Performance & Load Tests | Contract test | Workflows, load assumptions, thresholds, capacity assumptions, fixture shape, and non-goals are defined. |
| Threshold routing table | Support / Release | Design record | Missed thresholds route to support and release notes rather than disappearing. |
| Cost guardrail table | Usage Metering / Billing / Entitlements | Contract test | Cost limits align with owning initiatives before launch claims expand. |
| Scope guard | Release cutline | Contract test | Production load execution and hidden billing/entitlement work stay out of performance/load scope. |

## Gap Routing

| Gap | Owner |
|---|---|
| Journey, persona, expected-load row, fixture row, or matrix metadata missing | E2E Test Matrix |
| SLO, burn-rate, latency, saturation, capacity, threshold, or observability signal missing | Reliability, Observability & Cost |
| Evidence retention, support handoff, customer-safe limitation, or abort explanation missing | Support Workflow |
| Tenant isolation, redaction, synthetic data, no-secret log, or security review missing | Security Verification |
| Release-phase disposition, accepted-risk note, or cutline decision missing | V1 Release Program & Cutline |
| Unknown workload owner or uncategorized performance gap | Performance & Load Tests |

## Follow-Up Gate

M1/M2/M3/M4 performance automation, CI lanes, provider exercises, SLO tuning, capacity dashboard,
launch envelope expansion, support artifacts, and capacity or load-test execution issues must wait
until this M0 scope and envelope record is accepted. This page records the gate and executable
guards; it does not create follow-up implementation issues, run production load, or claim
production capacity.
