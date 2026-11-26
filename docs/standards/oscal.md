---
type: Reference Standard
title: "OSCAL — Open Security Controls Assessment Language"
description: "NIST's machine-readable models for control catalogs, implementations, and assessments; HoBo aligns its control→evidence packs to OSCAL vocabulary and can emit assessment evidence at the boundary."
tags: [hobo, standards]
---

# OSCAL (Open Security Controls Assessment Language)

> **Standard** · NIST's set of machine-readable models (JSON/YAML/XML) for the
> whole compliance chain: control **catalogs** (e.g. SP 800-53) → **profiles**
> (baselines/tailoring) → **component definitions** → **system security plans**
> → **assessment plans/results** → **POA&M**. Sources: pages.nist.gov/OSCAL,
> github.com/usnistgov/OSCAL. Factual surface quoted under fair use.

## What it is

OSCAL replaces prose compliance documents with typed, layered models: a
*catalog* defines controls; a *profile* selects and tailors them; a *component
definition* states how a product/component implements controls; a *system
security plan* composes components for one system; *assessment results* and
*POA&M* record what an assessor found. FedRAMP's automated review pipeline is
the flagship adopter; GRC tooling increasingly imports/exports it.

## Key features

- **Layered models** — catalog / profile / implementation / assessment are
  separate documents with typed cross-references, so each party owns its layer.
- **Component definitions** — "this component satisfies AC-3 this way" as
  data, reusable across systems: the exact shape of a platform's compliance
  story.
- **Machine-readable assessments** — findings/evidence as data, not PDFs.
- **Format-neutral** — JSON/YAML/XML with official converters and schemas.

## Relevance to HoBo

**Align-our-model + emit-at-the-boundary; never a schema dependency**
([ADR-0144](../design/adr/07-portability-extensibility.md#adr-0144) posture;
decision recorded in
[ADR-0146](../design/adr/02-identity-security.md#adr-0146)). The mapping:

| OSCAL | HoBo |
|---|---|
| Component definition + control-implementation | **Control→evidence pack** (`hobo.control-evidence-pack/v1`, `@hobo/policy`): controls cite evidence refs (`event-stream:` / `gate:` / `artifact:` / `retention:`) with honest per-control status |
| Catalog / profile | The named framework + version on the pack (e.g. NIST SP 800-53 rev5 seed); catalogs stay external — HoBo never re-publishes them |
| Assessment results / evidence | The evidence sources themselves: `policy.Decided`, `gatekeeper.Decided`, never-compact credential audit ([ADR-0023](../design/adr/02-identity-security.md#adr-0023)), OCSF export ([`./ocsf.md`](./ocsf.md), [ADR-0046](../design/adr/02-identity-security.md#adr-0046)), SBOM/provenance, crypto-shred records — exported for external GRC/assessor tooling |
| POA&M | `evaluateControlCoverage` missing-control output — the computable gap list |

Boundary kept honest: HoBo **exports evidence; it does not attest**
([governance-planes](../design/governance-planes.md) scope;
[compliance-evidence-pack](../design/compliance-evidence-pack.md) forbids
certification claims). An OSCAL-JSON emitter for component definitions /
assessment evidence is a natural boundary artifact when an adopter's GRC
pipeline wants it — an iteration hook, not a commitment.

## Sources

- https://pages.nist.gov/OSCAL — models + reference docs
- https://github.com/usnistgov/OSCAL — schemas
- https://automate.fedramp.gov — the flagship consuming pipeline
