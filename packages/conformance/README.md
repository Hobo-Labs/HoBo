# @hobo/conformance

Production package for [HOBO-585](https://linear.app/quickdeploy-ai/issue/HOBO-585) /
[S0-08](https://linear.app/quickdeploy-ai/issue/HOBO-585/s0-08-hoboconformance-port-suite-harness-core-with-golden-ir-capture).
It promotes the [HOBO-5](https://linear.app/quickdeploy-ai/issue/HOBO-5) proof semantics into a
typed, event-sourced port-suite harness under `packages/conformance/`.

## Requirements Source

- `docs/design/generated-stack.md#plan-09` — `@hobo/conformance` trust boundary
- `docs/design/adr/01-architecture-core.md#adr-0072` — golden-IR equivalence + replay
- `docs/design/adr/01-architecture-core.md#adr-0093` — SDK semantics annex lane
- `src/draft/technical-proofs/conformance-port-suite-contract/` — reference semantics (HOBO-5)

## Public API

- `createConformanceSuite(definition)` — parse-don't-validate suite boundary
- `createAdapterRegistry()` — adapter registration
- `createConformanceSuiteRegistry(descriptors?)` — suite descriptor registry
- `runConformanceSuite(definition, adapter, options?)` — event-logged runner
- `evaluateSdkParity(input)` — SDK parity report boundary
- `firstDiff(expected, actual)` — JSON-path first difference
- `runEventStoreConformance(createStore)` — Camp EventStore durability assertions
  (`hobo.camp-eventstore-runtime-port/v1`); provider verification for
  `@hobo/runtime-local` lives in
  `test/runtime-local-eventstore.conformance.test.ts` (dev-only edge to the adapter).

### `@hobo/conformance/anonymous` — the anonymous/claimable dimension

- `BOOTSTRAP_CONFORMANCE_SUITE`, `CLAIM_CONFORMANCE_SUITE`,
  `BINDING_CONFORMANCE_SUITE`, `MIGRATION_CONFORMANCE_SUITE` — the four suite
  definitions, each a frozen case table plus its parser and its pure judge
- `runAnonymousSuite(definition, executor, options?)` — run one suite
- `runAnonymousConformance(ports, options?)` — run all four from one set of ports
- `ANONYMOUS_SUITE_DESCRIPTORS`, `createAnonymousSuiteRegistry()`
- `describeAnonymousSuite`, `aggregateChecks`, `worst`, and the shared parse
  helpers (`requireRecord`, `requireInstant`, `requireMember`, …)
- `BOOTSTRAP_CHECKS`, `CLAIM_CHECKS`, `BINDING_CHECKS`, `MIGRATION_CHECKS` —
  the stable check keys evidence is keyed by
- `UnsupportedCheckError` — what an executor throws for a capability the
  provider genuinely does not offer, so the case records `unknown` rather than
  a false failure
- `AnonymousConformanceError` — a parse refusal at the executor boundary

### `@hobo/conformance/live` — the guarded live lane

- `parseLiveRunGrant(input)` / `liveRunRefusalFor(input)` / `LiveRunRefusedError`
- `LIVE_ENV_KEYS`, `CI_ENV_KEYS`, `LIVE_REFUSAL_CODES`
- `runLiveAnonymousConformance(options)` — provision, run, always clean up, emit
- `runLiveConformanceCli(options)` — the operator command, injectable end to end
- `emitAnonymousTrustEvidence(input)`, `assertSanitized`, `assertNoUpgradedUnknowns`
- `standardTrustChecksFrom`, `checksFromReports`, `evidenceIsFullyPassing`
- `conformanceOutcomeFromArtifact`, `selectionEvidenceFacts` — the two bridges
  into `selectCapabilityImplementation`
- `DEFAULT_EVIDENCE_FRESHNESS_WINDOW_MS` (30 days),
  `MAXIMUM_EVIDENCE_FRESHNESS_WINDOW_MS` (90 days), `CLEANUP_CHECK`

## The anonymous/claimable dimension

A catalog entry that says `anonymous-claimable` is a marketing string until
something exercises it. These four suites are what a Resource Definition's
`conformanceRef` points at.

**Bootstrap** — the advertised bootstrap class is the class the provider
actually performs; consent is recorded strictly before the effectful
provisioning call; a proof-of-work path terminates inside its declared ceiling;
the lease expiry is parsed out of the provider's own response rather than a
local timer we invented; and a resource kind nobody allowlisted is refused
fail-closed instead of quietly provisioned.

**Claim / ownership** — a provider callback alone leaves the item *observed*,
never *completed*; independent verification is what completes it; completion
additionally requires the mandatory post-claim obligations (binding rotation and
bootstrap-authority revocation); and a credential that worked before the claim
no longer works against the claimed resource.

**Binding** — the produced binding round-trips through `parseCapabilityBinding`,
endpoints are addresses rather than credentials, credentials are references
rather than material, rotation preserves the logical resource identity, and an
expired binding behaves the way the product declared it would.

**Migration** — export produces an integrity digest, import verifies that digest
at a *different* destination, cutover happens only after that verification, and
a failed import leaves the source intact and uncut-over.

### Suites are data; effects are ports

A case is a frozen record — an id, the check it decides, a title, the request to
send, and the expectation to judge against. It contains no behavior. The suite
supplies two pure functions beside the table: a parser that turns the executor's
raw answer into a parsed derived type, and a judge that maps that derived type
to `pass | fail | unknown`.

Everything effectful is an injected port: the executor itself, plus (in the live
lane) the clock, the run-id source, provisioning, cleanup, and signing. No suite
definition reads a clock, the environment, the filesystem, the network, or a
random source, which is why the default lane runs offline and returns byte-identical
reports on every run.

Two aggregation rules make the resulting evidence worth something:

- **A case that did not run is `unknown`.** Filtering it out, an executor
  throwing `UnsupportedCheckError`, and a check with no cases at all all collapse
  to `unknown` — never to `pass`.
- **Aggregation is worst-wins.** One failing case sinks its check; one unknown
  case downgrades an otherwise-passing check. There is no averaging and no
  "mostly passed".

## Parse, don't validate

Every value that crosses a boundary here is parsed once into a derived type and
never re-checked downstream:

| Boundary | Parser | Parsed / derived type |
|---|---|---|
| executor answer → judge | `parseBootstrapAttemptOutcome`, `parseClaimStepOutcome`, `parseBindingProbeOutcome`, `parseMigrationStepOutcome` | `BootstrapAttemptOutcome`, `ClaimStepOutcome`, `BindingProbeOutcome`, `MigrationStepOutcome` |
| operator environment → live run | `parseLiveRunGrant` | `LiveRunGrant` |
| suite reports → trust evidence | `emitAnonymousTrustEvidence` (via `parseTrustEvidence`) | `AnonymousTrustEvidenceArtifact` |

A judge only ever sees a parsed outcome, so it contains no defensive checks; an
unparseable answer is already a recorded `fail` with a failure code by the time
the judge would have run. `parseLiveRunGrant` has no partially-permitted state,
because a caller holding a half-checked grant is a caller who provisions on the
half that passed.

## Event architecture

The harness is event-sourced rather than assertion-sourced. `runConformanceSuite`
accepts a run **command** — a suite definition plus an adapter and a seed — and
appends a `ConformanceRunEvent` log (`conformance.RunStarted`,
`conformance.CaseChecked`, `conformance.RunCompleted`). The report is a
**projection** over that log (`projectPortSuiteReport`), not a value accumulated
during execution, so replaying the same events reproduces the same report.

The anonymous dimension follows the same shape. `runAnonymousSuite` folds the
per-case results into an `AnonymousConformanceReport`, which is the
**materialized view** the rest of the platform reads: a stable, sorted check map
plus the case-level detail behind it. `runLiveAnonymousConformance` produces a
`LiveConformanceResult` holding the reports, the cleanup outcome, and the
evidence artifact.

The signed artifact is the **snapshot**: a point-in-time, digested, expiring
summary of a run that is safe to persist and to hand to a party who was not
there. Snapshots land in the platform's evidence **read store** through a
Resource Definition's `trustEvidenceRef` and per-profile `conformanceRef`;
`selectCapabilityImplementation` reads only that snapshot, never the live suites.
The claim lifecycle itself belongs to the `@hobo/claims` **actor**, which owns
the guest-lease and claim-bundle state machine and whose durable log lives in the
platform **event store**; this package's claim suite asserts that a provider's
behavior matches the transitions that actor will accept, and deliberately owns no
claim state of its own.

## The live lane

Everything past `parseLiveRunGrant` spends somebody's money and creates real
resources in somebody's account, so the default answer is no and every yes has
to be spelled out.

```bash
export HOBO_CONFORMANCE_LIVE=1
export HOBO_CONFORMANCE_LIVE_PROVIDERS=neon,cloudflare-workers
export HOBO_CONFORMANCE_LIVE_CREDENTIAL_REF=hobo-secret://acme/live-conformance/neon
export HOBO_CONFORMANCE_LIVE_PROVIDER_DOCS_CHECKED_AT=2026-08-01
export HOBO_CONFORMANCE_LIVE_MAX_RESOURCES=4          # optional, 1-16, default 4
export HOBO_CONFORMANCE_LIVE_RUN_TAG=acme-audit-aug   # optional, else generated

pnpm --filter @hobo/conformance run conformance:live -- \
  --provider neon \
  --adapter ./adapters/neon-live-adapter.ts \
  --out evidence/neon-2026-08-01.json
```

Installed, the same entry is `hobo-conformance-live --provider … --adapter …`.
`--freshness-days <n>` narrows the evidence window; `--help` prints the gates.

### Guard rails

| Guard | Refusal code |
|---|---|
| lane off by default | `LIVE_LANE_DISABLED` |
| provider not named in the per-provider allowlist | `LIVE_LANE_PROVIDER_NOT_ENABLED` |
| no credential supplied | `LIVE_LANE_CREDENTIAL_MISSING` |
| credential supplied as material instead of a locator | `LIVE_LANE_CREDENTIAL_NOT_A_REFERENCE` |
| any CI variable set (`CI`, `GITHUB_ACTIONS`, `TF_BUILD`, …) | `LIVE_LANE_REFUSED_IN_CI` |
| resource budget missing, non-integer, or above 16 | `LIVE_LANE_RESOURCE_BUDGET_INVALID` |
| no date a human read the provider's docs | `LIVE_LANE_PROVIDER_DOCS_DATE_MISSING` |
| malformed run tag or provider id | `LIVE_LANE_RUN_TAG_INVALID`, `LIVE_LANE_PROVIDER_ID_INVALID` |

Every refusal carries the exact variable to set: a guard nobody can act on gets
bypassed. The CI refusal has no override, because "we needed it green in CI" is
precisely how a lane that spends money ends up scheduled.

Beyond the gate: every resource carries the run's unique tag, the count is capped
by the grant, cleanup runs unconditionally — a run that failed is the run most
likely to have left something billable behind — and a handle carrying another
run's tag is refused rather than destroyed. A failed cleanup is recorded as a
failing `lifecycle.cleanup` check and a non-zero exit, never swallowed.

The credential never enters the process as material: only a `SecretRef` locator
does, and only `redactSecretRef` output is ever printed. Before an artifact is
returned, `assertSanitized` scans its serialization for credential-shaped
material and *refuses* rather than redacting — if material got that far, the
adapter has a leak that quietly redacting one artifact would hide.

## Evidence lifecycle

1. **Taken.** A live run emits a `TrustEvidence` body (signed via the injected
   signer, digested by `@hobo/trust`) wrapped in an artifact whose provenance
   carries the adapter version, the product-definition digest, the date a human
   checked the provider docs, the run tag, the signer id, and the suite ids.
2. **Never improved.** `assertNoUpgradedUnknowns` re-derives the truth from the
   reports and refuses to emit if any check reads better in the artifact than it
   did in the run. A skipped case cannot become a passing artifact — including
   through `additionalChecks`.
3. **Consumed.** `selectionEvidenceFacts(artifact, verifier)` fills
   `evidenceExpiresAtMs` and `evidenceSignatureValid`;
   `conformanceOutcomeFromArtifact(artifact)` fills a
   `ProfileImplementation.conformance`. Signature validity comes from an injected
   `EvidenceVerifier`, never from the artifact vouching for itself.
4. **Expires.** Evidence stops counting `freshnessWindowMs` after the run — 30
   days by default, 90 at most. Nobody has to remember to retract it: past that
   instant `selectCapabilityImplementation` rejects the candidate with
   `EVIDENCE_STALE`, and a `fail` or `unknown` conformance verdict rejects it with
   `CONFORMANCE_FAILED`. Both directions fail closed, which is asserted in
   `test/anonymous-evidence-freshness.test.ts`.

## Verification

```bash
pnpm --filter @hobo/conformance typecheck
pnpm --filter @hobo/conformance run build
pnpm --filter @hobo/conformance run test
pnpm exec turbo run test --filter ./packages/conformance
```

The mandatory lanes are offline and deterministic. The live lane is opt-in and
never runs as part of them. Suite, report, and SDK-parity artifacts carry the
exported versioned schema identifiers so consumers can reject unknown versions.

## The workspace boundary gate

`pnpm run lint:boundaries` (`scripts/check-package-boundaries.mts`) reads every
workspace package's manifest and source imports and judges each edge with
`validateBoundaryImports` and `detectWorkspaceCycles` from `src/boundaries.ts`.
It prints one line per refusal on stderr, exits non-zero if there is one, and
prints a `WorkspaceSkeletonValidatedEvent` on stdout whose `violations` holds
one record per refusal: `{ rule, from_path, to_path, effect: "deny" }`.

A refusal is raised together with its rule, so a line on stderr cannot exist
without its record. `rule` is closed — `BOUNDARY_RULES` in `src/boundaries.ts`,
`#BoundaryRule` in `data-models/conformance.cue`:

| `rule` | Refuses |
|---|---|
| `core-imports-hobo` | `@hobo/core` importing a HoBo package |
| `adapter-imports-adapter` | one adapter importing another |
| `adapter-imports-non-core` | an adapter importing anything but core ports and contract vocabulary |
| `outward-dependency` | an import from a lower layer to a higher one |
| `workspace-cycle` | a dependency cycle; the record is the edge that closes it |
| `unknown-package` | an edge from or to a workspace path nobody classified |
| `orchestrator-imports-engine` | an orchestrator importing a data engine at runtime |
| `orchestrator-imports-engine-storage` | an orchestrator importing a database driver or engine-specific storage at runtime |
| `engine-imports-engine` | one data engine importing another at runtime |

### Engine neutrality

The last three rules keep migration orchestration engine-neutral (ADR-0177):

- **Orchestrators import no data engine at runtime.** An orchestrator
  (`packages/trails`) reaches storage through the `@hobo/data-core` ports. A
  data engine is any `packages/data-<engine>` package, or one of that name
  directly under an adapter tier; `data-core` and its companions are not
  engines.
- **Orchestrators import no database driver and no engine-specific storage at
  runtime.** A driver is named by the specifier a source file writes
  (`node:sqlite`, `pg`, `mongodb`, …, and their subpaths), so a builtin is
  caught although it is never a workspace edge. `@hobo/storage-sqlite` is one
  engine's storage and is refused the same way.
- **Engines do not import each other at runtime.** They meet only through
  `@hobo/data-core`. Every engine sits on the same layer, so no layering rule
  stands between two of them.
- **Test-only edges are allowed.** A test may import a real engine or driver
  to exercise a live lane. An edge is test-only when the dependency is declared
  under `devDependencies` *and* no file under `src/` imports it: one sighting
  under `src/` makes it a runtime edge, whatever the manifest says. A type-only
  import in `src/` is still a runtime edge.

## Boundaries

The package is generic over WIT ports and adapters. It does not import runtime,
provider, IaC, build, registry, signing, or `hobo verify` implementations — it
consumes `@hobo/trust` for the evidence shape and digest, `@hobo/bindings` for
secret-reference parsing and binding round-trips, `@hobo/claims` for the
bootstrap-class and claim vocabulary, and `@hobo/capability-profiles` for the
selection types, and implements no cryptography of its own. It ships
package-local Protobuf, CUE, and Pact evidence for the report envelope and for
the anonymous dimension (`data-models/anonymous_conformance.proto` +
`.cue`, `contracts/pacts/anonymous-conformance-adapter.pact.json`, replayed by
`contracts/consumer/anonymous-adapter-boundary.test.ts`), and records unrun
`camp` tiers honestly for later production verification.

HoBo.CI sibling SDKs (`ci`, `ci-gh-actions`, `ci-dagger`, `ci-cf`) are registered
as application-layer packages in the boundary classifier. They compose the existing
Dispatcher without provider-layer exceptions; see `../ci/ADR.md`.

`@hobo/ci-ado` and the existing `@hobo/ci-vercel` transport are registered alongside
the other CI application SDKs at layer 3;
its dependency on the portable CI runtime is covered by the workspace boundary
registry and the complete-package classification test.
