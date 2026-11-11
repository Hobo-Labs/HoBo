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
summary) and the routing snapshot published to `HOBO_CI_FLEET_STATE`
(`MeshFleetState`). `onboarding.cue` constrains them. The `mesh-*` fixtures
pin that an older node's advertisement (none of the new fields) is valid,
that an advertisement cannot state its own trust level or carry a private
key, that a report's trust level is one of three, and that the routing
snapshot names labels and counts only, never a node. `src/mesh-records.ts` is
the only place these are parsed and written.

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
