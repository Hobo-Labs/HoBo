---
type: Implementation Plan
title: "Remediation roadmap — scoped solutions for every remaining gap"
description: "Workstream-sliced solutions for everything remaining/missing/stubbed/inaccurate in the repo (2026-08-04 inventory): correctness fixes, the ADR-0146 residency loop, compliance surface, the flagship local/WASM lane, placement expressiveness, every ✱ aspirational package, and the register audits. Each item is an executable initiative contract with seam facts, reuse anchors, effort, and acceptance criteria."
tags: [hobo, plans, roadmap, remediation]
---

# Remediation roadmap — scoped solutions for every remaining gap

> **Source inventory:** the 2026-08-04 honesty audit (everything remaining,
> missing, stubbed, not implemented, or inaccurate). **Lane model** governing
> priorities: **WASM + local/self-host are first-class live lanes and must be
> fully real.** Third-party provider credentials are supplied by HoBo's *end
> users* who configured those providers — a 3P lane is **done** when its
> credential-gated fail-closed behavior and request formation are
> contract-proven (the existing `HONEST SCOPE` pattern). Effort classes:
> S (≤1 session slice) · M (1 session) · L (own initiative, multiple slices).
> Every item lists its seam facts so a later session can one-shot it without
> re-discovery.

## WS-A — Correctness quick wins (S–M; run first)

### A1 · `match.Decided` convergence (M)
**Problem.** Three emitters share the `match.Decided` event string with three
bodies. `@hobo/cloud`'s planner payload (`packages/cloud/src/plan-types.ts:51`)
lags the canonical proto (`src/draft/technical-proofs/control-plane-event-schema-contract`):
flat `rejected: string[]`, no `tie`, `catalogHash` naming. The dispatcher
(`packages/dispatcher/src/dispatcher.ts`) is already canonical.
**Solution.** Widen the cloud body only: structured
`rejectedCandidates {definitionId, reason}`, `ranking`, `tie`,
`catalogContentHash` (keep `catalogHash` as deprecated alias one release).
Tie info is computed and discarded inside `rankByObjective`
(`packages/cloud/src/planner/matching.ts:36`) — capture it there. Proto:
**add fields 12+** in `packages/cloud/data-models/cloud.proto`; never mutate
`repeated string rejected = 7` (wire-breaking). Widen the
`DeploymentDecisionRow` fold (`packages/cloud/src/projections/deployment-view.ts:108`)
deliberately — the widened row leaks into CLI JSON via
`packages/hobo/src/inspect-command.ts:100` and `drift-command.ts:206`, so
snapshot those outputs. Update pinned tests (`packages/cloud/test/planner.test.ts:66-80`,
`gateway.test.ts:87`). Follow-up flag (separate slice): rename identity's
audit reuse of the literal (`packages/identity/src/migration-control-plane.ts:42`)
to `identity.MatchDecidedAudit` and catalog it.
**Acceptance.** Cloud + dispatcher payloads structurally identical; existing
goldens updated intentionally (not silently); event-families row untouched.

### A2 · ADR-0135 numbering collision (S)
**Problem.** `docs/design/adr/07-portability-extensibility.md:522` carries a
second `## ADR-0135` ("HoBo Yard: game-first control-plane UI") while the
index maps 0135 to the SQLite ADR (its own standalone file).
**Solution.** Renumber the game section to **ADR-0149**; add index +
traceability rows; grep-fix inbound `#adr-0135` links that meant the game
section; leave a one-line tombstone note at the old location.
**Acceptance.** `lint:docs` ADR-reference gate green; exactly one ADR-0135.

### A3 · OKF frontmatter warners (S) — obsolete
Add frontmatter to `docs/plans/hobo-code-optimizexp-surfaces/sdlc-state.md`
and `docs/plans/hobo-code-tui-optimizexp-finish/sdlc-state.md` (the two
`check-okf-docs` warners).

**Obsolete (2026-11-08):** both files left `main` with hobo-code; they live
on the `feature/hobo-code` branch.

