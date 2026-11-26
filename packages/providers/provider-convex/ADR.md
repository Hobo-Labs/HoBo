# ADR: Convex as a thin HoBo CloudProvider

## Status

Accepted — implements the ADR-0144 thin-adapter rule
(`docs/design/adr/07-portability-extensibility.md#adr-0144`).

## Context

Convex is an adjacent reactive TypeScript BaaS (`docs/competitors/convex.md`)
whose cleanest relationship to HoBo is *infrastructure HoBo orchestrates*: a
Bindle's `data`/`bucket`/`api` resources realized onto a Convex deployment via
Resource Definitions and Matching. Dual authoring and deep runtime embedding
are historically expensive and explicitly out of scope; the risks are
over-claiming fidelity (document store ≠ relational, reactive queries ≠
event-sourced replay) and leaking static deploy keys.

## Decision

1. **One-directional realization only.** The provider maps three equivalence
   classes (`web/service`, `database/reactive`, `objectStore`) onto Convex
   services with deliberately narrow feature lists; `require` negotiation
   surfaces misses as `partial(missing)` verdicts, never fabricated parity.
   Vector search and scheduling ride as capability features because no
   `vector`/scheduler port exists in `@hobo/core` today.
2. **Driver, not IaC.** `realize()` emits a `convex-deploy` driver program
   (`hobo.driver-program/v1`) targeting the Management API; emitted programs
   are asserted parse-don't-validate before leaving the package.
3. **Broker-held deploy keys.** Auth posture is `deploy-key-brokered` with
   `staticSecrets: false`; the credential-gated client fails closed without a
   broker-minted key and inspects env presence only. Missing credentials fail
   closed.
4. **Impedance is typed, not prose-only.** Hard limits, the `document`
   paradigm, and paradigm-mismatch findings are exported constants/functions
   consumed as PortabilityReport evidence (ADR-0024), so planners and agents
   cannot assume full fidelity.
5. **Escape hatches stay Yard-scoped.** Convex-specific options ride Camp/Yard
   `.with(...)` annotations; Bindles reject provider annotations by
   construction (`assertNoBindleProviderSelection`).
6. **`data.convex/v1` is a data descriptor, not a registry.** The capability
   profile refines `data.document/v1` and nothing else. Self-hosted Convex may
   persist to Postgres, MySQL, or SQLite, but a storage engine is not a
   capability surface — `DATA_CONVEX_NON_REFINEMENTS` records each tempting
   confusion with its refutation instead of leaving it to be re-derived.
7. **Three hosting forms, never conflated.** `convex.local-accountless/v1` is
   development-only and carries an explicit no-production-durability flag; a
   tunnel in front of it is typed as a Connector, not a claim.
   `convex.selfhosted-oci/v1` pins registry-verified image digests, both
   public HTTP surfaces (3210 client API, 3211 HTTP actions), a required
   `/convex/data` volume, and optional external SQL / S3-compatible storage.
   `convex.cloud-sponsored-transfer/v1` is sponsor-backed and explicitly not
   anonymous: a destination team must exist first and sponsor deploy keys are
   revoked after the transfer.
8. **Exclusive ownership is proven by replacement, not by upgrade.** A Convex
   admin key is an irrevocable secret baked into the deployment, so any
   pre-claim authority is treated as compromised. `src/strong-claim.ts` is a
   pure state machine over provision-fresh → deploy → fence → export → import
   → verify → cutover → bounded rollback window → destroy, with every effect
   behind the injected `ConvexMigrationDriver`. Ordering invariants (source
   authoritative on failed import, cutover only after verification, source
   destroyed only after cutover plus a closed rollback window, failure never
   reports completion) live in the decider and are unit-tested.
9. **Conformance is fail-closed data.** `CONVEX_CONFORMANCE_PROFILE` follows
   the repo's pack convention (a frozen exported record plus a pure evaluator,
   as in `@hobo/policy`), and `evaluateConvexConformance` treats `unknown`,
   missing, and unrecognized outcomes as blocks.

## Consequences

- (+) Convex becomes selectable through ordinary Matching with honest cost
  facts and auditable `match.Decided` records.
- (+) Portability erosion is visible: every Convex-specific dependency is
  either a scored `.with()` annotation or a recorded paradigm mismatch.
- (−) Fidelity is deliberately partial: no control-plane time-travel or
  cross-Yard Trails for data living inside Convex; only the provisioning
  lifecycle is event-sourced.
