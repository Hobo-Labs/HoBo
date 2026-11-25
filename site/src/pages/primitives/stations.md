---
layout: ../../layouts/Docs.astro
title: Stations & the Conductor
description: "Station is the hard control-plane isolation boundary a Conductor occupies — Rails, connections, bootstrap, and the pure Conductor (broker) placement authority."
---

# Stations & the Conductor

A **Station** is the hard control-plane isolation boundary a **Conductor** occupies. It is **not** Bindle ⊂ Camp ⊂ Yard ⊂ Junction containment. The **Conductor** (sometimes called the broker in lower-level surfaces) is a **pure runtime** that mounts a Station client + active Rail(s), runs resolve/scale/deliver, and emits receipts that pin `stationId` + `railHash` (+ catalog/policy hashes). It owns no durable Connections or policy packs — the Station does.

## Station owns

| Asset | Role |
|---|---|
| Connections | Authorized dial/control relationships |
| Rails | Content-addressed profiles / pins |
| Bootstrap Rail | Initial trusted least-privilege profile |
| Local client state | Under `HOBO_HOME/stations/` |

Authoring and ops surfaces: `station()` helpers, Rails, local client, and Privileged Access Gateway hooks.

## Station CLI (ops/setup)

```text
hobo station init|up|down|status|rails *
```

These are **ops**, not app lifecycle verbs. Missing Station **fails closed** for control-plane work — run `hobo station init`.

### Profile requirements

| Field | Role |
|---|---|
| `defaultStation` | Which Station is active |
| `activeRail` | Which Rail pins policy/profile |
| `defaultBrokerUri` | Remote Conductor HTTP endpoint only — **not** a setup path |

Cross-Station Connection use fails closed without federation grant.

## PAM

Privileged Access Gateway sessions can be Station-aware — break-glass paths still audit.

---

## The Conductor

Somebody has to decide which provider hosts your bindle, whether a deploy is allowed, whether it fits the budget, whether it breaks a downstream contract, whether the app scales up or down to zero. That somebody is **the Conductor** — the one who decides which train you're riding. In code: **broker** (Conductor). Same component.

The Conductor decides *only* from the policies it is configured to maintain, while **occupying a Station**.

### What it does

It takes a brokering request — "place these resources for this [bindle](/HoBo/primitives/bindles/), in this scope" — and answers with exactly one of:

- a **Resolution Receipt**: per-resource placements (provider, region, SKU, price), pinned to content hashes of the provider catalog and the policy set — optionally **Ed25519-signed**; or
- a **Resolution Rejection**: machine-readable reasons from a **closed rejection catalog**, each naming the enforcement plane that refused (`policy`, `contracts`, `billing`, `placement`, `connectors`) with a remediation agents can act on.

Placement is brokered **per resource, across providers**. Spin-up/spin-down (`up` / `down` / `zero`) are Conductor commands; accepted receipts go to delivery (Argo CD Application rendering / live submission when wired).

### The five planes it wraps

| Plane | What it enforces | Default | Also shipped |
|---|---|---|---|
| **Policy** | placement, approvals, junction lockdowns | TypeScript policy packs | OPA/Rego fail-closed |
| **Contracts** | can-deploy compatibility | Gatekeeper / PACT | external Pact broker feed |
| **Billing** | budget, spend caps, quotas | in-proc billing policy | metered plane over usage facts |
| **Delivery** | rolling out accepted receipts | rendered Argo Applications | live Argo CD API, fail-closed |
| **Connectors** | external systems the Conductor may act through | connector registry | external catalog |

Unreachable external policy engines **fail closed** — no engine, no placement.

### Policies are layered — lockdowns win

Merge outside-in: **junction → yard → camp → bindle**. Choice-shaped fields can be overridden by narrower scopes; **restrictions accumulate** (denied providers stay denied). Junction broker-admin lockdowns cannot be relaxed by bindle policy.

### Connector registry

Connectors (GitHub App, Pulumi, Azure, Vercel, Cloudflare, …) are registered with **credentialRef pointers only** — never secrets in the registry. The Conductor brokers short-lived access through identity/Station connections.

### CLI

```text
hobo broker config [--init]
hobo broker up
```

Requires Station context when available (`HOBO_STATION` / profile / `--station`). With no cloud config, the local machine can register as a zero-cost local provider host so the loop is testable offline.

### Related

[Control plane](/HoBo/architecture/control-plane/) · [Security](/HoBo/security/) · [Matching](/HoBo/reference/matching/) · [CLI](/HoBo/reference/cli/) · [Connectivity](/HoBo/reference/connectivity/)