### A4 · gap-analysis §6 re-score (M)
**Problem.** §6 re-scores 14 captures; the corpus is 35.
**Solution.** Mechanical, shape pinned: extend the §6.1 five-column table
(`| Competitor | Category | What it leads on | HoBo's answer (status) | Net |`,
7-symbol legend) with the 21 uncovered captures; keep §6.2's three prose
groups in sync; refresh the dated headers (§6 title, §6.6); rebalance §6.3
residual hooks against WS-G's Iteration-5 findings. Run **after** WS-G/35 so
the scores cite the fresh register.
**Acceptance.** 35 rows; every row links its capture; lineage.md's staleness
note removed.

## WS-B — Complete the ADR-0146 residency loop (M)

> Seam verdict: **pure wiring** — the evaluator, pack, and gate value all
> exist; nothing calls them.

### B5 · Gatekeeper residency wiring (S)
`gate: "residency"` is a legal `MachineReadableReason.gate` member that
nothing emits. Two production `evaluateGatekeeper` call sites:
`packages/broker/src/planes.ts:81` (its `gate→plane` ternary silently maps a
residency reason to `plane: "policy"` — extend it) and
`packages/hobo/src/verify-command.ts:81` (thread `Tenant.residency` + plan
region into the request context; pass the residency pack —
`packages/policy/src/residency-policy-pack.ts` exists and is never passed).
**Acceptance.** A pii-classified plan into a disallowed region produces a
`gate:"residency"` reason from `hobo verify` and a `plane` distinct from
policy in broker rejections.

### B6 · Broker residency population + consumer (M)
`YardShape.residency` is parsed from input (`yard-placement/types.ts:377`)
but two construction sites hardcode `[]`
(`inventory.ts:167` — add a `residency` option to `YardInstanceRegistration`;
`event-store-resolvers.ts:281` — read `p.residency` like it reads
`p.regions`). **The field is never consumed** — add the missing filter in
yard-placement matching beside the capability checks, modeled on
`packages/broker/src/broker.ts:474` `pickRegion`, but keyed
classification×jurisdiction through `evaluateResidency` (`@hobo/core`).
Note the axes differ: `allowedRegions` lives on the placement *policy*,
residency on the yard *shape* — this is a new check, not a rename.
**Acceptance.** A yard registered with `residency: ["eu"]` is filtered out
for a `pii` workload whose tenant constraint disallows `eu`… and vice-versa;
rejection carries `evaluateResidency`'s remediation string.

### B7 · Typed `context.dataClassifications` (S)
`packages/policy/src/policy-ir.ts` request context is untyped JSON. Add an
optional typed `dataClassifications?: DataClassification[]` field (import
type from `@hobo/core` — or mirror structurally to keep policy
dependency-free, matching the residency-pack precedent) + CUE constraint.

### B8 · Junction replication residency (S)
`packages/junctions/src/connectivity.ts` tier inference has no residency
check despite ADR-0103's "fails closed on illegal residency". Add: when
either yard manifest carries `residency`, evaluate the cross-yard edge with
`evaluateResidency`; conflict ⇒ refuse the tier (fail closed), reason
`residency-conflict`.

### B9 · Transfer-mechanism edges v2 (M)
Extend `packages/core/data-models/jurisdiction.proto` with
`TransferBasisRecord {from, to, basis: adequacy|scc|none, citation}` seed
data (EU adequacy list, UK/CH/JP/etc.); `evaluateResidency` gains an optional
`transferBasis` output consumed as PortabilityReport evidence. Non-goal:
legal advice — citations stay informational (ADR-0144 posture).

## WS-C — Compliance surface (M)

### C10 · OCSF widening + signing (M)
`packages/hobo/src/ocsf-export.ts` exists (Authorization class over
credential audit; `hobo attest`). Scope: add **Authentication** and
**Configuration/Change** class mappings over `policy.Decided`,
`data.Classified`, `erasure.*`, `flag.Changed`, `registry.BundleImported`
(the ADR-0046 §2 list); **sign the batch** — the `sealDigest` comment says
signing is a follow-up, and `JwtSvidIssuer` + `KmsLike`
(`packages/identity/src/issuer.ts`) make it cheap. Preserve the one-way PII
boundary (redact/crypto-shred; erasure tombstones never cross).
**Acceptance.** `hobo attest` emits a multi-class, JWS-signed OCSF batch;
per-line traceability to source events; crypto-shredded subjects redacted.

