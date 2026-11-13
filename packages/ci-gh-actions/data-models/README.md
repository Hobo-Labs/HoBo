# GitHub Actions boundary contracts

`jit_bootstrap_response.proto` owns the single-use confidential JIT response.
Never persist its encoded runner credential in events, logs, operation records,
or caches.

`onboarding.proto` owns the account-bound installation principal, reviewed files
and plan, setup operation and pull-request result, and GitHub App manifest.
`onboarding.cue` constrains both these messages and the JIT response; valid and
invalid fixtures run through schema-tools. Generated TypeScript lives under
`src/_generated/` and is regenerated from protobuf.

`relay_mcp.proto` owns what the relay's MCP server returns: the lease, queued
job and event views, their lists, the relay status (with whether the host
reads a mesh) and the quarantine views. `list_mesh_nodes` returns
`MeshNodeReports` from `mesh.proto`.
Each is a deliberate subset built field by field; `onboarding.cue` closes them,
and the `relay-mcp-*` fixtures pin that an event's stored `detail` or a lease's
sandbox identity does not fit a view, and that a cursor is an opaque token,
never a journal position.

`mesh.proto` owns the relay mesh's records: the advertisement a node writes
to the board (`MeshAdvert`, with its identity key and signature), the mesh's
trusted-key set (`MeshTrustConfig`), a node's reliability record as its
journal keeps it, the node report every surface answers with
(`MeshNodeReports`: availability, capacity and trust per node, and a capacity
summary). `onboarding.cue` constrains them. The `mesh-*` fixtures pin that an
older node's advertisement (none of the new fields) is valid, that an
advertisement cannot state its own trust level or carry a private key, and
that a report's trust level is one of three. `src/mesh-records.ts` is the only
place these are parsed and written. The routing snapshot the mesh used to
publish to a repository variable (`MeshFleetState`) is retired: runner routing
reads the box relay's routing slip instead (ADR-0181).

`fleet_verdict.proto` (the hosted relay's fleet verdict, its signed reports,
reporter enrollment, state, allowance and status list; ADR-0180) is retired
with the hosted verdict routes (ADR-0181, plan 0026 section 3.9): the file,
its generated code, its CUE definitions and its `fleet-verdict*` and
`fleet-reporter*` fixtures are gone. The routing slip below carries routing.

`routing_slip.proto` owns the routing slip (ADR-0181): the box relay's
current routing answer for one repository, one route per class (`pr`, `fork`,
`trunk`: runner, tier and a reason code), with its issue and expiry times and
the writing relay's node and commit. It is the message of a parentless commit
at `refs/hobo/routing-slip`. `#RoutingSlip` in `onboarding.cue` constrains it,
and `#RunnerRouting` the committed `runnerRouting` policy in `.hobo/ci.json`
(no proto: it is authored JSON, parsed by zod in `src/runner-routing.ts`).
Its `selfUpdate` block (`enabled`, `intervalHours` 1-168) sets how often the
box relay looks for a newer `main` (plan 0026, 3.8);
`runner-routing-self-update-interval.json` pins that an interval of zero is
invalid.
`src/routing-slip.ts` is the only place a slip is parsed and written; the
route job's dependency-free reader `scripts/ci/runner-routing.mts` agrees with
it on every fixture. The `routing-slip*` fixtures pin that an expired slip, a
wrong repository, an unknown or missing class, a figure in a reason, a
generic label and a reason its tier disagrees with are invalid; the
`runner-routing*` fixtures pin the committed defaults and refuse a generic
label or a trunk split that leaves no shared slot.

`relay_cache.proto` owns the records the hosted relay keeps in its cache
(ADR-0179): the lease record (the `hobo.ci.v1.Lease` as JSON, its job key,
requeue generation and latest intents), the job record (taken marker, pending
demand, assignment fence and terminal tombstone in one value), the per-account
in-flight index, the pending set, the webhook dedupe marker and the sandbox
egress binding. `onboarding.cue` constrains them; the `relay-cache-*`
fixtures pin that a job record's lease id is a UUIDv5 (deterministic, never
random), that a job state is one of four, and that a delivery marker never
holds the body. `src/relay-cache/` is the only place they are read and
written; the key and TTL of each is in the package README.

The shared account, connection, revisioned policy, setup request, control-token
binding, job, lease, and audit-event messages belong to
[`@hobo/ci`](../../ci/data-models/ci.proto). Account policy includes durable Broker
budget-signal cycles and crossing state. The Station bridge consumes its generated
budget-signal and routing-policy messages.

GitHub REST responses, signed webhook payloads, and OIDC claims remain native
GitHub JSON parsed at their external boundaries. A generated onboarding plan is
reviewable intent, not an authorization token: the control API authenticates the
account, restricts installation ownership, and applies its stored server-owned
plan. Connecting requires the reviewed setup pull request to be merged and the
protected bridge ref to match the verified source.

Run scoped generation and drift checks from the monorepo root:

```sh
pnpm codegen --filter packages/ci-gh-actions
pnpm codegen:check --filter packages/ci-gh-actions
```
