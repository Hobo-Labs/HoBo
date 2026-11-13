# CD conformance kit

This example shows how to prove an adapter against the `@hobo/cd`
conformance suites in `@hobo/conformance` (plan 0024, WP20). It ships an
in-memory reference adapter for every suite. Each reference passes. Each one
also has *mutants*, copies broken in exactly one way, and the suite catches
every one of them.

| Suite (`@hobo/conformance`) | Port or invariant | What it proves |
|---|---|---|
| `runRealizerConformance` | `Realizer` | Converges only by observation (I5), idempotent (I12), fenced, aborts cleanly, typed failures, secret-free (I9) |
| `runTrafficShifterConformance` | `TrafficShifter` | Declared offerings, apply and status agree, honest when it has no traffic capability (I6, C5) |
| `runHealthSourceConformance` | `HealthSource` | Never invents samples (I5, C3), keeps cohorts apart, refuses an outage with a typed reason |
| `runPublisherConformance` | `PublisherPort` | Publishing is not converging; reports convergence only after the engine syncs |
| `runReconcilerTransportConformance` | `ReconcilerTransport` | One writer per Camp, fences only grow, a stale fence is refused (I4), the feed resumes after the checkpoint |
| `runArtifactStoreConformance` | `ArtifactStore` | Content-addressed, idempotent, detects corruption at rest |
| `runArtifactVerifierConformance` | `ArtifactVerifier` | Every digest checked at its coordinate; unreachable means refused |
| `runProvenanceVerifierConformance` | `ProvenanceVerifier` | Subject binding, pinned builders and signers, refuses (never throws on) malformed input (I15) |
| `runSubscriptionDriverConformance` | `SubscriptionDriver` | Moves forward only, respects the discovery limit, digest-pinned, survives a registry outage |
| `runPlacementEngineConformance` | `PlacementEngine` | Same decision for any input order (I18); claims narrow, never grant (I19); refuses spread it cannot meet |
| `runFanoutControllerConformance` | `FanoutController` | Bounded concurrency, mandatory groups first, halts at the failure budget, deferred is not failed (I20), never wedges |
| `runPostureEvaluatorConformance` | `@hobo/policy/posture` evaluator | Pure and order-free; unknown counts against compliance; the fixed operator set (D25) |
| `runCampInventoryConformance` | `CampInventory` | An agent can never add `NO_RUN`; contradictory claims or silence taint `NO_PLACE` (D19) |
| `runDeliveryRecordsConformance` | `hobo.delivery.ts` modules | DAG, sources and windows exist, one target per node, fan-out only with placement, ENFORCE after INFORM (I23), pinned publishers and provenance, secret-free |
| `runToolsetMatrix` | Toolset matrix | Seven ingress paths, one Freight id (§10 WP20); a bare CDEvent creates nothing (I15) |
| `runPlatformMatrix` | Platform matrix | Every traffic rung and none × every artifact kind × built-in and WASM-component resolvers (I1, I6, I14) |
| `runAirgapConformance` | §10 WP20 | With egress disabled, promotes through a local source and an agent; the Station never dials the agent (I3) |
| `runJournalReplayConformance` | §10 WP20 | State rebuilt from the journal equals live state (I8) |
| `runCdChaos` | Chaos lane | Six faults; invariants hold through each and everything recovers |
| `runFanoutLoad` | Load lane | 10,000 Camps, one fan-out, p99 controller tick under 1 s |

## Use it for your adapter

```ts
import { assertCdConformance, runRealizerConformance } from "@hobo/conformance";

const report = await runRealizerConformance({
  subject: "my-provider-realizer",
  create: async () => ({ realizer: myRealizer(), target: myTargetProbe() }),
  input: (signal) => myRealizeInput(signal),
  ctx: () => myCdContext(),
});
assertCdConformance(report); // throws CdConformanceError naming each failed assertion
```

The suites type against structural shapes (`RealizerLike`, `CampInventoryLike`
and so on). Those shapes copy the frozen `packages/cd/src/ports.ts`, so any
real `@hobo/cd` implementation fits them. `test/kit.test.ts` checks the
mirrored enum values against the generated `@hobo/cd` enums.

A harness that leaves out a probe a suite needs, such as
`target.lieOnNextApply`, fails that assertion. It does not pass by default
(plan 0024 §12).

## Run

```sh
pnpm --filter @hobo/example-cd-conformance-kit test        # every suite, matrix, chaos and load (offline)
pnpm --filter @hobo/example-cd-conformance-kit test:chaos  # the chaos lane only
pnpm run test:chaos                                        # repo chaos lane, includes this kit
```

## Runbook

- **A suite fails for your adapter.** Each failure names the assertion, what
  happened and the fix (`remediation`). Fix the adapter. Never loosen the
  suite. A failure that says `harness does not provide …` means your harness
  is missing a probe. Add the probe. Do not delete the assertion.
- **The enum drift test fails.** `cd.proto` changed under a coordinator
  amendment. Update the `CD_*` mirrors in
  `packages/conformance/src/suites/cd-shapes.ts` to match it.
- **The chaos lane fails at `:recovers`.** Something wedged. A fault was
  healed and the world did not converge within `recoverSteps`. Look at the
  invariant failures for the same fault first.
- **The load lane fails at `p99TickUnderBudget`.** The controller tick is
  scanning the whole fleet. A tick must cost O(changes), not O(Camps).
- **Telemetry.** Pass `{ telemetry }` (any `TelemetrySink`) to a suite. It
  emits one `hobo.cd.conformance.assertions` counter per assertion, labelled
  with `suite`, `subject`, `assertion` and `status`.