### C11 · OSCAL-JSON emitter (S)
Boundary artifact over `ControlEvidencePack`
(`packages/policy/src/control-evidence-pack.ts`): emit OSCAL-shaped
component-definition + assessment-evidence JSON (own types, zero OSCAL
schema dependency — `docs/standards/oscal.md` posture).

### C12 · SOC2 + GDPR seed packs (S)
Two more honest packs beside `NIST_800_53_SEED_PACK`, mapping only to real
evidence refs; GDPR pack leans on crypto-shred (ADR-0051), residency gate
(ADR-0146), classification events; statuses honest (`planned` where OCSF
export or erasure automation is still design).

## WS-D — Flagship local/WASM lane made fully real (L; elevated by the lane model)

### D13 · Real componentize (L)
**Seam (verified).** The build injects a `ComponentizeFn`
(`packages/cli/src/build/componentize-adapter.ts`;
`run-build.ts:60` accepts `request.componentize`, defaults to
`defaultComponentize`) — so a real jco builder is a **second implementation,
no `@hobo/componentize` rewrite**. jco/componentize-js are already workspace
deps (runtime-wasm, hobo, wit); versions pinned in `PINNED_TOOLCHAIN`.
**Hidden costs (verified):** `validateWasmComponentArtifact` and
`runWasmtimeSmoke` assert the synthetic metadata schema — a real component
*fails* them; fork both (real path: `wasm-tools validate` + genuine wasmtime
run). `buildOciDescriptor` (`componentize.ts:248`) is dead code — export it
and add the descriptor to `ComponentizeOutput` so OCI artifacts reach
`runtime-oci` (`oci-pack.ts` pins the same media type).
**Gating.** Toolchain-present ⇒ real path; absent ⇒ synthetic floor (same
pattern as wasmtime gating). Clears residual **H-E3b**; refresh
known-limitations + trail map on landing.
**Acceptance.** hello-bindle builds a *real* component that passes
`wasm-tools validate`, runs under wasmtime with true stdout, and round-trips
as an OCI artifact; determinism spike assertions
(`src/draft/technical-proofs/componentize-js-determinism-spike`) promoted to
the real path.

### D14 · Scheduler port (M)
WIT bindings already exist (`packages/wit/src/generated/scheduler-{guest,provider}`,
in the `sdk` world). Scope: core port descriptor delegating to
`packages/runtimes/runtime-local/src/clock.ts` cron. **Recorded decision:**
v1 stays `IntervalCronSpec` (interval-only; there is NO cron-expression
parser anywhere — adding one is a separate, flagged cost). `b.schedule()`
builder method (see D15); lowers to `data.v1 + port:"hobo:scheduler"` —
**no manifest IR change needed** (RESOURCE_TYPES are coarse shapes; the
`port` field carries the kind — verified against how `kv`/`queue` lower).

### D15 · BindleBuilder completion (S)
**11 missing builder methods, not missing kinds** — CATALOG_ROWS,
AllowVerbsByKind, and `catalog.ts` handle factories already cover all 23
kinds. Add `schedule, websocket, job, flag, auth, crypto, notify, guardrail,
ui, golden, experiment, rollout` to `BindleBuilder`
(`packages/bindles/src/types.ts:272`) + `createBuilder`
(`packages/bindles/src/bindle.ts:128`), following the `external`/`container`
options pattern where needed.

### D16 · runtime-cloud-native: one real provider (M)
Interface is two methods (`ensure`/`servePrivate`,
`packages/runtimes/runtime-cloud-native/src/host.ts`). Implement **one real
entry (cloudflare)** reusing `packages/hobo/src/cloudflare-client.ts` request
formation, to prove the `PrivateServeResult` in-process `FetchHandler`
contract against a remote provider (the hard seam — document it). Other ids
stay declared-unimplemented with the existing fail-closed
`HOBO_CLOUD_NATIVE_UNIMPLEMENTED`. Registry note: `servePrivate` routes only
to the single `defaultProvider` — per-resource routing is an explicit
non-goal here (design hook).

