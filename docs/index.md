# HoBo documentation hub

This directory is the OKF bundle root for HoBo documentation. It contains the current documentation set for HoBo. The root [`README.md`](../README.md) explains the project at a high level; this hub helps contributors find the right maintenance target.

## OKF bundle layout

This bundle follows Open Knowledge Format v0.1 conventions: `index.md` files provide directory listings, concept documents carry YAML frontmatter with a non-empty `type`, and repo knowledge that used to live in root-level reference folders now lives under this `docs/` tree. Run `npm run docs:okf` to validate those structural rules.

## Canonical docs

| Area | Start here | Purpose |
|---|---|---|
| Design suite | [`design/index.md`](./design/index.md) | Canonical product/platform design, ADRs through **ADR-0148** (index: [`design/adr/index.md`](./design/adr/index.md); recent: **ADR-0144** external-spec posture, **ADR-0145** Traits, **ADR-0146** jurisdiction/residency), glossary, event families, traceability, CLI and SDK contracts. |
| Lineage & credits | [`design/lineage.md`](./design/lineage.md) | The aggregate portrait: every influence with posture, what's borrowed, divergence, and capture link. |
| Implementation backlog | [`implementation-plan.md`](./implementation-plan.md) | Durable mirror of Linear's subsystem decomposition and issue plan. Linear remains live status source. |
| Agent tooling | [`agent-tooling.md`](./agent-tooling.md) | Local agent-tooling setup, trust boundaries, data-egress notes, and maintenance expectations. |
| CI performance | [`ci/performance.md`](./ci/performance.md) | Where HoBo CI Fabric wall time goes on the self-hosted box, the fixes landed, and what is left for a five-minute run. |
| Fleet enrollment | [`design/fleet-enrollment-design.md`](./design/fleet-enrollment-design.md) | Enrolled execution fleet, strict v2 at-most-once claims, scorecard, and [`fleet-enrollment.yml`](../.github/workflows/fleet-enrollment.yml) CI lane on `hobo` runners (package-relative vitest paths under `@hobo/ci`). |
| Automations | [`automations/hobo-issue-worker.md`](./automations/hobo-issue-worker.md) | How issue-worker automation should interpret design docs and report changes. |

## Reference directories outside `docs/`

| Directory | Purpose |
|---|---|
| [`../src/draft/`](../src/draft/README.md) | Executable proof/contract packages that make selected design claims testable. |
| [`competitors/`](./competitors/index.md) | Product and platform positioning references. |
| [`patterns/`](./patterns/index.md) | Architecture/operations patterns used by HoBo decisions. |
| [`plans/`](./plans/index.md) | Audit/review logs and improvement plans produced by the `/improve` tooling. |
| [`standards/`](./standards/index.md) | External standards referenced by design decisions. |
| [`technologies/`](./technologies/index.md) | Technology notes for adapters, engines, and possible implementation choices. |
| [`archive/`](./archive/) | Deferred or superseded planning artifacts. |
| [`../workflows/`](../workflows/) | Loop-me workflow specs for recurring agent/human maintenance loops (`NOTES.md` holds shared vocabulary). |

## Maintenance checklist

When docs change, verify:

- Relative links and anchors pass `npm run docs:design-lint`.
- CLI examples use canonical verbs and pass `npm run docs:cli-lint`.
- OKF structure passes `npm run docs:okf`.
- Required community and maintenance docs pass `npm run docs:coverage`.
- Code/tooling changes include a nearby docs change and pass `npm run docs:freshness`.
