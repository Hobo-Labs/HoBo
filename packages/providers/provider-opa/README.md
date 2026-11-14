# @hobo/provider-opa

The OPA/Rego policy engine behind the broker's gate-plane port, extracted
from `@hobo/broker`. The broker depends on this package
and re-exports `createOpaGatePlane`, so existing imports keep working; the
dependency points provider->contracts only (no cycle).

- **Decision path**: POST `/v1/data/hobo/broker/decision` on the OPA Data API
  with `{ input: { request, costQuota } }`; the Rego result document
  (`effect`, `reasons[]`, `policyIds[]`) lowers onto the engine-neutral gate
  decision.
- **Fail-closed**: transport errors, non-200s, undefined results, and unknown
  effects DENY with `policy-engine-unavailable` / `policy-denied` — an
  unreachable policy engine never allows.
- **Governed by default**: every evaluation (allow included) records a
  `policy.Decided` fact with engine id `opa/rego@v1`.
- **Credentials**: an optional `tokenProvider` resolves the OPA credential out
  of the token broker; the adapter holds no raw secret and uses only the
  injected fetch.

Wire form of the decision document is pinned in
[`data-models/provider_opa.proto`](./data-models/provider_opa.proto) (+ CUE
bounds); the HTTP boundary is fixtured in
[`contracts/pacts/provider-opa-boundary.pact.json`](./contracts/pacts/provider-opa-boundary.pact.json).

## Architecture evidence

Untrusted engine responses become parsed derived types at the boundary —
`parseRegoResult` follows parse, don't validate — the Rego result document lowers onto parsed derived types
document (unknown effects fail closed to deny, malformed reasons are
dropped, only string policy ids survive). The adapter emits no events
itself beyond returning `policy.Decided` facts on the gate decision: the
command → event pipeline is the broker's — its actors append the facts this
plane returns to the event store, and the broker's materialized views /
projections (with snapshots feeding read stores) expose decision history;
this package only lowers the engine verdict onto that flow.
