# @hobo/sdk

The operator SDK for platform, security, DevOps and SRE authoring. App-facing
Bindles live in `@hobo/bindles`; the WIT contract remains `hobo:sdk` (ADR-0072).
Declarations are immutable authoring input. The execution APIs below consume
that input, perform the actual work, observe its outcome, and write durable
facts to the operator's `@hobo/core` EventStore. No hosted broker or relay is
required for direct self-hosted execution.

## Shared engines

- `dispatcher(options, runners)` lowers runner declarations onto the existing
  `@hobo/dispatcher` registry. Feed the registry to `decideDispatch`, then pass
  the selected concrete runner port to `executeRemoteRunner`, or run a direct
  local job with `executeLocalRunner`.
- `policyPack` / `rule` compile the existing `@hobo/contracts` policy evaluator's
  rules. Execution records the evaluator's actual `policy.Decided` data rather
  than inventing a second policy decision shape.
- `defineResource` produces the existing `@hobo/cloud` ResourceDefinition that
  registry Matching consumes. `definePlugin` wraps the core plugin manifest;
  `assertPluginExports` checks the module actually implements its advertised
  extension exports.

## Waiver execution

`waiver(decisionId, spec)` authors a time-bounded exception.
`createWaiverService({ store, tenant, actor, actorRoles, actorScopes, now })` exposes `request`, `approve`,
`evaluate` and `revoke`. The control plane supplies authenticated actor roles/scopes; approval arguments
cannot fabricate another authenticated principal. Independent approver identity, existing base access,
resource/action scope, policy fingerprint and expiry are checked before a
waiver changes a denied decision. Mandatory policy ceilings remain binding.
Expiry is checked synchronously on authorization and emitted once as a durable
fact; it does not rely on a best-effort timer. `replayWaiver` rebuilds the state
from persisted approval/revocation/expiry events after restart.

## Runbook execution

`runbook(name, spec)` authors diagnosis and remediation.
`executeRunbook(declaration, options)` resolves the named read-only diagnosis
implementations and action implementations supplied by the owning control
plane. Each action has both `execute` and `verify`: successful return alone is
insufficient. The executor applies the actual policy evaluator, requires the
host to verify approvals for gated actions, runs effects, checks observed
postconditions, and writes a snapshot after completion.

Effect arguments follow core `JsonValue`/`JsonObject`, matching the Protobuf
`args_json` wire field. Authoring parses and independently freezes nested JSON;
cycles, non-finite numbers, functions and undefined argument values are refused
before any effect runs. `test/runbook-arguments.test.ts` pins this boundary.

Completed executions replay without applying fixes again. If an effect started
but its completion record was lost, retry observes its postcondition first and
refuses to repeat an unverified possibly committed effect. Execution identifiers
are bound to declaration and incident identity. The real SQLite-backed tests
apply a filesystem failover and prove approval blocking, policy denial,
verification, persisted facts and retry behavior.

## Chaos execution

`executeChaosExperiment` consumes `chaos(name, spec)` against an isolated target,
policy pack, and executable invariant checks. `createFetchChaosTarget` owns a
private fetch fault membrane. `createCampChaosTarget` binds a bounded Camp group
of private members and refuses requests outside it. Tests observe requests fail
under injected faults and recover after cleanup, including abort/throw paths.

The target port can be implemented by the runtime that owns the real workload.
The built-in fetch target changes its own calls; it never claims to have changed
an external provider's infrastructure. Facts distinguish observed fault,
invariant outcome, cleanup and experiment completion. `replayChaosExecution`
rebuilds the durable result without injecting faults.

## Runner execution

`runner.selfHosted()` selects direct execution. `behind: "relay"` is an explicit
optional transport choice, not a prerequisite. `executeLocalRunner` runs an argv
vector with no shell, only the declared child environment, an execution timeout,
and an output bound; its result reflects the real exit status. Timeouts, signal
termination and output overflow produce failed receipts, including when the
operating system reports no numeric exit code.
`executeRemoteRunner` invokes the existing selected provider's runner port and
checks correlated provider/job identity and terminal status. Neither path turns
a submitted or unfinished job into a successful receipt. Duplicate execution
claims are refused before repeating effects.

## Provider generation and loading

Generated HTTP providers refuse dot-segment traversal, backslashes and encoded
path separators before sending a request, including in caller path parameters.
This preserves the declared operation path when forwarding scoped credentials.

`generateProvider(docsUrl)` authors the request.
`executeProviderGeneration(request, options)` fetches documentation and compiles
an executable HTTP provider from OpenAPI. Prose documentation uses the explicitly
configured OpenAI-compatible synthesis endpoint; it can be self-hosted. The
returned specification is parsed and every generated operation must pass a real
conformance request against the compiled artifact before its executable bytes
are SHA-256 digested and signed
with the operator's Ed25519 key. Actual execution stages identify deterministic
compilation versus model synthesis. Provider target origins default to the
documentation origin; use `allowedOrigins` to explicitly authorize additional
origins before conformance requests.

`createGeneratedHttpProvider` invokes the generated operation adapter.
Generation retains `provider.ts` for audit and strict compilation, and esbuild
emits a self-contained `provider.mjs` for execution. The signed receipt
`sourcePath` names that JavaScript file, so plain supported Node needs no
TypeScript loader.

`loadGeneratedProvider(receipt, trustedPublicKey)` reads the JavaScript bytes
once, verifies their digest and an operator-trusted signer, then imports exactly
those verified bytes through a data URL. It does not reopen the artifact path
after verification. The receipt
is evidence of tested operations, not authorization to register an arbitrary
provider or bypass deployment policy. The composition root owns registration and
realization using its existing registry/IaC ports.

## Contracts and verification

`data-models/sdk.proto` and `sdk.cue` describe declaration, execution-fact,
runbook-result, runner-job/result and generated-provider receipt records. Core
EventEnvelope owns tenant/actor/sequence metadata; SDK facts carry execution and
step identity plus effect-owner evidence. Stream identifiers encode tenant and
execution identifiers as tuples so separators cannot collide across tenants.
Factories follow parse, don't validate: derived domain types clone and freeze
accepted declaration values, and runner job and receipt views derive their
fields from the generated protobuf records. Execution functions reject invalid
process bounds and untrusted artifact bytes before effects.

Operator commands run as authenticated actors against the supplied event-store.
Waiver and runbook projections replay durable events; the event stream is their
read store. Completed runbooks also write snapshots, while recovery checks the
event history and observed action postconditions before repeating work. Chaos
replay reads its recorded terminal result without injecting another fault.
Existing wrapped engine types remain
owned by their engine packages. The package opts into Protobuf generation with
`data-models/buf.yaml`; `#Sdk` valid/invalid fixtures exercise its CUE gate,
including refusal of a failed process reported as successful.

`test/runbook-execution.test.ts` executes the message PACT fixture
`contracts/pacts/sdk-execution-boundary.pact.json` against real durable facts.
`test/waiver-chaos-execution.test.ts` covers real EventStore lifecycle/probes.
`test/provider-runner-execution.test.ts` runs real processes, real loopback HTTP,
generated provider compilation/loading, signature checks, configured model HTTP,
and the existing runner-provider adapter. The authoring tests continue to check
parsed declarations, policy/dispatcher composition and resource/plugin contracts.

The older declaration-submission PACT file documents the authoring wire shape;
it does not by itself implement a hosted `/v1/declarations` service. Execution
uses the SDK APIs and operator-owned services described above.
