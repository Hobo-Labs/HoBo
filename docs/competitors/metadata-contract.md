---
type: Competitive Reference
title: "Competitor metadata contract"
description: "Normative front-matter schema, canonical path rules, and category vocabulary for docs/competitors/."
tags: [hobo, competitors, contract]
---

# Competitor metadata contract

> Normative. Every canonical competitor capture under `docs/competitors/` **must** satisfy this contract.
> It is machine-checked by `pnpm run docs:competitors` (`scripts/check-competitor-docs.ts`), which the
> repo docs linter runs for any changed file under `docs/competitors/`.

This contract exists so that competitor research can be written **once**, in one canonical document per
product, while category pages, the cross-category matrix, and the freshness ledger are **derived views**
that never duplicate the research. It is the stable base the rest of the corpus builds on: category
indexes ([`categories/`](categories/index.md)), the [matrix](matrix.md), and the
[gap analysis](gap-analysis.md).

The research obligations themselves — the twelve required sections, evidence rules, and the standard
capability matrix — come from the **HoBo Competitive Research Contract** (Linear project document).
This file governs only *identity, placement, and metadata*.

## Canonical path rules

| Rule                     | Value                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| Canonical capture path   | `docs/competitors/<slug>.md`                                                                       |
| Category index path      | `docs/competitors/categories/<category>.md`                                                        |
| Derived views            | `docs/competitors/matrix.md`, `index.md`, and `categories/index.md` carry generated blocks — do not hand-edit inside the markers |
| Slug charset             | `^[a-z0-9]+(-[a-z0-9]+)*$`                                                                         |
| Slug ↔ filename          | The `competitor.slug` value **must** equal the file's basename                                     |
| One doc per product      | Exactly one canonical file per product; a product may appear in many categories                    |
| Cohort captures          | A doc may cover a *cohort* (e.g. `anon-container-hosts`); it still needs one slug and one metadata block |

**Renames, acquisitions, and aliases.** A renamed or acquired product keeps **one** canonical file under
its *current* name and lists every prior name in `aliases`. Aliases are globally unique across the corpus:
no alias may collide with another competitor's slug or alias. Old paths are not left as stub files —
discoverability comes from the alias index in [`index.md`](index.md), which is generated from the same
front matter, so an alias is listed the moment it is declared.
Set `status` to `renamed`/`acquired`/`abandoned` and say so in the doc body; do **not** open a second file.

## Front-matter schema

Existing front-matter keys (`type`, `title`, `description`, `tags`) stay as they are. Canonical captures add
one `competitor:` block:

```yaml
---
type: Competitive Reference
title: "Nitric — Competitor Reference"
description: "Cloud-agnostic infrastructure-from-code framework."
tags: [hobo, competitors]
competitor:
  slug: nitric
  name: Nitric
  aliases: [nitrictech]
  primary_category: infrastructure-from-code
  categories: [infrastructure-from-code, portable-application-models]
  directness: overlapping
  role: authoring analog for typed resource declaration
  posture: [borrow, benchmark]
  hobo_surface: [authoring, provider-matching, runtime-portability]
  evidence: design-only
  status: active
  research_date: 2026-08-19
  sources:
    - https://nitric.io/docs
    - https://github.com/nitrictech/nitric
---
```

### Field reference

| Field              | Required | Type            | Rules                                                                                   |
| ------------------ | -------- | --------------- | --------------------------------------------------------------------------------------- |
| `slug`             | yes      | string          | Matches `^[a-z0-9]+(-[a-z0-9]+)*$` and the filename basename                              |
| `name`             | yes      | string          | Product name as its owner spells it today                                                 |
| `aliases`          | no       | string[]        | Prior/alternate names and old slugs; globally unique across the corpus                    |
| `primary_category` | yes      | category slug   | Must also appear in `categories`                                                          |
| `categories`       | yes      | category slug[] | ≥1, from the vocabulary below, no duplicates — this is the many-to-many membership        |
| `directness`       | yes      | enum            | `direct` · `overlapping` · `adjacent` · `complementary`                                   |
| `role`             | yes      | string          | One phrase: what this product *is* relative to HoBo                                       |
| `posture`          | yes      | enum[]          | ≥1 of `displace` · `integrate` · `adopt` · `provider-target` · `render-target` · `borrow` · `benchmark` · `standard` |
| `hobo_surface`     | yes      | surface slug[]  | ≥1 contested HoBo surface, from the vocabulary below                                      |
| `evidence`         | yes      | enum            | HoBo's *own* state on the contested surfaces: `implemented` · `proof` · `design-only` · `not-present` · `mixed` |
| `status`           | yes      | enum            | Competitor's state: `active` · `renamed` · `acquired` · `abandoned` · `archived`          |
| `research_date`    | yes      | `YYYY-MM-DD`    | The date the capture's claims were last verified against sources; not in the future       |
| `sources`          | yes      | url[]           | ≥1 `https://` primary source (official docs, repo, spec, release notes)                   |

