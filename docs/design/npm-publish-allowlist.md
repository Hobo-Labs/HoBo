---
type: Reference
title: "npm publish allowlist (Target B prep)"
description: "First-publish allowlist, prerelease policy, dual-bin product CLI, and manual-only publish workflow constraints. No live npm publish until NPM_TOKEN + green CI."
tags: [hobo, design, npm, publish, ship]
---

# npm publish allowlist

Ship-remediation WP-D ([`docs/plans/0012-ship-remediation-plan.md`](../plans/0012-ship-remediation-plan.md)). Prepares Target B (developer-tooling / local-first npm) **without** performing a live registry publish.

## Policy summary

| Rule | Requirement |
|---|---|
| Trigger | **Manual only** — [`.github/workflows/publish.yml`](../../.github/workflows/publish.yml) is `workflow_dispatch` only. **Never** on `pull_request`. |
| CI gate | Real publish requires **green** main CI (including artifact-trust when that job is restored). Until runners/secrets are healthy, the workflow dry-runs only. |
| Secret | Optional **`NPM_TOKEN`** on the protected **`release`** environment. Empty → OIDC trusted publishing on GitHub-hosted **`release-npm`**; non-empty → **`NODE_AUTH_TOKEN`** + **`hobodev`** check. Do not commit tokens. |
| Prerelease versions | First public line is **`0.1.0-alpha.<n>`** (semver prerelease). Do not jump to `1.0.0` without a separate go/no-go. Workspace packages may still carry `0.0.1` until the first publish bump. |
| Allowlist freeze | Only packages listed below may leave `private: false` *and* be published. Immature packages stay `"private": true`. |
| Dual bin | Product CLI binary is **`@hobo/hobo`** (`bin.hobo` + `bin.hobo-mcp`). **`@hobo/cli` is library-only** (no `bin`) to avoid npm bin name collisions. |

## First-publish allowlist

These packages may be published (not forced private). Names are exact npm package ids:

| Package | Role |
|---|---|
| `@hobo/core` | Core domain types, ports, EventStore contracts |
| `@hobo/bindles` | Bindle authoring / closure builder |
| `@hobo/contracts` | Contract IR, Gatekeeper, EffectSpec |
| `@hobo/contract-harness` | Contract test harness helpers |
| `@hobo/runtime` | Runtime SDK surface |
| `@hobo/runtime-local` | Local Node runtime / SQLite journal host |
| `@hobo/storage-sqlite` | SQLite storage adapter behind ports |
| `@hobo/wit` | WIT / component contract surfaces |
| `@hobo/cli` | CLI **library** (shell factories, verb registry; **no** `bin`) |
| `@hobo/hobo` | Composition-root **product** binary (`hobo`, `hobo-mcp`) |
| `@hobo/mcp` | MCP server library / composition helpers |
| `@hobo/conformance` | Conformance corpus and runners |
| `@hobo/identity` | Identity / secretless config resolution |
| `@hobo/policy` | Policy plane types and evaluators |
| `@hobo/connectivity` | Named endpoints, connectors, overlay |
| `@hobo/events` | Event families / envelope helpers |
| `@hobo/data` | Data-plane helpers |
| `@hobo/stations` | Station occupancy control plane |
| `@hobo/trails` | Continuous migration recipes |
| `@hobo/replay` | Session replay kit surface |
| `@hobo/adapter-hono` | Hono L2 HTTP adapter |

## Forced private (not first-publish)

Immature, thin, internal, stub, or synthetic packages remain `"private": true` so `npm publish` cannot succeed without an intentional manifest edit:

| Package / group | Reason |
|---|---|
| `@hobo/camps`, `@hobo/yards`, `@hobo/junctions` | Topology packages still thin / multi-cloud deferred |
| `@hobo/stage-gate` | Internal CI/stage tooling |
| `@hobo/componentize` | Synthetic wasm contract bytes until real jco pipeline |
| `@hobo/runtime-cloud-native` | Stub / incomplete multi-cloud host |
| `@hobo/runtime-oci`, `@hobo/runtime-dapr` | Optional/immature camp runtimes |
| `@hobo/schema-tools`, `@hobo/ci-guard` | Internal repo tooling |
| `@hobo/broker`, `@hobo/cloud` | Control-plane work-in-progress |
| `@hobo/training-pipeline` | Internal training harness |
| `@hobo/iac-pulumi`, `@hobo/iac-crossplane`, `@hobo/iac-terraform` | Live-default IaC policy not decided; in-memory defaults |
| `packages/providers/*`, `packages/connectors/*` | Already private provider/connector adapters |

**Kept public but not on the first-publish allowlist** (may publish only after an explicit allowlist extension):

- `@hobo/runtime-browser` — substantial browser/OPFS surface; hold until browser install path is productized
- `@hobo/runtime-wasm` — wasm host; hold until componentize honesty + host maturity
- HoBo.CD ([ADR-0180](./adr/01-architecture-core.md#adr-0180), [continuous-delivery.md](./continuous-delivery.md)) — `@hobo/cd`, `@hobo/cd-gitops`, `@hobo/cd-kube-fleet`, `@hobo/resolver-components`, `@hobo/storage-postgres`. Their manifests carry `publishConfig.access: public` so a later allowlist extension is a one-line change, but none is on the first-publish allowlist: hold until the CD live lanes (Vercel, Cloudflare, Prometheus-backed verification, `kind` for `@hobo/cd-kube-fleet`) have run green with credentials, and, for `@hobo/resolver-components`, until componentize emits real component bytes
- HoBo.CD realizers `@hobo/provider-npm`, `@hobo/provider-oci-registry` and `@hobo/provider-github` — held like the other CD packages and not on the first-publish allowlist; today they are `"private": true` with the rest of `packages/providers/*` and reach users only through `@hobo/hobo`'s hosting catalog. Hold until their credential-gated live lanes ([live-provider-matrix](./live-provider-matrix.md)) have run green

## Dual-bin resolution

| Package | `bin` | Notes |
|---|---|---|
| `@hobo/hobo` | `hobo`, `hobo-mcp` | **Only** product install path for the composed CLI |
| `@hobo/cli` | *(none)* | Library exports only; local debug: `node packages/cli/dist/bin/hobo.js` |

Do not re-add `bin.hobo` to `@hobo/cli` without removing it from `@hobo/hobo` or renaming one side.

## Workflow contract

File: [`.github/workflows/publish.yml`](../../.github/workflows/publish.yml).

1. `on: workflow_dispatch` only (no PR / push auto-publish).
2. Documents required secret `NPM_TOKEN`.
3. Fails closed if `NPM_TOKEN` is missing when a real publish job is enabled.
4. **Today:** fail-closed **dry-run** that prints allowlisted package names that would publish; does **not** call `npm publish`.
5. Future real publish **must** `needs: artifact-trust` (or equivalent) once CI runner assignment is restored — see `hobo-ci.yml` comment on future Changesets automation.
6. Human residual **H-E1b**: first real npm publish needs account token + green CI (agent cannot close).

## Related

- Ship remediation plan: [`docs/plans/0012-ship-remediation-plan.md`](../plans/0012-ship-remediation-plan.md) (WP-D)
- Gap review: [`docs/plans/0011-ship-readiness-gap-review.md`](../plans/0011-ship-readiness-gap-review.md)
- Residual human blockers: [`instances/residual-human-blockers-2026-07-30.md`](./instances/residual-human-blockers-2026-07-30.md) (H-E1b)
- Package namespaces: [`package-namespaces.md`](./package-namespaces.md)
