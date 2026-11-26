---
layout: ../../layouts/Docs.astro
title: Multi-tenant & policy
description: "Zero-trust posture, deny-by-default policy, lanes, guardrails, network isolation, supply chain, audit/OCSF, and provider-terms hygiene."
---

# Multi-tenant & policy

Posture: **secure-by-default, zero-trust, defense-in-depth**. Every principal (human, workload, agent) is authenticated and authorized per action — not trusted because it is “inside the VPC.”

## Threat model (summary)

| Asset | Primary mitigations |
|---|---|
| Provider credentials | Keyless OIDC federation; short-lived resource-scoped tokens |
| Tenant data & streams | Per-tenant isolation; claim enforcement on envelopes |
| Executors | MicroVM isolation; no ambient creds; no egress by default |
| Generation plugins | Signed + conformance; sandboxed runs |
| Capability Manifest prose | Treat discovery text as untrusted (prompt-injection aware) |
| Yard itself | Append-only log + fencing; least privilege; immutable history |
| Agents | Scoped SVIDs; policy gates; spend caps; full replay |

## Deny by default

Unlisted `(role, action, resource)` tuples are denied. Control-plane CLI/MCP verbs must map to `hobo:<resource>:<verb>` actions or conformance fails.

## Policy as code

Policy packs attach to Yard/Junction. **Mandatory** rules are deny-ceilings (children may only further restrict). **Default** rules are overridable. Decisions always emit `policy.Decided` — even allows. See [Policy](/HoBo/reference/policy/).

## Lanes & sandboxes

Sandbox lanes isolate experimental traffic and contract observations so they cannot poison baseline contracts or training trajectories. Baseline subscribers ignore sandbox-lane events by default.

## Guardrails

AI operators and generation paths run under enforced guardrails (PII, jailbreak, unsafe tool use). Blocks are events: `guardrail.Blocked` + `policy.Decided`.

## Network isolation

Hard environment isolation and optional Privileged Access Gateway bound who can reach what. Overlay (Tailscale/Netbird-class) and hierarchical DNS names live in connectivity — never bare `.hobo` TLD. Details: [Connectivity](/HoBo/reference/connectivity/) · [Naming](/HoBo/reference/naming/).

## Supply chain

- Plugins: signed, SLSA-style provenance, conformance report required
- Images: reproducible builds, digest-pinned, scanned
- Dependencies: SBOM + vuln gates
- Air-gap: signed offline bundles — [Air-gapped](/HoBo/guide/air-gapped/)

## Audit & compliance

The event log *is* the audit log. Security-relevant families export as **OCSF** to SIEM. Audit streams are never-compact by policy. Data residency constraints are Planner-enforced.

## Provider terms

Registered providers are **the operator’s own accounts**. Never pool free-tier headroom across tenants; never rotate accounts to reset free tiers. Rotation is **across providers**, not across accounts within a provider.

## Runtime isolation (WASM)

WASM capability security is a **structural** isolation dimension (deny-by-default imports), alongside data / compute / credentials / network.

## Related

[Identity](/HoBo/security/identity/) · [Policy reference](/HoBo/reference/policy/) · [DevSecOps role](/HoBo/roles/devsecops/) · [Agent audit](/HoBo/observability/agent-audit/)
