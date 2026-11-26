# Azure DevOps execution and artifact boundaries

Azure DevOps Services remains the pipeline control plane. The generated YAML
selects only the configured self-hosted Linux pool and invokes the same portable
command runtime used by local preflight. HoBo does not emulate Azure's task
engine. Literal configurable bootstrap/runner argv permit consumer repository
layouts without adding another command-plan format.

Protobuf owns project configuration, artifact manifests, live acceptance inputs
and consumed vendor projections. CUE fixtures and strict runtime parsers constrain
these boundaries. Environment references resolve only at execution; values are
excluded from serialized project, target and manifest records. Captured logs
mask complete declared values, without claiming artifact or transformed-secret
filtering.

Parse, don't validate: `parseAdoProject`, `parseAdoLiveTarget` and the shared
`parsePipeline` derive immutable branded types before execution. Callers pass
these parsed types to the renderer and live acceptance client.

Publication uses collected byte snapshots in a fresh private temporary directory.
Each attempt publishes a distinct immutable Pipeline Artifact. A downstream job
uses native download and verifies the manifest digest received through ADO job
outputs, exact declared paths and individual file hashes. This tests transport
consistency and retains ADO's original status semantics. It does not attest the
honesty of the self-hosted machine or its repository code.

The live acceptance client uses an existing pipeline, a pinned definition revision
and an exact commit. It previews before queueing, checks pool/source provenance
and native timeline tasks, and never retries ambiguous run creation. Known
unfinished runs are cancelled and reconciled on failure or interruption.
The default connection broker uses the shared `@hobo/contract-harness` parser
and mock provider with recorded Pact interactions. Scenario ordering selects
responses without manufacturing API payloads in test code. Exact request-body,
header and query checks plus an independent completion assertion prevent an
expected client rejection from hiding contract drift. Loopback HTTP tests exercise
the shipped transport, redirects and cancellation. Native artifact task inputs
are also checked against their Pact during the generated-script acceptance test.
Hand-authored consumer contracts remain distinct from remote Azure evidence.

Run completion and cancellation require the requested run ID, so a terminal
response for another run cannot release a known unfinished execution. Admission
requires one unambiguous self-hosted pool and an exact plan-digest argument.
Request/header and response-body waits honor abort independently of a custom
transport; late responses and failed cleanup promises are drained without
exposing transport credential material. Cancellation reconciliation has its own
bounded window. The edge-case Pact records these refusal and lifecycle states.

Downloaded bundle verification checks the physical declared tree, including
zero-byte files, while refusing unlisted entries, links and special files. Source
constructors reject prototype-map keys before protobuf can silently discard a
declared environment variable. The portable Pipeline constructor enforces that
same rule for every CI backend; no new durable command/event format is introduced.

An explicit `ado` backend binding also integrates with the existing SQLite
scheduler. Provider/backend pairing prevents accidental binding to a different
execution adapter. The shared actor owns lease events, snapshots and completed
result replay; the ADO package adds no competing persistence layer. Authorized
prices and entitlements remain account inputs.

`PipelineScheduler` owns command/event coordination through the shared actor and
event store. Its materialized projection supplies the snapshot in the read store.
Direct CLI execution bypasses that durable actor and emits no durable commands
or events. The SQLite restart acceptance test verifies completed-result replay.
