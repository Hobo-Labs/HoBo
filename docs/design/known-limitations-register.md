---
type: Reference
title: "Known Limitations Register"
description: "Source issue: HOBO-485."
tags: [hobo, design]
---

# Known Limitations Register

This register is the customer-facing source for v1 limitations, scope-out
claims, beta caveats, simulated/reference proof, unsupported states, and
post-GA follow-up routing.

It feeds the release notes, support scripts, docs portal, and launch messaging
claim register. A limitation is publishable only when the customer-visible
wording, owner, workaround, state, handoff routes, and review checkpoint are
present.

## Register Fields

| Field | Required meaning |
|---|---|
| Limitation | Stable id and customer-safe summary of the limitation or scope-out item |
| Affected persona | Buyer, admin, operator, developer, support, or release owner impacted by the limitation |
| User-visible impact | What a customer may see or not be able to do |
| Workaround | Supported action, supported path, or explicit "no workaround yet" statement |
| Owner | Accountable HoBo project or subsystem owner |
| Follow-up issue | Required when the limitation needs product, docs, support, or launch work after M0 |
| Release-note section | Where final release notes must surface the limitation |
| Support-script route | How support explains or escalates the limitation |
| Docs route | Docs location that must carry the customer-facing note |
| Launch-messaging disposition | Whether launch copy may say implemented, beta-only, simulated/reference, unsupported, or deferred |

## Initial V1 Entries