`evidence` is deliberately about **HoBo**, not the competitor: it is the honesty control the research
contract demands, so a category row can never imply parity that `packages/` does not have. Use `mixed`
when the listed surfaces differ, and say which is which in the doc body.

### Category vocabulary

Category slugs are closed. They mirror the Linear project milestones one-for-one.

| Category slug                   | Scope                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `platform-orchestrators`        | Comprehensive platform/application orchestration, environments, self-service        |
| `portable-application-models`   | Application-intent models, capability abstractions, portable control-plane APIs     |
| `cloud-application-platforms`   | Managed platforms owning app/environment lifecycle, previews, runtime ops, BYOC     |
| `developer-portals-idps`        | Catalogs, scaffolding, scorecards, self-service portals fronting a platform         |
| `infrastructure-from-code`      | Authoring frameworks that infer/provision infrastructure from application code      |
| `runtime-substrates`            | Runtimes, schedulers, component hosts, actor systems, service building blocks       |
| `hybrid-multicloud-enterprise`  | Enterprise hybrid/multicloud provisioning, governance, catalog, lifecycle           |
| `self-hosted-paas`              | Self-hosted PaaS and server/container deployment tools; DX benchmarks               |
| `agentic-infrastructure`        | AI-native infra modeling, autonomous remediation, agent tool surfaces               |
| `backend-data-platforms`        | BaaS/data platforms collapsing provisioning, functions, auth, storage, realtime     |
| `delivery-release-gitops`       | Delivery controllers, GitOps reconciliation, promotion, rollout, runbooks           |
| `finops-governance-placement`   | Cost visibility/estimation/optimization, policy, governance, placement              |
| `identity-networking-delivery`  | Identity-aware networking, secretless connectivity, ADC/gateway, mesh, auth brokers |

### Contested-surface vocabulary

`hobo_surface` values are closed, and align with the research contract's standard capability matrix:

`authoring` · `app-graph` · `typed-contracts` · `wiring` · `environments` · `provider-matching` ·
`runtime-portability` · `reconciliation` · `delivery` · `governance` · `identity-secrets` ·
`observability` · `finops` · `agent-surface` · `replay-migration` · `extensibility` · `ecosystem`

## Category index contract

Each `docs/competitors/categories/<category>.md` must:

1. state the category boundary and why HoBo competes in it;
2. link **every** competitor whose `categories` include it, by canonical path — and nothing else;
3. use the shared row schema: competitor · role · directness · contested HoBo surface · competitor
   advantage · HoBo distinction · recommended posture · research priority;
4. carry no full product research — that belongs only in the canonical capture.

Membership is derived from front matter, so a category page is never the place to *declare* membership:
add the category to the competitor's `categories` list and the checker will require the row.

## Validation

`pnpm run docs:competitors` fails on:

- missing/malformed `competitor:` block, unknown enum values, slug/filename mismatch;
- a missing `categories/<slug>.md` page (the vocabulary is closed: every category has a page), or an index row for a non-member;
- a category page linking a path that is not a canonical capture;
- duplicate slugs or aliases anywhere in the corpus;
- `research_date` missing, malformed, or in the future;
- a required research-contract section heading missing from a capture;
- unresolvable relative Markdown links from any file under `docs/competitors/`;
- drift in any generated block against the front-matter facts: the `matrix.md` matrix and ledger, the corpus `index.md` category/capture/alias tables, and the `categories/index.md` roster.

Regenerate derived views with `pnpm run docs:competitors:fix`.

Staleness is reported, not failed: `pnpm run docs:competitors` lists the captures older than 180 days
on the day it runs, so refresh work can be scheduled rather than blocking unrelated changes. The
[freshness ledger](matrix.md#freshness-ledger) in the committed matrix holds only the researched date
and the contract state, oldest first, because a file that printed today's age would be out of date
tomorrow and fail the drift check above.
