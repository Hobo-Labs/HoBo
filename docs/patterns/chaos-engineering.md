---
type: Pattern
title: "Chaos Engineering & Chaos Testing"
description: "Chaos engineering is the discipline of **experimenting on a system by injecting controlled failure** in order to build confidence in its ability to withstand turbulent conditions i"
tags: [hobo, patterns]
---

# Chaos Engineering & Chaos Testing

> **Pattern** · deliberately injecting failure to validate resilience. Sources: [Principles of Chaos Engineering](https://principlesofchaos.org/) · [Chaos Mesh](https://chaos-mesh.org/) · [LitmusChaos (CNCF)](https://litmuschaos.io/) · [Gremlin](https://www.gremlin.com/) · [AWS Fault Injection Service](https://aws.amazon.com/fis/). Excerpts quoted for analysis (fair use).

## What it is
Chaos engineering is the discipline of **experimenting on a system by injecting controlled failure** in order to build confidence in its ability to withstand turbulent conditions in production. The premise: distributed systems fail in ways no test suite anticipates, so rather than wait for an outage to teach you, you *proactively* and *safely* introduce the failure, observe the system's response, and fix the weaknesses you find before they cause an incident. "Chaos testing" is the narrower, often CI-driven practice of running such experiments as repeatable tests.

## Key elements / features
**Core principles** (per [principlesofchaos.org](https://principlesofchaos.org/)):
- **Steady-state hypothesis.** Define a measurable normal (the "steady state" — e.g. throughput, error rate, p99 latency) and form a falsifiable hypothesis: *"if we kill N instances of service X, p99 latency of API Y stays under Z ms."* The experiment tries to disprove it.
- **Vary real-world events.** Inject the failures that actually happen: instance/pod kills, CPU/memory/disk pressure, network latency/loss/partition, clock skew, dependency outages, region failures, expired certs.
- **Run in production (or production-like).** The realest signal comes from prod; where that is too risky, run against the highest-fidelity environment available.
- **Automate & run continuously.** One-off experiments decay; the value is in continuous, automated runs that catch regressions as the system evolves.
- **Minimize blast radius.** Start small and contain impact — limit the scope (one pod, one AZ, a traffic %), have an abort/rollback ("big red button"), and expand only as confidence grows.

**Practices:**
- **Fault-injection types** — compute (kill/stop/restart, resource exhaustion), network (latency, packet loss, partition, DNS failure), state (disk fill, I/O errors), dependency (provider/API failure, throttling/429), time (clock skew), application (exception injection, bad response).
- **Game days** — scheduled, hypothesis-driven exercises where a team injects failures against a real environment and observes detection, response, and recovery (people *and* systems are under test).
- **Observability as prerequisite.** You cannot run an experiment you can't measure; chaos requires solid metrics/traces to define steady state and detect deviation.

**Tools landscape (brief):**
- **Chaos Mesh** (CNCF) — Kubernetes-native; every experiment is a **CRD applied with `kubectl`**, making it a natural fit for GitOps workflows.
- **LitmusChaos** (CNCF) — broad experiment library (50+ experiments incl. cloud-provider chaos for AWS/GCP/Azure/VMware); ChaosHub of reusable experiments.
- **Gremlin** — commercial; agent-based, spans servers (cloud/bare-metal), containers, and Kubernetes, with UI/API/CLI control and built-in blast-radius/halt controls.
- **AWS Fault Injection Service (FIS)** — managed AWS-only fault injection across EC2/RDS/EKS and other services; no multi/hybrid-cloud support.

## Relevance to HoBo
Chaos engineering maps cleanly onto two HoBo planes — **reliability/HA** and **verification** — and HoBo's architecture makes it unusually cheap to adopt.

**It validates the failure taxonomy HoBo designs against.** [Plan 5](../design/reliability-observability-cost.md#plan-05) enumerates the exact failure classes chaos exists to probe: **transient** (provider 429/503), **durable-but-recoverable** (Yard node crash mid-deploy → event-log replay resumes), **partial failure** (saga compensation in reverse-dependency order), **drift** (out-of-band infra change → resync/self-heal), and **split-brain** (leases + fencing tokens). Each row is a steady-state hypothesis waiting to be tested. The HA mechanisms — circuit breakers per `(provider, region, operation)`, retry budgets, bulkheads, canary with **auto-rollback** — are precisely the resilience controls chaos experiments are meant to exercise.

**HoBo should make chaos a first-class verification category.** [Plan 9](../design/generated-stack.md#plan-09) already lists fault-injection-style tests as control-plane/HA verification: *kill the Yard mid-deploy → resumes from the log; inject a provisioning failure past the no-go threshold → saga compensation rolls back; partition an actor owner → fencing rejects its stale writes; canary regression → auto-rollback.* These are chaos experiments in all but name. The analysis: HoBo should **promote chaos/fault-injection to an explicit test tier** in the pyramid ([Plan 9](../design/generated-stack.md#plan-09)), run by `hobo verify`, with a `local` (simulated faults on `runtime-local`) vs `camp` (real provider faults) split mirroring the existing conformance tagging ([ADR-0042](../design/adr/07-portability-extensibility.md#adr-0042)).

**Determinism + replay make failure reproduction trivial — HoBo's unfair advantage.** Because everything is event-sourced ([Plan 11](../design/data-plane.md#plan-11)) and runs replay deterministically, a chaos experiment that surfaces a bug yields a **recorded trace that reproduces it exactly** — the failing trace becomes a permanent regression test (the same mechanic HoBo uses for AI live-fix, [Plan 23](../design/generated-stack.md#plan-23)/[Plan 5](../design/reliability-observability-cost.md#plan-05)). Most chaos tooling struggles with reproducibility; HoBo gets it for free.

**Blast-radius control is already in the model.** Incremental deploys reconcile only changed nodes ([Plan 25](../design/platform-engineering.md#plan-25)); canary/progressive rollout limits exposure ([Plan 5](../design/reliability-observability-cost.md#plan-05)); per-tenant/provider bulkheads cap concurrency. A chaos experiment can be scoped to an ephemeral preview Camp ([Plan 25](../design/platform-engineering.md#plan-25)) for a near-zero-blast-radius game day.

**Provider seam for external tools.** Consistent with HoBo's "engines behind a port" stance, an external chaos engine (Chaos Mesh CRDs via the GitOps publisher, or a `fault-injection` capability adapter) could drive experiments against a Camp while HoBo records each injected fault and observed response as events — keeping chaos within the same auditable, gated, policy-controlled envelope ([Plan 29](../design/contracts-policy-flags.md#plan-29)) as every other action (an injection in prod is itself a policy decision).

## Sources
- [Principles of Chaos Engineering](https://principlesofchaos.org/)
- [Chaos Mesh (CNCF) docs](https://chaos-mesh.org/)
- [LitmusChaos (CNCF)](https://litmuschaos.io/)
- [Gremlin — chaos engineering platform](https://www.gremlin.com/)
- [AWS Fault Injection Service](https://aws.amazon.com/fis/)
- [Getting started with chaos engineering — Google Cloud Blog](https://cloud.google.com/blog/products/devops-sre/getting-started-with-chaos-engineering)
- HoBo internal cross-refs: [Plan 5](../design/reliability-observability-cost.md#plan-05) · [Plan 9](../design/generated-stack.md#plan-09) · [Plan 11](../design/data-plane.md#plan-11)
