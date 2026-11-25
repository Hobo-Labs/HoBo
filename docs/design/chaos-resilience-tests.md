---
type: Reference
title: "Chaos & Resilience Tests"
description: "Source issue: HOBO-439."
tags: [hobo, design]
---

# Chaos & Resilience Tests

Source issue: HOBO-439.

Executable proof lives in
[`src/draft/exp-proofs/dx/chaos-resilience-tests-scope-acceptance`](../../src/draft/exp-proofs/dx/chaos-resilience-tests-scope-acceptance/README.md).
Branch evidence is summarized in
[`proofs/hobo-439-chaos-resilience-tests`](./proofs/hobo-439-chaos-resilience-tests/README.md).

## M0 Scope And Acceptance Record

Chaos & Resilience Tests exists to define which controlled-failure scenarios,
steady-state hypotheses, blast-radius limits, abort rules, evidence records,
and owner handoffs are required before HoBo can claim resilience confidence for
beta, release-candidate, or GA. It is not the chaos runner, a production fault
lane, an external chaos-engine adapter, a Golden Suite implementation, an SLO
engine, an SRE remediation engine, or a release decision.

Property/fuzz discipline (fast-check oracles, Jazzer harnesses, Schemathesis,
RESTler, Toxiproxy around **simulators**) lives in
[`fuzzing.md`](./fuzzing.md) and `@hobo/fuzz`. This record stays the chaos
scope/acceptance surface.

HoBo needs accepted M0 scope before downstream automation, CI lanes, provider
fault adapters, SRE runbooks, dashboards, support artifacts, or release-cutline
work can depend on chaos evidence. The accepted record must say who the tests
serve, which evidence dimensions every scenario carries, how gaps route, which
adjacent projects own implementation, and which M1 proof assets must exist
before M2+ automation work fans out.

## Primary Personas

| Persona | Need |
|---|---|
| SRE operator | Run or review bounded chaos evidence that proves recovery behavior without surprising production. |
| Release owner | Distinguish accepted resilience evidence from unrun experiments for beta, RC, and GA readiness. |
| Platform engineer | Understand fixture, runtime-local, Camp, and provider-boundary requirements before building automation. |
| Security lead | Confirm tenant isolation, credential safety, policy gates, and no-live-mutation boundaries. |
| Support operator | Receive retained evidence, limitation notes, and owner handoffs for resilience gaps. |

## Scope In

- Define the M0 Chaos & Resilience Tests product scope, accepted personas, and
  launch-readiness goal.
- Define mandatory scenario dimensions: hypothesis, target, injected fault,
  environment, mocked/live boundary, steady-state signal, blast-radius limit,
  abort rule, cleanup obligation, evidence owner, and release phase.
- Define service, UX, security, and support boundaries for resilience evidence
  without building the chaos execution system.
- Define M1-ready evidence for experiment inventory, steady-state hypothesis
  fixtures, fault-boundary policy, blast-radius/abort evidence, and
  support/release handoff.
- Define follow-up gate rules so M1/M2/M3/M4 chaos automation, fault adapters,
  Golden Suite composition, SRE remediation, dashboards, and support artifacts
  wait for accepted M0 scope.

## Scope Out And Non-Goals

- Do not build a live chaos runner, production fault-injection lane, provider
  mutation adapter, Kubernetes CRD adapter, or external chaos-engine
  integration.
- Do not implement the full Golden Suite, SLO computation engine, rollout
  adapter, SRE remediation engine, incident workflow, dashboard, or status-page
  UI.
- Do not run live provider stress tests, production faults, live customer
  traffic, destructive tests, credential mutation, tenant-data access, or policy
  bypasses.
- Do not implement support queues, customer communication workflows, release
  go/no-go decisions, or public resilience claims.
- Do not create downstream M1-M4 execution issues before the M0 scope record is
  accepted.

## Service, UX, Security, And Support Boundaries

