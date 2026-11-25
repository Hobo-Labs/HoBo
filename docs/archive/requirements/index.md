# HoBo — Requirements Suite

> The **requirements layer** over the [HoBo Design Plan Suite](../../design/index.md). Where the design docs (`docs/design/0–36`) explain *how* HoBo works, this layer states *why* (business), *what* (product), and *how — in requirements terms* (technical) — with stable IDs and end-to-end traceability so business intent, product scope, and engineering work cannot silently drift apart.
>
> **Status:** Draft for review · **Date:** 2026-06-20 · Phase: design.
> **Archive note:** this suite was moved under docs/archive/ and its links remapped — design paths resolve via ../../design/, the roadmap lives beside this suite at ../roadmap.md, forge-generated-stack.md is now generated-stack.md, and the former ADR theme docs 04/05/06/08 were consolidated into the four current theme docs (see ../../design/adr/index.md).

## The document

Everything lives in one document, [**requirements.md**](./requirements.md), split into three top-level sections plus a shared header and the traceability matrix:

| Section | Audience | Owns | IDs |
|---|---|---|---|
| [**Business Requirements**](./requirements.md#business-requirements) | Founders, business, GTM | Problem, market, objectives, business model, KPIs, risks | `BR-NNN` |
| [**Product Requirements**](./requirements.md#product-requirements) | Product, design, eng leads | Personas, journeys, functional + non-functional requirements, release criteria | `FR-NNN`, `NFR-NNN` |
| [**Technical Requirements**](./requirements.md#technical-requirements) | Engineering, platform, SRE | Architecture, subsystem technical requirements, interfaces | `TR-NNN` |

Shared [Document control](./requirements.md#document-control) (RACI, sign-off, vision, scope, glossary) sits up top; the authoritative [**Traceability matrix**](./requirements.md#traceability-matrix) sits at the end.

## How they relate (traceability model)
Decided in [ADR-0018](../../design/adr/07-portability-extensibility.md#adr-0018):

```
Business need ──BR──▶ Product capability ──FR / NFR──▶ Technical requirement ──TR──▶ design doc + conformance/verification
```

- Every **BR** maps to ≥1 **FR**/**NFR**; every **FR**/**NFR** maps to ≥1 **TR**; every **TR** cites the governing `docs/design/*` doc and how it's verified ([09](../../design/generated-stack.md#plan-09)).
- The authoritative **BR→FR/NFR→TR matrix** lives in [requirements.md §Traceability matrix](./requirements.md#traceability-matrix).
- Everything is **v1** ([ADR-0063](../../design/adr/07-portability-extensibility.md#adr-0063)); **MoSCoW** now expresses **build priority/order within v1** (mapped to the build stages in the [per-stage build detail](../roadmap.md#per-stage-build-detail-stages-06)), not a release boundary.
- This layer **cites** the design suite; it does not restate it. The design docs remain the source of design truth.

## Decision log for this suite
Authored alongside the document (one ADR per load-bearing decision) — see the [ADR index](../../design/adr/index.md):
- [ADR-0018](../../design/adr/07-portability-extensibility.md#adr-0018) — requirements structure & traceability
- [ADR-0019](../../design/adr/07-portability-extensibility.md#adr-0019) — persona prioritization / primary ICP
- [ADR-0021](../../design/adr/07-portability-extensibility.md#adr-0021) — NFR baselines / SLOs (Proposed)
- [ADR-0063](../../design/adr/07-portability-extensibility.md#adr-0063) — single v1 scope (whole designed surface ships as one v1; P0–P6 become build stages; supersedes the removed ADR-0022 MVP-scope/MoSCoW line)
- [ADR-0064](../../design/adr/07-portability-extensibility.md#adr-0064) — scope: AI-native meta-cloud (removes business/monetization; keeps app generation)
- [ADR-0023](../../design/adr/02-identity-security.md#adr-0023) — security posture commitments *(from the review/hardening pass)*
- [ADR-0024](../../design/adr/07-portability-extensibility.md#adr-0024) — portability conformance guarantee *(from the review/hardening pass)*

## Reading order
New reader: [Business Requirements](./requirements.md#business-requirements) → [Product Requirements](./requirements.md#product-requirements) → [Technical Requirements](./requirements.md#technical-requirements). For design depth behind any requirement, follow its citation into [`docs/design`](../../design/index.md) (start with [10 Architecture](../../design/architecture.md#plan-10) and [19 Worked example](../../design/worked-example.md#plan-19)).

## Glossary
The document reuses the canonical vocabulary verbatim — the nested scopes **`Junction ⊃ Yard ⊃ Camp ⊃ Bindle`** (Junction = cross-cloud / hybrid, connects Yards; Yard = provider-specific cross-Camp scope — one provider's cross-Camp policy + that provider's control plane; Camp = provider-specific target that provides the durable **runtime ports**; Bindle = app config), Port, Provider, Forge, Grain, Planner, ResourceActor, Executor, SVID, Capability Manifest/Signs, IfC, `.allow()`, `.with(...)`, Manifest IR, Stub, Resource Definition/Matching, Deployment Set/Delta, Gatekeeper, the four-lens taxonomy. Definitions: [design suite glossary](../../design/index.md#glossary--naming-thematic-all-tunable).
