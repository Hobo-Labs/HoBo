---
type: Technology Reference
title: "Open Policy Agent (OPA) & Rego"
description: "**Open Policy Agent (OPA)** is an open-source, **general-purpose policy engine** that \"unifies policy enforcement across the stack.\" Its central design move is to **decouple policy"
tags: [hobo, technologies]
---

# Open Policy Agent (OPA) & Rego

> Technology — general-purpose policy engine + the Rego policy language. Source: [openpolicyagent.org](https://www.openpolicyagent.org/) · [Docs](https://www.openpolicyagent.org/docs) · [Gatekeeper](https://open-policy-agent.github.io/gatekeeper/) · [GitHub `open-policy-agent/opa`](https://github.com/open-policy-agent/opa). CNCF graduated project. Excerpts quoted for analysis (fair use).

## What it is
**Open Policy Agent (OPA)** is an open-source, **general-purpose policy engine** that "unifies policy enforcement across the stack." Its central design move is to **decouple policy decision-making from policy enforcement**: services don't embed authorization logic — they ship a structured query to OPA and receive a decision back. Policies are written in **Rego**, a declarative query language inspired by Datalog, purpose-built for querying nested/hierarchical structured data (JSON/YAML).

OPA evaluates a query against two inputs: **`input`** (the request/event being decided, supplied by the caller) and **`data`** (background data + the loaded policies). The result is **arbitrary structured data**, not just a boolean — so a decision can carry a verdict plus reasons, obligations, or transformed output.

## Key features
- **Rego language**: declarative rules over JSON-like data; implicit iteration via variable binding; **complete rules** (single value) and **partial rules** (build sets/objects); rich built-ins; logical AND (rule body) / OR (multiple rule definitions).
- **`input` / `data` / query model**: callers POST `input`; OPA combines it with `data` (facts) and the loaded policy to evaluate a named query (e.g. `data.authz.allow`).
- **Decisions are structured data**: simple allow/deny *or* objects with reasons, sets of violations, or computed values — the caller decides how to enforce.
- **Deployment modes**:
  - **Go library** — embed OPA directly in an application.
  - **Sidecar / host-level daemon** — run OPA as a server exposing a REST API (`POST /v1/data/...`), co-located with the service or per node.
  - **WASM** — compile policies to WebAssembly for embedding in other runtimes/languages.
- **Bundles**: distribute policy + data together as gzipped tarballs, pulled periodically over HTTP/S3/OCI (the bundle API), giving versioned, signed policy distribution and a clean management-plane → enforcement-point split.
- **Decision logs**: every decision can be logged with `input`, the policy/package, a decision ID, and timestamps — a complete, replayable audit trail of *why* something was allowed or denied.
- **Partial evaluation**: OPA can pre-evaluate a policy against partial input to produce a residual/optimized policy (e.g. translate a query into a database filter), and uses indexing/partial eval to prune irrelevant branches for performance.
- **OPA Gatekeeper**: a Kubernetes **validating/mutating admission controller** built on OPA, with `ConstraintTemplate`/`Constraint` CRDs, audit of existing resources, and policy enforcement at cluster admission.

## Relevance to HoBo
OPA/Rego maps **directly** onto HoBo's policy plane — and HoBo's design explicitly names it as an optional provider, while keeping the *decision model* its own.

- **`policy-engine` WIT port with OPA as an optional provider** ([`../design/30-policy-plane.md`](../design/contracts-policy-flags.md#plan-29)). Plan 30 defines a single `policy-engine` port whose **default** is built-in **TypeScript rules** (no Rego to learn), with **OPA/Rego (`@hobo/provider-opa`)** and **Cedar** as **optional capability providers**. The provider "maps the request to OPA `input`, runs as embedded/WASM/sidecar/Envoy, returns the decision" — exactly OPA's library/sidecar/WASM modes. This is HoBo adopting OPA *behind a port* rather than baking it in.
- **Decision/enforcement split is the same split OPA advocates.** Plan 30 states: "HoBo Cloud is the **management plane** (pack registry, distribution, decision logs); Camps/providers are **enforcement points** — the same decision/enforcement split OPA advocates, but HoBo owns the model." HoBo's **policy packs** (versioned, signed, distributed like Resource Packs) are the analogue of OPA **bundles**.
- **Decision logs ↔ `policy.Decided` events** ([`../design/11-event-model.md`](../design/data-plane.md#plan-11)). OPA's decision logs (input + policy id + decision id + timestamp) correspond to HoBo's `policy.Decided` / `policy.ViolationDetected` events, which carry `effect`, `evidence: { policyIds[], inputHash, engine }`, and obligations — a replayable answer to "why was this allowed/blocked, under which pack version?" HoBo's decision is **richer than allow/deny** (allow / deny / warn / mutate / require-approval **+ obligations**), matching OPA's "decisions are arbitrary structured data."
- **Gatekeeper ↔ HoBo's `can-deploy` / Gatekeeper** ([`../design/29-contracts-compatibility.md`](../design/contracts-policy-flags.md#plan-29)). OPA Gatekeeper gates Kubernetes admission; HoBo's unified **Gatekeeper** (`hobo verify`) composes the policy decision with contracts, evals, conformance, and cost into one deploy gate — a generalization of admission control beyond K8s, across Camps/providers.
- **Obligations vs OPA.** A notable HoBo extension: an OPA decision is data the caller may act on, whereas a HoBo **obligation** ("allow but require canary / shadow eval / human approval") is a **durable, event-sourced saga** tracked to completion (`policy.ObligationCreated → …Satisfied`) — HoBo owns that lifecycle on top of whatever engine renders the verdict.

Net: **adopt-behind-a-port.** OPA/Rego is the canonical optional provider for HoBo's policy plane; HoBo borrows OPA's decision/enforcement architecture and bundle/decision-log patterns but keeps the request/decision/obligation **model** its own and TS-default.

## Sources
- OPA documentation — https://www.openpolicyagent.org/docs
- OPA homepage — https://www.openpolicyagent.org/
- Policy decoupling / decisions as data — https://www.openpolicyagent.org/docs/philosophy
- Bundles — https://www.openpolicyagent.org/docs/management-bundles
- Decision logs — https://www.openpolicyagent.org/docs/management-decision-logs
- OPA Gatekeeper — https://open-policy-agent.github.io/gatekeeper/
- GitHub — https://github.com/open-policy-agent/opa
