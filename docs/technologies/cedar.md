---
type: Reference
title: "Cedar — Technology Reference"
description: "AWS's open-source authorization policy language + engine (principal/action/resource/condition, formally verified); an optional HoBo policy-engine provider beside OPA/Rego."
tags: [hobo, technologies]
---

# Cedar

> **Technology** · Open-source authorization policy language + evaluation
> engine from AWS (powers Amazon Verified Permissions), Apache-2.0, written in
> Rust with a formally verified core. Sources: cedarpolicy.com,
> github.com/cedar-policy. Factual surface quoted under fair use.

## What it is

Cedar expresses authorization as `permit`/`forbid` statements over
**principal, action, resource, and conditions** (`when`/`unless` clauses over
typed entity attributes). Policies are validated against a schema, evaluated
deterministically (forbid overrides permit), and designed for microsecond
decisions. The engine's semantics are formally modeled (Lean proofs);
`cedar-agent` exposes an HTTP `is_authorized` endpoint analogous to OPA's
server mode.

## Key features

- **Purpose-built authorization DSL** — narrower than Rego (general-purpose
  Datalog-ish), which makes policies easier to analyze and audit.
- **Schema-validated entities** — typed principals/resources/attributes;
  policy analysis (who can access what) is tractable.
- **Deny-overrides semantics** — `forbid` always wins; default deny.
- **Formally verified evaluator** — differential-tested Rust against a Lean
  model.

## Relevance to HoBo

**Adopt-behind-a-port — a canonical optional `policy-engine` provider.**
ADR-0015 ([identity-security](../design/adr/02-identity-security.md#adr-0015))
pins HoBo's policy plane as typed TypeScript by default with **OPA/Rego and
Cedar as optional providers** behind the `policy-engine` port; the adapter is
real (`packages/broker/src/cedar.ts`, `CEDAR_ENGINE_ID = "cedar@v1"`,
cedar-agent `is_authorized`, fail-closed deny on unreachable engine) and
selectable via the broker's `broker_policy_cedar` flag
([hobo-broker](../design/hobo-broker.md)). Proofs `hobo-133`, `hobo-212`
(federated policy conflict), `hobo-223` exercise it. What HoBo borrows
conceptually: **deny-overrides composition** (mirrored in the deny-ceiling
policy-pack algebra, ADR-0096) and the demonstration that a **narrow, typed
policy language beats a general one for auditability** — the same bet HoBo's
typed Policy IR makes. Divergence kept honest: HoBo policy decisions are
event-sourced (`policy.Decided`) and composed by Gatekeeper; Cedar evaluates
one request, HoBo owns the decision record and its replay.

## Sources

- https://www.cedarpolicy.com — language + tutorial
- https://github.com/cedar-policy/cedar — engine, Lean models
- https://github.com/permitio/cedar-agent — HTTP agent HoBo's adapter targets
