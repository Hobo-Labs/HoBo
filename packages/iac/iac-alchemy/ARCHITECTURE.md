# Alchemy IaC adapter architecture

The adapter is an optional external package. The host injects the IaC program,
Alchemy stack and financial port; no core service imports this provider.

## Parse, don't validate

The generated protobuf `Target` and CUE constraints define resource scopes.
`createAlchemyIacProvider` copies and checks the target before use, and
`inspectAlchemyPlan` produces the derived domain type `InspectedAlchemyPlan` only after checking
that every planned Alchemy resource has the expected scope and fingerprintable
inputs. Uninspectable plans fail before admission or provider execution. PACT
consumer coverage exercises the unavailable-pricing boundary.

## Event architecture

A resource actor issues the preview, apply, destroy, and refresh commands through
the generic IaC port. The adapter does not own an event store or emit domain
events. The host executor and actor record execution and resource outcome events
in the deployment event store. The host's deployment and drift materialized
view projections supply the read store and show reconciliation-required outcomes.
Alchemy owns its own provider-state snapshot; the adapter reads that state for
planning and drift checks. Budget reservations remain in the host authority,
not in the Alchemy state snapshot.

## Cross-package integration proof

`test/iac-alchemy-integration.test.ts` exercises the adapter with the host
dispatcher route authority, ranked execution, Rivet Alchemy resources, and the
RivetKit 3 runtime package. The suite is the regression gate when routing,
admission, or provider pins change on `main`.

`test/better-auth-host-harness.test.ts` is the incremental Alchemy-auth stack
fixture: construction-time `HOBO_AUTH_*` dotenv-shaped config, in-memory Alchemy
state, local SQLite posture (`:memory:`), and `@hobo/pack-better-auth` planning
plus camp `SecretsPort` broker wire — no live Worker/D1 deploy yet.

`test/better-auth-session-durability.test.ts` is the stack-6 gate: file-backed
SQLite session rows plus brokered signing-secret re-resolution after a simulated
process restart (still mocked boundaries; no HTTP Better Auth runtime).
