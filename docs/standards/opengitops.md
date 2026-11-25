---
type: Reference Standard
title: "OpenGitOps (CNCF)"
description: "OpenGitOps is a CNCF project that defines a **vendor-neutral, principles-first definition of GitOps** — \"a set of principles for operating and managing software systems.\" Rather th"
tags: [hobo, standards]
---

# OpenGitOps (CNCF)

> **Standard** · GitOps principles · Source: [opengitops.dev](https://opengitops.dev/) · [open-gitops/documents `PRINCIPLES.md`](https://github.com/open-gitops/documents/blob/main/PRINCIPLES.md) · [GitOps WG](https://github.com/open-gitops/project). Excerpts quoted for analysis (fair use).

## What it is
OpenGitOps is a CNCF project that defines a **vendor-neutral, principles-first definition of GitOps** — "a set of principles for operating and managing software systems." Rather than specifying a tool, file format, or wire protocol, it states the **four properties a system must have to *be* GitOps**, so that any implementation (Argo CD, Flux, or a bespoke controller) can be measured against the same bar.

It is stewarded by the **GitOps Working Group**, which operates under the CNCF's **App Delivery Technical Advisory Group (TAG App Delivery)**. The principles document is published at **v1.0.0**. GitOps generalizes "configuration as code" / "infrastructure as code": the desired state of the whole system lives in a versioned source of truth, and software agents make reality converge on it — continuously, automatically, and without humans pushing changes by hand.

## Key features
The **four GitOps Principles** (v1.0.0), quoted verbatim:

1. **Declarative** — "A system managed by GitOps must have its desired state expressed declaratively." You describe *what* you want, not the imperative steps to get there.
2. **Versioned and Immutable** — "Desired state is stored in a way that enforces immutability, versioning and retains a complete version history." Git is the canonical (but not mandated) store; the point is an immutable, auditable history you can roll back to.
3. **Pulled Automatically** — "Software agents automatically pull the desired state declarations from the source." The cluster/target *pulls*; nothing pushes credentials or changes inward.
4. **Continuously Reconciled** — "Software agents continuously observe actual system state and attempt to apply the desired state." Drift (manual edits, failures, partial applies) is detected and corrected on a loop.

Other facts:
- **Not a tool and not Kubernetes-specific.** The principles are substrate-agnostic; they happen to be most associated with Kubernetes because that's where the dominant agents run.
- **Reference implementations** — the canonical "software agents" are **Argo CD** and **Flux** (both CNCF Graduated). They watch a Git repo (or OCI/Helm source), diff desired vs. live state, and reconcile. OpenGitOps defines the *contract* they satisfy; it does not replace them.
- **Glossary + principles** are the two normative documents; the WG also publishes conformance discussion and educational material.
- **Push vs. pull** — a CI job running `kubectl apply` is *not* GitOps under principle 3 (it pushes); a pull-based agent that reconciles continuously *is*.

## Relevance to HoBo
HoBo's delivery surface is **GitOps-by-emission**: the **GitOps publisher + Pipelines** ([Plan 25](../design/platform-engineering.md#plan-25)) writes the **resolved Deployment Set** as manifests to Git so an existing agent (Argo CD / Flux) reconciles them into the target. HoBo therefore wants to *speak* OpenGitOps at this boundary rather than reinvent reconciliation. Mapping the four principles onto HoBo's own model:

- **Declarative → Bindle + Infrastructure-from-Code (IfC).** The Bindle is a provider-agnostic declarative description; the Planner resolves it (context-matching, [Plan 25](../design/platform-engineering.md#plan-25)) into a concrete **Deployment Set**. HoBo's declarative input is *higher* than raw manifests — it declares intent, and the resolved Set is what gets versioned to Git.
- **Versioned and Immutable → event-sourced Sets.** A **Deployment Set is immutable and content-addressed**; mutation happens only via reviewable **Deltas** that apply to produce a *new* Set ([Plan 25](../design/platform-engineering.md#plan-25)). The version history isn't only Git commits — it's the **append-only event log** ([Plan 11](../design/data-plane.md#plan-11)), which is a strictly richer immutability/versioning substrate than a branch.
- **Pulled Automatically → the HoBo Relay / Argo / Flux.** For private and air-gapped targets the **HoBo Relay** dials out (outbound-only 443) and pulls work into the network ([Plan 25](../design/platform-engineering.md#plan-25)); for cluster delivery, Argo/Flux pull the emitted manifests. Either way the target initiates — never an inbound push — which also aligns with HoBo's sovereign/air-gap posture ([ADR-0036](../design/adr/07-portability-extensibility.md#adr-0036)).
- **Continuously Reconciled → the drift loop.** HoBo runs its own drift detection/refresh (`IacProvider.refresh` → `DriftReport`, [Plan 4](../design/control-plane.md#plan-04)) and reconciliation as part of reliability ([Plan 5](../design/reliability-observability-cost.md#plan-05)); when delegating to Argo/Flux it inherits their reconcile loop.

**Where HoBo diverges / extends.** Plain GitOps reconciles toward "whatever the latest commit says," and the audit story is the Git history. HoBo's **event-sourcing makes reconciliation replayable**: the path from intent → match decision (`match.Decided`) → planned Set → applied Set is itself a deterministic, replayable sequence, so "why is the live state this way?" is answerable beyond a `git blame`. HoBo can also act as the **declarative authoring layer above** Argo/Flux — the operator edits TypeScript/Bindle, HoBo emits manifests, the standard agent reconciles. This keeps HoBo *interoperable with* the dominant GitOps ecosystem (a stated bet: speak existing standards at the boundary) instead of competing with Argo/Flux for the reconciler role.

Open question worth tracking against the spec: whether HoBo should publish a **conformance claim** ("HoBo-emitted delivery satisfies the 4 principles") and whether the Git-commit-vs-event-log dual history needs reconciling in docs so the "single source of truth" story stays unambiguous.

## Sources
- OpenGitOps home — https://opengitops.dev/
- GitOps Principles v1.0.0 (`open-gitops/documents`) — https://github.com/open-gitops/documents/blob/main/PRINCIPLES.md
- OpenGitOps / GitOps Working Group (CNCF, TAG App Delivery) — https://github.com/open-gitops/project
- "4 Core Principles of GitOps" (The New Stack) — https://thenewstack.io/4-core-principles-of-gitops/
- Argo CD — https://argo-cd.readthedocs.io/ · Flux — https://fluxcd.io/