### D17 · Login real grant flow (M)
**Only the grant is missing** (no `device_code` anywhere): issuance, OIDC
discovery + JWKS, verification, attestation, and the token broker all exist
in `packages/identity` (`issuer.ts` `JwtSvidIssuer`, `identity-service.ts`,
`attestation.ts`, `token-broker.ts`). Implement OAuth **device-code flow**
against a configurable issuer; when configured, `hobo login` mints a real
JWT SVID via `IdentityService.issueSvid` instead of
`createFixtureSession` (`packages/cli/src/cloud/session.ts:23`); fixture
stays the offline default (local lane is first-class). Node/workload
attestation remains the fixture attestor with the SPIRE-shaped seam
documented — full SPIRE integration is a later adapter, not a blocker.

### D18 · WebAuthn step-up for `claim` (design-only, S)
Ceremony behind a port (`WebAuthnCeremonyPort`: create/get with
challenge/attestation records); browser dependency; deferred with the
acceptance sketch recorded in the claim command's HONEST SCOPE comment.

## WS-E — Placement expressiveness + Radius deliverables (L; own initiatives; executable spec = `0015-radius-seam-hardening-instruction.md` §B)

### E19 · Placement-constraint vocabulary (L)
HoBo-native criteria records (proto/CUE in `packages/cloud/data-models/`):
property selectors (cost/capacity/region/latency/custom), affinity/
anti-affinity between resource classes, spread across regions/yards, `pickN`
cardinality — semantics cited from KubeFleet, shapes HoBo-native (no K8s
types in core, ADR non-goal). Scorer + ADR-0088 group extension; goldens in
`matching-specificity-vectors` extended; existing vectors byte-stable.
Closes GAP-003's 🔜 tracker rows honestly (nomad.md mapping upgraded).

### E20 · RealizationResult output contract (M)
`hobo.realization-result/v1` port (`packages/core/src/ports/driver.ts` per
Plan 25) — `values` / ref-only `secrets` (SecretRef discipline) /
`resources`; `fromIacOutputs({resources, stackOutputs, bindings})` +
`fromRecipeOutputs({values, secrets, resources})` helpers; conformance suite
(`packages/conformance/src/suites/driver-output.ts`) rejecting raw secret
values; the three IaC adapters typed against it (today:
`(program: unknown) => Promise<unknown>`).

### E21 · App-graph projection (M)
TopologyView-shaped read model beside
`packages/cloud/src/projections/deployment-view.ts` folding Bindle
resources/links (topology-objects contract), Camp↔Yard attachments,
Junctions, realized resources, `match.Decided` summaries; byte-stable golden;
surfaced as `hobo inspect graph` (MCP parity automatic via the derived tool
surface).

### E22 · Staged rollout strategies (L)
Extend identity's `RolloutStage/RolloutPolicy/RolloutState` +
`OpenDeliveryEngine` with ordered stages containing parallel groups,
`concurrency`, `maxFailures`, approval gates (compose policy
`require-approval` + Gatekeeper + A2H — never a second approval plane),
`resumeFrom`; every transition an EventEnvelope event; journal-replay test
reconstructs a resumed staged run; percent-ramps remain the degenerate case.

## WS-F — ✱ aspirational packages: full solution sketches

### F23 · `@hobo/sdk` — operator SDK (M)
ADR-0072 naming: `@hobo/sdk` = operator/self-host SDK (WIT contract stays
`hobo:sdk`). Thin authoring factories over existing engines:
`dispatcher()` wraps `@hobo/dispatcher`; `policyPack`/`rule` wrap the
`@hobo/policy` + `@hobo/contracts` shapes; `defineResource()` is a
greenfield factory producing the existing `ResourceDefinition`
(`packages/cloud/src/registry/catalog.ts:50`). Greenfield surfaces speced
against `docs/design/walkthrough.md` usage sites: `waiver` (L652), `chaos`
(L785), `runbook` (L737), `generateProvider` (L330/371), `runner` (L691).
Standard package anatomy (proto/CUE, PACT, guard evidence).

