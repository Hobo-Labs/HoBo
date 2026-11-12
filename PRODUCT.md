# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Co-primary, by explicit owner decision: human developers and AI coding agents.**
Neither subordinates the other, and neither may be designed away.

- **Developers** evaluating or adopting HoBo — typically someone who has already
  hit the choice between a closed PaaS (easy deploys, lock-in) and raw
  cloud/IaC (full control, every app team becomes a platform team), and is
  looking for a third option. They arrive to judge whether the portability
  claim is real.
- **AI coding agents** operating HoBo directly — via the `hobo` control-plane
  CLI, MCP surfaces, and the agent briefing at
  `site/public/llms.txt` / `/llms-full.txt`. Agents are consumers of the product
  *and* of the site.

The dual audience is a durable constraint, not a phase: every surface must work
for both. In practice that means information architecture legible to a machine
and a human at once — structure that survives being read as markdown by an
agent and as a page by a person.

## Product Purpose

HoBo is a **design-first meta-cloud** for deploying one application shape onto
many real infrastructure shapes. A developer or agent describes an app once,
then places it on a provider, a mix of providers, or a self-hosted yard without
rewriting app code.

The goal is **cloud portability without hiding the cloud**: start from
provider-agnostic application intent, let HoBo reconcile infrastructure from
policy, cost, compliance and reliability goals, and drop down to typed
provider-specific options when optimisation matters — with humans and agents on
the same authenticated, auditable control surface.

## Positioning

The mechanism a neighbouring product could not truthfully copy: **WIT/WASM
Component Model interfaces as the portable membrane**, provider adapters as the
integration boundary, and an **event-sourced control plane** as the operating
model. Portability is a typed contract at the component boundary rather than a
lowest-common-denominator abstraction that hides the provider.

## Operating Context

- One CLI: `hobo` (control plane, canonical verb set in
  `packages/cli/src/shell/verbs.ts`), with `hobo-mcp` exposing the same verbs
  as MCP tools.
- The website is landing page + developer docs + agent docs, built from `site/`
  and published to the `gh-pages` branch — deliberately **no GitHub Actions
  dependency** for gates or publish (`pnpm run site:deploy`). Checkin gates
  run only through agent hooks / githooks (`pnpm agent:check`); agents must
  not wait on, cancel, or re-request Action runners.
- A control-plane UI (`@hobo/control-yard`).
- Design suite, ADRs and traceability under `docs/design/`; proofs under
  `src/draft/`; gates run through `pnpm agent:check`.

## Capabilities and Constraints

- Active design + executable contract/proof repository with a production
  `packages/` workspace (127 package manifests).
- The canonical `hobo` verb set dispatches against the local lane.
- Live Vercel/Cloudflare paths and `HOBO_PULUMI_LIVE=1` are credential- or
  engine-gated, not default.
- Ship targets A (OSS public) → B (local-first developer tooling) → C (hosted
  beta/GA); public claims must name their target.

## Brand Commitments

- **The identity is `HoBo Rubberhose`, and it is binding.** Steamboat Willie /
  Cuphead / Fleischer-style rubberhose cartoon: thick ink outlines, hard sticker
  shadows, film grain, black-and-white day/night inversion, title-card
  lettering — **never flat SaaS chrome**. The authority is
  [`site/DESIGN.md`](site/DESIGN.md), mirrored to
  `packages/control-yard/DESIGN.md`.
- **Bo is the character.** `bo-idle`, `bo-walk`, `bo-walk-left` in
  `site/public/parallax/`, plus five generated action sheets in
  `site/public/bo-actions/` (site-only, geometry in `sheets.json`).
- This identity was once replaced and then restored by owner decision
  ([ADR-0149](docs/design/adr/07-portability-extensibility.md#adr-0149)). The
  governing rule from that reversal: **an implementation problem is never
  grounds to replace a product identity**, and art is authored as art and
  vendored as assets — never assembled from `rect`/`line` primitives in a
  renderer. `pnpm run design:lint` validates the active DESIGN.md files.

## Evidence on Hand

Real: the running CLIs, the built site (139 pages), executable PACT contracts,
cucumber behaviour suites, ADR + traceability records, and the Bo artwork above.

**Known stand-ins that must not be claimed as shipped** — recorded here because
the owner made honest scope binding, and future work must not fabricate these
away:

- Default deploy uses an **in-memory Pulumi stand-in** (`HONEST SCOPE` in
  `packages/hobo/src/compose.ts`).
- `@hobo/componentize` has **two lanes**: the offline default emits synthetic
  wasm contract bytes (`buildWasmContractBytes`) for digest/boundary proofs, and
  `HOBO_COMPONENTIZE_REAL=1` drives the real jco/`componentize-js` pipeline
  (toolchain-gated, fail-closed — never a silent synthetic fallback). The
  synthetic default is the stand-in; the real lane is not.
- Packages are **pre-release and not published to npm**.

No testimonials, customers, benchmarks, pricing, or deployment claims exist.
Future work must not invent them.

## Product Principles

1. **No surface may claim capability the build does not have.** Pre-release
   status, stand-ins and credential-gated paths are stated, not implied away.
2. **Both audiences, always.** A surface that works for a human but is opaque to
   an agent — or vice versa — is unfinished.
3. **Portability without concealment.** Never present the provider as hidden;
   the escape hatch to typed provider-specific options is a feature to show,
   not an embarrassment to bury.
4. **The identity is not a variable.** Rubberhose is owner-set. Implementation
   difficulty is a reason to produce better art, not to change the identity.
5. **Evidence over assertion.** Claims are backed by something executable —
   a gate, a contract, a test, a recording — or they are marked as open.

## Accessibility & Inclusion

No product-specific standard has been established beyond what the design system
already requires: the identity mandates strict black-and-white with rare accent
colour, so contrast is inherently high, and reduced-motion parity is an existing
requirement on animated surfaces. Treat as undecided rather than assuming a
formal WCAG target.
