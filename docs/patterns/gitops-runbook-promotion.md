---
type: Pattern
title: "GitOps + Runbook Automation + Artifact Promotion"
description: "This is the composite delivery pattern most mature platforms converge on, with three interlocking parts:"
tags: [hobo, patterns]
---

# GitOps + Runbook Automation + Artifact Promotion

> **Pattern** · declarative Git-driven delivery, event-driven runbooks, and environment promotion of immutable artifacts. Sources: [OpenGitOps (CNCF)](https://opengitops.dev/) · [StackStorm](https://github.com/StackStorm/st2) · [CD Foundation / "build once, promote many"](https://cd.foundation/). Excerpts quoted for analysis (fair use).

## What it is
This is the composite delivery pattern most mature platforms converge on, with three interlocking parts:

1. **GitOps** — the desired state of a system is declared in Git (the single source of truth); a reconciler continuously pulls and converges actual state toward it. See [`../standards/opengitops.md`](../standards/opengitops.md) for the four principles (declarative, versioned/immutable, pulled automatically, continuously reconciled).
2. **Runbook automation** — operational responses ("when X, do Y with these checks/approvals") are codified as event-triggered, rule-matched workflows rather than tribal knowledge. See [`../technologies/stackstorm.md`](../technologies/stackstorm.md) for the canonical engine.
3. **Environment promotion of artifacts** — the discipline of **building an artifact once** and **promoting that same immutable artifact** across environments (dev → staging → prod) through gates/approvals, instead of rebuilding per environment.

The load-bearing idea tying them together: **promote, don't rebuild.** A version that passed tests in staging must be byte-for-byte the version that reaches prod; only *config/binding* differs per environment, never the artifact.

## Key elements / features
- **Build once, promote many.** A single immutable, content-addressed artifact (container image, package, resolved manifest) is produced once and moves through environments unchanged. Each promotion re-binds environment-specific config, not the artifact.
- **Immutable artifacts.** Artifacts are addressed by digest/hash and never mutated. Rollback = re-pointing to a previous immutable artifact, not a rebuild.
- **Promotion vs rebuild.** Rebuilding per environment risks drift (different base images, dependency resolution, timestamps) — the same source can yield a different artifact. Promotion eliminates that class of "works in staging, breaks in prod" by guaranteeing identity.
- **Promotion rules.** Declarative or runbook rules govern *when* a promotion happens: *"new image on `main` → auto-promote to staging"*; *"tag `v*` → open a prod promotion requiring approval."*
- **Gates & approvals.** Promotions pass through automated gates (tests, contract/compatibility checks, health soak, cost, security scans) and human approvals before applying to the next environment.
- **Progressive rollout on apply.** The final apply commonly uses canary/blue-green/progressive strategies so even an approved promotion limits blast radius.
- **Auditability.** Because Git records *what* and the runbook engine records *when/why*, the full provenance of "which artifact, promoted by whom, through which gates" is reconstructable.
- **Pull-based reconciliation.** Tools (Argo CD, Flux) sync the declared state from Git into the cluster; the promotion writes a new desired state, the reconciler converges it.

## Relevance to HoBo
HoBo realizes all three parts, and tightens the promotion model into one of its sharpest differentiators.

**GitOps publisher.** A Camp can use a **GitOps publisher** (`@hobo/cd-gitops`): the resolved **Deployment Set** is rendered as an Argo CD `Application` or Flux `Kustomization`, committed to a Git repo/branch, and **Argo CD / Flux** sync it; HoBo counts the Camp converged only from the engine's observed status ([Plan 25](../design/platform-engineering.md#plan-25)). It is "just another publisher target" — the resolution/matching/event-sourcing pipeline is unchanged; only the final apply differs (supports standalone, GitOps, or hybrid). HoBo aligns at the boundary with the OpenGitOps principles rather than reinventing the reconciler ([`../standards/opengitops.md`](../standards/opengitops.md)).

**Runbook automation = Pipelines + typed hooks.** A HoBo delivery **Pipeline** is a graph with lineage (Freight reaches a node only after upstream qualification and soak, or an expiring approval), and runbook automation attaches to it as typed `RUNBOOK`, `NOTIFY` and `SUITE` hooks rather than a separate step runner ([continuous-delivery.md](../design/continuous-delivery.md)). The canonical OSS analog is StackStorm ([`../technologies/stackstorm.md`](../technologies/stackstorm.md)); HoBo's version is event-sourced + policy-gated + agent-drivable.

**Promotion as "apply an immutable Set as a Delta" — the key insight.** HoBo formalizes the two halves of a deployment ([Plan 25](../design/platform-engineering.md#plan-25)):
- **Deployment Set** = the immutable, complete, **content-addressed** resolved configuration of a Camp at a point in time — HoBo's immutable artifact.
- **Deployment Delta** = a mutable, reviewable diff proposed against the current Set; applied → produces a new Set.

**Decided: promote carries Freight and re-resolves; it never copies a Set** ([ADR-0182](../design/adr/01-architecture-core.md#adr-0182) D2). The promotable unit is **Freight**: the immutable, content-addressed record of one Bindle version (declaration hash, artifact digests, source, provenance). `promote` = carry the same Freight into the target Camp, **re-run Matching for that Camp**, and apply the result as a Delta, gated. The artifact bytes are identical in every Camp (build once, promote many), while `production` and `ephemeral` Camps legitimately resolve different infrastructure; that difference is computed and shown as `infrastructure_diff`, so re-resolving keeps the predictability copying was meant to buy. Copying was rejected because a copied Set would carry the source Camp's infrastructure into a target it was never matched against.

**Multi-environment / multi-cloud.** A multi-region `production` is several Camps under one (provider-specific) Yard, and multi-cloud spans Yards under a Junction; promoting across an environment group is a saga ([ADR-0028](../design/adr/01-architecture-core.md#adr-0028)), surfaced as `env.PromoteRequested` / `env.Promoted` / `env.PromoteRolledBack` events ([Plan 11](../design/data-plane.md#plan-11)).

**Gates & approvals = the `can-deploy` gate + policy obligations.** Applying a Delta or promoting a Set runs the **Gatekeeper** against the versions already running in the target Camp ([Plan 25](../design/platform-engineering.md#plan-25)): **contracts-compatible** (`compat.GatePassed/Failed`, [Plan 29](../design/contracts-policy-flags.md#plan-29)) **AND policy-allows** (with **obligations** that can *reshape* the rollout — "allow but require canary" — [Plan 29](../design/contracts-policy-flags.md#plan-29)) **AND** evals/conformance/cost. Approval gates are `createHook`s resolved in the dashboard ([Plan 6](../design/ai-native-agent-auth.md#plan-06), [Plan 25](../design/platform-engineering.md#plan-25)). App-data schema migrations (expand/backfill/contract, [Plan 32](../design/data-plane.md#plan-32)) compose *into* this same promotion flow — a destructive contract phase that would break a still-running version is blocked.

**Why HoBo's version is stronger than the generic pattern.** Sets/Deltas are **projections over the event log**, not bespoke tables, so promote/rollback/preview inherit replay + audit for free, rollback is a Delta back to the predecessor Set through the same gate (stateful resources keep state, [Plan 5](../design/reliability-observability-cost.md#plan-05)), and `match.Decided` makes "why did *this* Camp resolve *that* infra?" answerable. Promotion identity (immutable, content-addressed Set) + can-deploy gating (compatibility + policy obligations) is exactly the "promote, don't rebuild, and don't promote into an incompatible target" guarantee this pattern aspires to.

## Sources
- [OpenGitOps — Principles (CNCF)](https://opengitops.dev/)
- [Argo CD — Declarative GitOps CD](https://argo-cd.readthedocs.io/)
- [Flux CD docs](https://fluxcd.io/flux/)
- [StackStorm/st2 — event-driven runbook automation](https://github.com/StackStorm/st2)
- HoBo internal cross-refs: [Plan 25](../design/platform-engineering.md#plan-25) · [Plan 25](../design/platform-engineering.md#plan-25) · [Plan 29](../design/contracts-policy-flags.md#plan-29) · [Plan 29](../design/contracts-policy-flags.md#plan-29) · [ADR-0028](../design/adr/01-architecture-core.md#adr-0028)