### F24 · `@hobo/registry` — catalog service (M)
**Most substance exists** in `packages/cloud/src/registry/catalog.ts`
(providers/definitions/held/approval facts, event-backed registry,
`registryCatalogProjection`). New package wraps it as a service and adds the
missing thirds: Capability-Manifest **ingest** (POC:
`docs/design/proofs/hobo-630-registry-capability-manifest-ingest`),
**signature/provenance verification** (reuse identity issuer/verify + the
SLSA shapes from stage-gate), and a **search/index API**. Serves
`hobo registry` and `hobo add` (whose mutating-admin follow-up note this
closes).

### F25 · `@hobo/evals` (M)
Rubric + promotion-gate engine (Plan 23): rubric records (proto/CUE),
scored-run evidence reusing the conformance report + golden vocabulary,
promotion verdicts feeding Gatekeeper as an `evals` dimension
(machine-readable reason gate value added alongside). Non-goal: model
hosting — evaluators are ports.

### F26 · `@hobo/training` (M)
The port already exists (`packages/core/src/ports/training-engine.ts`,
ADR-0025/0048). Package = built-in OPTO-style optimizer + OpenInference
trace capture behind the port, internal-only (never on the app SDK
surface); Microsoft Trace / Agent Lightning as optional providers
(technologies captures already analyze both). Reuses
`packages/training-pipeline` trace-context work.

### F27 · `@hobo/agent-skills` (S)
Package the mirrored `.agents/skills` tree as a distributable module: skills
manifest (name/description/entry per skill), parity check reusing
`skills:mirror-check`, conformance test that every skill parses. Distribution
via Registry listings like Resource Packs.

### F28 · `bindles-rs` / `bindles-py` / `bindles-go` (L each)
Per ADR-0072: generate from the `hobo:sdk` WIT package via wit-bindgen;
idiom layer per language (Rust traits/builders noted in
`wasm-runtime-wit.md`); sequence **rs first** (bindgen maturity), py
(componentize-py), go (TinyGo) after; each gated by the conformance
`sdk-parity` suite (`packages/conformance/src/sdk-parity.ts` exists).

### F29 · `build-wasm` / `build-dagger` / `build-packer` / `build-firecracker`
`build-wasm` is **subsumed by D13** (the real ComponentizeFn is that
package's substance; decide at execution whether to house it in
`packages/build/build-wasm` or extend `@hobo/componentize`). `build-dagger`
= container-fallback image builds behind the same injection seam (M).
`packer`/`firecracker` = VM image lanes, **deferred-with-design** (S6
scope); one paragraph each in the roadmap records the port shape.

### F30 · `provider-pact` / `provider-opa` / `provider-cedar` (S each)
Extractions, not builds: OPA/Cedar adapters move from
`packages/broker/src/{opa,cedar}.ts` into
`packages/providers/provider-{opa,cedar}` implementing the `policy-engine`
port (broker imports them back); Pact-broker adapter extracted from
`contract-harness` behind the contract-engine port. Each gets pacts +
data-models per the guard.

### F31 · `provider-fly` / `provider-kubernetes` (M each)
Follow the provider-convex anatomy (equivalence classes with honest feature
lists, capability manifest with brokered auth posture, realize() → driver or
IaC program, credential-gated client with injected fetch, impedance where
thin). Kubernetes realizes through `iac-crossplane` (ADR-0006) rather than a
bespoke driver; Fly is Machines-API driver-style.

### F32 · `runtime-postgres` / `runtime-temporal` / `runtime-restate` / `runtime-cloudflare` (L each)
Each implements the `EventStore`/`DurableEventStore` port and must pass the
existing conformance eventstore suite
(`packages/conformance/src/suites/eventstore.ts`) — that suite IS the
acceptance bar. **Postgres first** (closest semantics: advisory-lock
single-writer per partition, `SELECT … FOR UPDATE` stream-head CAS mirroring
ADR-0135). Temporal/Restate = adapters over their durable primitives
(divergences documented in `docs/technologies/temporal.md`); Cloudflare DO =
edge journal variant sharing the browser driver's constraints.

