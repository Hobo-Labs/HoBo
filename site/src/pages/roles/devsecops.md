---
layout: ../../layouts/Docs.astro
title: HoBo for DevSecOps
description: "Security professionals write policy — camp approval rules, credential policy for humans and agents, and above all the policy packs that govern junction borders."
---

# HoBo for DevSecOps

**You write policy.** Not PDFs — the machine-enforced rules that every deploy, every inferred camp, every migration, and every credential grant must pass. In HoBo, policy isn't advisory review after the fact; it runs *inside* the convergence loop, and a failed check stops the mutation before it happens.

## Where your rules bite

| Surface | What your policy decides |
|---|---|
| **The gate** | Every `hobo up` re-runs the applicable gate before mutation — a stale preflight can never authorize a deploy. Your checks are part of that gate. |
| **Camp approval** | Inferred camps are approved by policy, not automatically. You define what an acceptable home looks like (provider, region, runtime, data class). |
| **Migration gates** | Continuous migration only moves an app when the destination passes the same checks — cost never outranks compliance. |
| **`.allow()` review** | Developers' least-privilege grants live in the bindle diff. Deny-by-default linking means an undeclared edge doesn't exist at runtime. |
| **Credential brokering** | Humans *and* AI agents get short-lived, task-scoped tokens under a machine-readable capability standard — no static keys to leak. Issuance itself is an event. |
| **Junction borders** | Your highest-leverage surface — see below. |

## Junctions are where your policy matters most

A [junction](/HoBo/primitives/junctions/) is where clouds meet, so it's where sovereignty, residency, and egress live. Junction policy travels as **signed policy packs** — versioned artifacts federated to the member yards, because a junction shares no mutable state:

- **Residency & sovereignty:** which data classes may live in which yards, and what may never cross a border — the Dispatcher can't propose a cross-cloud move your pack forbids.
- **Egress & connectivity:** what the inferred cross-cloud connectivity plane is allowed to connect.
- **Placement lockdown:** the junction broker admin can turn camp inference off entirely, requiring explicit, approved camps — placement as a deliberate act.
- **Trust federation:** signed registry bundles and trust roots decide which providers and adapters are even installable (`hobo add` enforces signature, provenance, and conformance checks).

## Configuring the Conductor

[The Conductor](/HoBo/primitives/stations/#the-conductor) — the broker that decides where every
app lives — acts **only** on the policy set you configure. That policy set is
one reviewable document, `hobo.broker.json`, and it is where budgets, cloud
connectors, and your policy engine of choice all meet:

```bash
hobo broker config --init # scaffold hobo.broker.json
hobo broker config # validate it and print the policy hash
hobo broker up # realize placements under it
```

A production-shaped config:

```json
{
	"schemaVersion": "hobo.broker/v1",
	"brokerId": "broker:acme-prod",
	"placementPolicies": [
		{ "id": "pp-default", "scopeKind": "bindle", "objective": "min-cost" },
		{
			"id": "pp-eu-lockdown",
			"scopeKind": "junction",
			"objective": "min-cost",
			"allowedRegions": ["eu-west-1", "eu-central-1"],
			"deniedProviders": ["legacy-vendor"],
			"requireExplicitCamps": true
		}
	],
	"billing": {
		"quota": "deployments/day",
		"quotaLimit": 50,
		"budgetUsd": 2000,
		"spendCapUsd": 100
	},
	"connectors": [
		{
			"id": "conn-github",
			"kind": "github-app",
			"displayName": "Acme HoBo App",
			"settings": { "appId": "12345", "installationId": "678" },
			"credentialRef": "token-broker://github-app/acme"
		},
		{
			"id": "conn-cf",
			"kind": "cloudflare",
			"displayName": "Acme Cloudflare",
			"settings": { "accountId": "acct-1" },
			"credentialRef": "token-broker://cloudflare/acme"
		}
	],
	"requiredConnectorKinds": ["github-app", "cloudflare"],
	"policyEngine": { "kind": "opa", "endpoint": "http://opa.policy.svc:8181" },
	"delivery": {
		"engine": "argo",
		"syncMode": "auto",
		"gitopsRepo": "https://git.acme.dev/hobo-receipts",
		"destinationNamespace": "hobo-prod"
	}
}
```

What each block buys you:

- **Placement policies** layer junction → yard → camp → bindle; your
 restrictions (denied providers, region allowlists, the explicit-camp
 lockdown) *accumulate* — no narrower policy can undo them.
- **Billing** is enforcement, not reporting: quotas, a per-resolution spend
 cap, and a budget the broker refuses to exceed — with a metered mode that
 folds real usage facts into what's left.
- **Connectors** name the cloud accounts the Conductor may act through
 (GitHub App, Pulumi, Azure, Vercel, Cloudflare, custom). `credentialRef`
 points into the token broker — this file never contains a secret, so it
 belongs in review like any other code.
- **`policyEngine`** swaps the decision engine: keep the built-in typed
 policy packs, or point at your **OPA/Rego** decision
 (`hobo/broker/decision`) or **Cedar** authorizer. Either way the broker
 *fails closed* — an unreachable policy engine denies, it never waves
 things through. Every evaluation records a `policy.Decided` fact, allows
 included.
- **Delivery** hands accepted receipts to your GitOps rollout (Argo CD) or
 the in-proc executor.

And for trying policy changes safely: run `hobo broker up` with **no** cloud
config, and the running machine registers itself as a zero-cost local HoBo
provider host — the same pipeline, the same rejection codes, no cloud bill.

## Evidence, not assertions

Everything above lands in the same append-only event log as the deploys it governs:

- **Every decision is a fact.** Policy passes, refusals, camp approvals, token grants — attributable, replayable, exportable.
- **`hobo attest`** produces signed audit-evidence exports for your assessors.
- **`hobo erase`** performs crypto-shred erasure with projection rebuild when data must genuinely disappear.
- **Time travel is an audit tool:** "where did this workload live in March, under which policy version, and who approved the move?" is a query, not an investigation.

## Working with the other roles

- [Developers](/HoBo/roles/developers/) hand you a reviewable `.allow()` surface in every PR — push grant hygiene there, and the rest of the pipeline stays quiet.
- [Platform engineers](/HoBo/roles/platform-engineers/) own the map your policy constrains; the approved-provider set and your packs compose — the Dispatcher obeys both.
- [Agents](/HoBo/agents/) are principals under exactly your credential policy — no special lane, and every action they take is in your log.