| Boundary | Rule |
|---|---|
| Service | Chaos & Resilience Tests defines accepted scenarios, evidence fields, follow-up gates, and ownership vocabulary; runner and provider adapter implementation remain later work. |
| UX | UX scope is limited to evidence state consumed by release readiness and diagnostics; product screens and status-page publishing are outside M0. |
| Security | Fault-injection evidence must preserve tenant isolation, credential safety, no live customer traffic, policy gating, and destructive-test refusal. |
| Support | Support receives retained evidence, limitation notes, abort reasons, and owner handoffs; queues, SLA promises, and customer communication execution remain separate. |

## Authoritative Dependencies

- [Chaos Engineering & Chaos Testing](../patterns/chaos-engineering.md) defines
  the pattern vocabulary this project scopes for HoBo.
- [Plan 05](./reliability-observability-cost.md#plan-05) defines SLO, recovery,
  observability, cost, and failure-classification signals consumed by chaos
  evidence.
- [Plan 09](./generated-stack.md#plan-09) defines verification lanes, Golden
  Suites, replay, and local-vs-Camp evidence honesty.
- [Plan 40](./operators-sre.md#plan-40) defines SRE incident, runbook,
  remediation, and postmortem ownership.
- [ADR-0047](./adr/02-identity-security.md#adr-0047) pins the chaos and
  continuous-resilience verification tier.
- [ADR-0082](./adr/02-identity-security.md#adr-0082) pins Golden Suites,
  default-on verification gates, and A2H handoff behavior.

## Owning Initiative Dependencies

| Owner | Consumes from Chaos & Resilience Tests | Boundary |
|---|---|---|
| Chaos & Resilience Tests | Accepted scenario dimensions, evidence checklist, and follow-up gate. | This page defines scope and acceptance; it does not build the chaos runner. |
| Reliability, Observability & Cost | SLO, error-budget, recovery, cost, and observability signal semantics. | Telemetry pipelines, SLO computation, budgets, and alerting stay in reliability/FinOps scope. |
| E2E Test Matrix | Journey, persona, fixture, mocked/live boundary, owner, and release-phase rows. | E2E journey inventory remains the owner of end-to-end row coverage. |
| Security Verification | Policy, tenant isolation, credential safety, and destructive-test refusal criteria. | Security scanners, policy engines, and vulnerability handling stay in Security Verification. |
| V1 Release Program & Cutline | Resilience evidence state, known gaps, and accepted limitations in launch decisions. | Release go/no-go and accepted-risk workflows remain release-program scope. |
| V1 Launch Support Desk & Escalation | Retained evidence, abort reasons, limitation notes, and customer-safe handoff wording. | Support queues, SLA commitments, escalations, and customer communication execution stay in Support Workflow. |
| Operators/SRE | Incident, runbook, remediation, and postmortem-by-replay execution paths. | SRE automation and remediation engines stay in Operators/SRE follow-up work. |

## Evidence Required For M1

| Evidence | Owner | Proof mode | Proves |
|---|---|---|---|
| Scope record | Chaos & Resilience Tests | Design record | Goal, personas, scope, boundaries, and follow-up gate are accepted. |
| Experiment inventory | Chaos & Resilience Tests | Contract test | Each scenario names hypothesis, injected fault, target, environment, owner, and release phase. |
| Steady-state hypothesis fixture | Reliability, Observability & Cost | Contract test | SLO, metric source, baseline window, pass threshold, fail threshold, and observed evidence are stable fields. |
| Fault-boundary policy | Security Verification | Policy fixture | Live customer traffic, credential access, tenant leakage, destructive faults, and policy bypass are rejected. |
| Blast-radius and abort evidence | Operators/SRE | Contract test | Blast-radius limit, armed abort condition, cleanup obligation, and fail-closed state are explicit. |
| Support and release handoff | V1 Launch Support Desk & Escalation | Support handoff | Gaps route to owner, retained evidence, customer-safe wording, and release limitation state. |

## Follow-Up Gate

M1/M2/M3/M4 chaos automation, fault adapters, Golden Suite composition, SRE
remediation, dashboards, support artifacts, and production resilience claims
must wait until this M0 scope record is accepted. This page records the gate
and executable guards; it does not run production chaos or claim production
resilience.