### F33 · `iac-cdktf` / `iac-opentofu` / `iac-nix`
**opentofu = S**: the terraform adapter's CLI engine already treats
terraform/tofu as interchangeable binaries — packaging is an alias package
or a documented flag, decide at execution. **cdktf = M**: program emitter
producing the same `{resources, stackOutputs, bindings}` triple through
`hobo:iac/provider`. **nix**: stays optional-never-default (ADR-0006);
design-only entry recording the flake-shape it would emit.

### F34 · npm publish path (M design; owner-gated execution)
Release engineering design: publish allowlist (which of the 68 manifests are
public), version policy (changesets or fixed-train), provenance attestation
(npm provenance + SLSA), dry-run lane (`pnpm publish --dry-run` in CI),
README install-path updates. The **only genuinely owner-gated item** in this
roadmap (npm token + go decision), stated as such.

## WS-G — Registers & audits (M)

### G35 · GAPS Iteration-5 adversarial sweep (M)
Run the register's own protocol (finder/verifier passes, stop rule) over the
unaudited surface: ADRs 0125–0148, lineage + 10 captures, and the
implementation wave (dispatcher, provider-convex, trails executors, stations
routing, events corpus, jurisdiction, policy packs). Append confirmed
findings + same-pass remediations; update the verdict summary.

### G36 · Known-limitations + matrix refresh (S)
After D13/D16 land: componentize row (synthetic → real-with-floor),
runtime-cloud-native row (one real provider), trail-map "not yet shipped"
list, README status bullets.

## Sequencing

**A → B → (C ∥ E) → D (flagship) → F (independent, per-package) → G35 after
A+B settle → A4 after G35 → G36 after D.**
Rationale: A unblocks honesty and removes the known divergence; B completes
a shipped ADR's loop (small, high-integrity); D is the lane-model priority
and the largest single initiative; F items are independent and can be
dispatched as parallel one-shot sessions; audits run against a settled
surface.

## Inventory → workstream traceability

| Inventory item | WS |
|---|---|
| match.Decided divergence | A1 |
| ADR-0135 collision | A2 |
| OKF warners | A3 |
| gap-analysis §6 stale | A4 |
| Gatekeeper residency gate unused | B5 |
| Broker residency inert | B6 |
| Untyped dataClassifications | B7 |
| Junction residency check missing | B8 |
| Adequacy/transfer graph absent | B9 |
| OCSF export scope + unsigned | C10 |
| No OSCAL emitter | C11 |
| Only NIST seed pack | C12 |
| Synthetic componentize (H-E3b) | D13 |
| No scheduler port | D14 |
| BindleBuilder 12/23 kinds | D15 |
| runtime-cloud-native stubs | D16 |
| Fixture login / no OIDC grant | D17 |
| WebAuthn step-up unenforced | D18 |
| No placement-constraint language (GAP-003) | E19 |
| Untyped driver output | E20 |
| No app-graph read-model | E21 |
| No staged rollout groups/approval/resume | E22 |
| ✱ @hobo/sdk | F23 |
| ✱ @hobo/registry | F24 |
| ✱ @hobo/evals | F25 |
| ✱ @hobo/training | F26 |
| ✱ @hobo/agent-skills | F27 |
| ✱ bindles-rs/py/go | F28 |
| ✱ build-* | F29 |
| ✱ provider-pact/opa/cedar | F30 |
| ✱ provider-fly/kubernetes | F31 |
| ✱ runtime-postgres/temporal/restate/cloudflare | F32 |
| ✱ iac-cdktf/opentofu/nix | F33 |
| npm publish | F34 |
| GAPS Iteration-5 unaudited | G35 |
| Stale limitation/matrix rows post-lane-work | G36 |

Vector search is deliberately **not** a roadmap item as a port: ADR-0034
pins vector/graph as opt-in *search-extension packages* over `data` with a
matching-selected `hobo:embed` capability — any future `@hobo/vector` work
follows that ADR, not a new core port. 3P live-lane evidence items from the
old inventory framing are **retired** by the lane model (end users supply
provider credentials; the fail-closed + request-formation contract bar is
the completion bar and is already met for the shipped adapters).
