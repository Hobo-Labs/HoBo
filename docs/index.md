# HoBo documentation hub

This directory is the OKF bundle root for HoBo documentation. The root [`README.md`](../README.md) explains the project at a high level. Existing planning and design artifacts are being completed and removed under the repository rules.

## OKF bundle layout

This bundle follows Open Knowledge Format v0.1 conventions: `index.md` files provide directory listings, concept documents carry YAML frontmatter with a non-empty `type`, and repo knowledge that used to live in root-level reference folders now lives under this `docs/` tree. Run `npm run docs:okf` to validate those structural rules.

## Canonical docs

| Area | Start here | Purpose |
|---|---|---|
| Agent tooling | [`agent-tooling.md`](./agent-tooling.md) | Local agent-tooling setup, trust boundaries, data-egress notes, and maintenance expectations. |
| CI performance | [`ci/performance.md`](./ci/performance.md) | Where HoBo CI Fabric wall time goes on the self-hosted box, the fixes landed, and what is left for a five-minute run. |
| Automations | [`automations/hobo-issue-worker.md`](./automations/hobo-issue-worker.md) | How the issue worker implements and verifies owned work. |

## Reference directories outside `docs/`

| Directory | Purpose |
|---|---|
| [`../src/draft/`](../src/draft/README.md) | Executable proof/contract packages that make selected design claims testable. |
| [`competitors/`](./competitors/index.md) | Product and platform positioning references. |
| [`patterns/`](./patterns/index.md) | Architecture/operations patterns used by HoBo decisions. |
| [`runbooks/cd/`](./runbooks/cd/index.md) | HoBo.CD operator runbooks, assembled from each `@hobo/cd` module's Runbook section. |
| [`standards/`](./standards/index.md) | External standards referenced by design decisions. |
| [`technologies/`](./technologies/index.md) | Technology notes for adapters, engines, and possible implementation choices. |
| [`../workflows/`](../workflows/) | Loop-me workflow specs for recurring agent/human maintenance loops (`NOTES.md` holds shared vocabulary). |

## Maintenance checklist

When docs change, verify:

- Relative links and anchors pass `npm run docs:links`.
- CLI examples use canonical verbs and pass `npm run docs:cli-lint`.
- OKF structure passes `npm run docs:okf`.
- Required community and maintenance docs pass `npm run docs:coverage`.
