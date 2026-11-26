---
type: Reference
title: "HOBO-630 Registry Capability Manifest Ingest Proof"
description: "Source issue: HOBO-630."
tags: [hobo, design]
---

# HOBO-630 Registry Capability Manifest Ingest Proof

Draft POC for S3-04 `@hobo/registry`: ingest and signature-verify provider Capability
Manifests from `/.well-known/capability-manifest/`, index capabilities/auth/cost, expose
capability search, and store plugin records with provenance and conformance reports.

## Branch Evidence

- Issue: HOBO-630
- Draft package:
  [`src/draft/technical-proofs/registry-capability-manifest-ingest-contract`](../../../../src/draft/technical-proofs/registry-capability-manifest-ingest-contract/README.md)
- Focused gate:
  `pnpm --prefix src/draft/technical-proofs/registry-capability-manifest-ingest-contract test`

## Acceptance Mapping

| Issue acceptance | Proof |
|---|---|
| Cloudflare manifest ingests from well-known path. | `buildCloudflareWellKnownBundle` + ingest test pins S2-08 Cloudflare fixture through signature verification. |
| `ProviderRegistered` / `CapabilityManifestUpdated` events land. | Registry event projection test asserts both event types on first ingest. |
| Planner reads capabilities from Registry instead of local fixtures. | `createPlannerCapabilitySource().listCapabilities` returns indexed Cloudflare `hobo:runner` / `hobo:kv` entries. |
| Capability search indexes auth and cost alongside capabilities. | Ingest test asserts stored `auth.mode` and `cost.currency`; search results include `authMode` and `costSkus`. |

## Adversarial Coverage

The executable proof rejects unsigned manifests, tampered index signatures, document digest
mismatch, and capabilities without conformance coverage.

## Scope Boundary

This proof does not implement production `packages/registry/` transport, OCI artifact
storage, live provider crawlers, or MCP `search_registry` HTTP serving.