| Limitation | State | Affected persona | User-visible impact | Workaround | Owner | Follow-up | Handoffs |
|---|---|---|---|---|---|---|---|
| Supported paths are evidence-backed only | `real` | Customer admin choosing a launch path | Release notes can name supported SaaS, self-host, or local paths only when evidence exists | Choose an evidence-backed launch path or treat the request as a limitation | V1 Release Program & Cutline | None | Release notes, docs portal, launch messaging |
| Reference proof is not live hosted behavior | `simulated-reference` | Buyer evaluating launch claims | Customer-facing copy must label reference proof separately from production hosted evidence | Use proof-mode labels and link the accepted contract or demo fixture before publication | V1 Launch Site, Messaging & Demo Assets | HOBO-458 | Release notes, docs portal, launch messaging |
| Dogfood/private-beta operations evidence is not GA operational proof | `beta-only` | Private-beta customer admin | Beta users may see operational caveats and support routing before GA evidence exists | Publish beta-only wording with support route, accepted risk, and review gate | V1 Dogfood Yard & Hosted Operations | HOBO-455 | Release notes, support scripts, launch messaging |
| Unsupported install environments stay outside supported v1 bootstrap claims | `unsupported` | Self-host operator | Operators outside the smoke matrix receive limitation text instead of support promises | Use supported SaaS, self-host, or local paths with accepted smoke evidence | Bootstrap Installer | HOBO-501 | Release notes, docs portal, support scripts |
| Rollback drills are not production recovery guarantees | `post-ga` | Release owner and support operator | Rollback guidance distinguishes drill evidence from unsupported production recovery promises | Link drill evidence and state unsupported rollback paths explicitly | Backup & Restore | HOBO-498 | Release notes, support scripts |
| Full migration automation is partial: expand/backfill/contract and pooled→siloed executors exist behind SQLite ports; managed-Postgres and Debezium-class CDC bindings remain deferred | `partial` | Workspace administrator planning a migration | Migration notes can describe the delivered executor evidence (M1-M4 in upgrade-migration-engine.md) plus the remaining provider-binding caveats | Use the dry-run contract and delivered executor lanes; provider bindings beyond SQLite route to Data Plane | Upgrade & Migration | HOBO-430 | Release notes, docs portal, support scripts |
| Live support automation is out of scope for M0 docs | `unsupported` | Support lead | Support copy can describe channels and escalation coverage, not live support automation | Use support SLA/channel records and manual support scripts until tooling evidence lands | Support Workflow | HOBO-448 | Release notes, docs portal, support scripts, launch messaging |
| Marketplace publisher payouts and revenue share are not v1 capabilities | `deferred` | Publisher owner and marketplace operator | Listings may surface payout-readiness states, but no payout execution, settlement, tax documents, or revenue share is promised in v1 | None; payout commitments route to the Capability Review & Approval owner | Marketplace Payout Hooks | HOBO-420 | Release notes, docs portal, support scripts, launch messaging |
| Crew and MCP write actions are policy-gated, not fully unsupervised | `real` | Platform operator and external MCP agent integrator | Launch and docs copy must not promise unattended Crew or MCP mutations; read and diagnose runs autonomously but remediation, deploy, and other writes require approval or policy gates | Route write-action expectations through dashboard or Slack approval flows and scoped MCP grants documented for the Crew roster ([operators-sre.md](./operators-sre.md#plan-40), [ai-native-agent-auth.md](./ai-native-agent-auth.md#plan-06)) | Operator Agents & SRE | None | Release notes, docs portal, support scripts, launch messaging |
| Default deploy uses an in-memory Pulumi stand-in, not live cloud apply | `real` | Developer, operator, buyer evaluating deploy claims | `hobo up` / `plan` / `down` succeed offline against synthetic estate state; no provider resources are created unless a live lane is opted in | Use credential-gated live lanes (`HOBO_PULUMI_LIVE=1`, Cloudflare/Vercel tokens) when real apply is required; never claim default path as multi-cloud production deploy ([packages/hobo/README.md](../../packages/hobo/README.md), [compose HONEST SCOPE](../../packages/hobo/src/compose.ts)) | Composition root / IaC | HOBO-715; [0011 E2](../plans/0011-ship-readiness-gap-review.md) | Release notes, docs portal, launch messaging, support scripts |
| `@hobo/componentize` defaults to synthetic wasm contract bytes; the real jco lane is opt-in | `partial` | Developer packaging WASM components; buyer of portable-membrane claims | The offline default (`buildWasmContractBytes`) stays synthetic for digest/contract tests; `HOBO_COMPONENTIZE_REAL=1` drives the real jco/`componentize-js` pipeline (toolchain-gated, fail-closed, no silent fallback), producing genuine component-model binaries whose bytes are not byte-stable across runs (Wizer snapshot, ADR-0105) | Use the synthetic lane for offline digests; use the real lane for deployable membranes when the toolchain is present (clears residual H-E3b; [packages/componentize/README.md](../../packages/componentize/README.md)) | Componentize / portable membrane | H-E3b closed by 0017 D13; [0011 E3](../plans/0011-ship-readiness-gap-review.md) | Release notes, docs portal, launch messaging |
| `hobo login` defaults to fixture/local session material | `beta-only` | Developer, agent integrator, security reviewer | Login succeeds without production OIDC browser flow or SPIRE Workload API; SVIDs/session files under `HOBO_HOME` are local fixtures | Use fixture login for offline/dev only; do not claim production SSO/OIDC/SPIRE until those paths are default and evidenced ([packages/hobo/src/login-command.ts](../../packages/hobo/src/login-command.ts) HONEST SCOPE) | Identity | [0011 E6](../plans/0011-ship-readiness-gap-review.md); residual H-E6 | Release notes, docs portal, support scripts, launch messaging |
| `@hobo/*` packages are not published to npm (pre-release) | `real` | External developer expecting `npm install` / `npx hobo` | No registry package install path; workspace versions remain `0.0.1` inside the monorepo | Clone/build from source via pnpm workspace until publish allowlist + CI-proven release land ([0011 E1](../plans/0011-ship-readiness-gap-review.md); Target B in [launch-ship-targets.md](./launch-ship-targets.md) / [ADR-0140](./adr/07-portability-extensibility.md#adr-0140)) | Release / distribution | H-E1b; 0012 WP-D | Release notes, docs portal, support scripts, launch messaging |
| GitHub Actions runner assignment may be unavailable (CI not a release oracle) | `real` | Release owner, contributor relying on green CI | Workflow runs can fail immediately with no runner assigned; last successful scheduled main fabric may lag | Prefer local `pnpm agent:check` / documented gates; do not claim CI-green ship until runners are restored and a real run is recorded (human blocker H-V1; [0011 V1](../plans/0011-ship-readiness-gap-review.md)) | CI / Release Program | H-V1 | Release notes, support scripts, launch messaging |

## Handoff Targets

| Target | Consumes | Required evidence |
|---|---|---|
| Release notes | State, impact, workaround, owner, release-note section | Customer-visible wording, owner, review checkpoint |
| Support scripts | Support route, workaround, owner, follow-up issue | Support route, unsupported request class, escalation owner |
| Docs portal | Docs route, state, release-note section | Docs route, freshness owner, known-limitation metadata |
| Launch messaging | Disposition, state, owner, follow-up issue | Claim state, proof mode, approved limitation wording |

## Scope-Out Marketing Guard

A scope-out, unsupported, deferred, beta-only, or simulated/reference item may
appear only as a known limitation, beta caveat, simulated/reference note,
unsupported item, deferred item, or follow-up. It cannot be marketed as a
supported v1 capability.

Launch claims that mention live hosted dashboards, all-provider support,
automated support desks, production recovery guarantees, unsupported
environments, or fully unsupervised Crew/MCP write autonomy must route through
this register before publication.

## Review Checkpoints

| Gate | Owner | Blocks publication when stale |
|---|---|---|
| Beta | V1 Release Program & Cutline | Yes. Every limitation needs owner, customer-visible text, state, support route, and follow-up issue when needed. |
| GA | V1 Release Program & Cutline | Yes. Every limitation needs owner, customer-visible text, state, reviewed-at evidence, and GA disposition. |

## Proof

Executable proof lives in
[`../../src/draft/exp-proofs/cx/known-limitations-register-contract`](../../src/draft/exp-proofs/cx/known-limitations-register-contract/README.md).
The proof includes protobuf data shapes, CUE constraints, a PACT boundary, and
tests for required fields, handoff mapping, scope-out claim rejection, beta/GA
review checkpoints, and customer-safe release-note projection.
