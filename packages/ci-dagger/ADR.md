# Dagger execution adapter

Status: implemented SDK execution and native 1.x CLI checks. Local contracts verify the portable pipeline
boundary; provider connectivity is a separate runtime binding.

Native checks are a separate `@hobo/ci-dagger/checks` entrypoint. Dagger's 1.x
workspace/check orchestration is delegated to the installed CLI rather than
reimplemented through the pinned 0.21.11 SDK. `CheckConfig` is protobuf-owned,
parsed into an immutable refinement, with CUE fixtures and a subprocess Pact.
The required CLI version pin selects the local engine image and is checked before
execution. `local` is translated to the documented `image://` transport. Explicit
non-Cloud engine URIs support operator-owned shared infrastructure.

The native runner owns only its CLI process. It streams logs and returns the exit
code; it does not emit scheduler events, reserve a lease, settle costs, update a
read model, or assert remote termination when interrupted. The existing portable
pipeline actor continues to own those responsibilities below. Native check
results are not replayed or automatically failed over.

Cloud/session environment values are removed in a child-only copy. Temporary
XDG/user configuration isolates saved Cloud credentials as well as per-user
settings. Explicit engine selection prevents inherited Cloud engine defaults;
no Cloud mode is exposed. Provider/API use inside an operator's modules remains
outside this runner's cost boundary. Repository Cloud Checks are a separate
trigger and require the documented `dagger cloud checks off` opt-out.

Native execution has a bounded overall deadline (900 seconds by default), checks
for an actual workspace configuration before allocation, and preserves 124/130/143
timeout/signal exit codes. POSIX process groups keep a CLI's transport child from
surviving cancellation; remaining children are killed even when the CLI exits
before them. Configuration files are bounded regular files, opened nonblocking
so FIFOs cannot hang the CLI. Case-insensitive credential-key filtering avoids
inherited Cloud/session values on platforms with case-insensitive environments.
Explicit local container-runtime transports and named workspace overlays are
configuration choices, still separated from Cloud engine selection.

The live acceptance lane delegates no behavior to mocks: the built CLI runs
Dagger 1.0.0-beta.21, its real local engine, and digest-pinned Alpine commands.
It checks source snapshots after uncommitted changes, exit status, filters,
overlays, timeout and cancellation, while invalid inherited credentials prove
that a local run does not attach to the caller's Cloud/session identity. The
lane is manual, never an implicit PR dependency on Docker or external services.

The runtime record types come from shared `@hobo/ci` protobufs and this package's
local Readiness protobuf. Parse, don't validate: `parsePipeline` establishes a parsed
domain type and `parseReadiness` establishes the derived domain type `DaggerReadiness`.
CUE constraints, valid/invalid fixture instances and schema-tools drift checks
protect generated records. There is no duplicate handwritten execution DTO.

A command pipeline opens one owned Dagger SDK connection. Its steps chain only the
source workspace Directory between clean image environments. argv is passed to
`withExec` without a shell interpolation layer; a fixed GNU timeout wrapper bounds
execution. Expected failure outputs use `ReturnType.Any` and remain observable.
Artifacts use a fixed path-checking shell operation and common bytes/digest records.

The shared actor owns execution commands, the event store, budget reservation,
lease projection, snapshot and read store. The Dagger adapter does not mutate those
views. It executes only after the scheduler admits the bound account/offer and
returns results to that actor for settlement. Ambiguous startup/cleanup is retained
as uncertainty and is never blindly failed over to a second backend.

The SDK itself does not expose a command-termination acknowledgment. An operator's
connector may supply `stop()` backed by its engine control API. During an active
operation, cancellation without that acknowledgment returns uncertain even after
closing the SDK session. This is an explicit execution contract, not an assumption
that closing a GraphQL client killed a remote process.

Pact fixtures are hand-authored in-process consumer expectations, not captured
provider traffic or vendor verification. They execute the shipped adapter through
its SDK-shaped port, while a compile-time witness checks the real pinned SDK's
compatibility. An additional strict loopback GraphQL contract drives the default
connector through the actual SDK, so transport behavior is executable too. TypeScript, execution tests, readiness tests, CUE fixtures, codegen
checks and lint are the validation gates.

A reserved `HOBO_CI_EXECUTION_ID=pipeline.id` environment value enters every command
DAG after user env. Different logical executions cannot silently reuse a prior
side-effecting command cache. The same execution ID remains replay-stable; callers
must give a new run/revision a new logical ID. Artifacts are size-checked within the
engine before encoding, avoiding oversized file materialization into SDK output.
Session close caches its Promise, so repeated callers share both pending and failed
shutdown acknowledgment instead of observing a false completed close.

SDK exit-code/stdout/stderr reads are tracked through `allSettled` independently of
`Promise.all`'s first failure. The first error reaches cleanup promptly, but cannot
clear active work while sibling queries remain unresolved. Even when all reads
settle, a rejected exit-code query does not establish remote completion; positive
provider stop acknowledgment is required before that state can be treated as stopped.
