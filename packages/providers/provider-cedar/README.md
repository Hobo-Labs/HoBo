# @hobo/provider-cedar

The Cedar policy engine behind the broker's gate-plane port, extracted from
`@hobo/broker`. The broker depends on this package and
re-exports `createCedarGatePlane`, so existing imports keep working; the
dependency points provider->contracts only (no cycle).

- **Authorization request**: POST `/v1/is_authorized` on a cedar-agent with
  `principal` / `action` / `resource` entity literals derived from the Policy
  IR request plus a `context` carrying phase + costQuota.
- **Fail-closed**: only an explicit `"Allow"` decision allows; transport
  errors and non-200s DENY with `policy-engine-unavailable` — an unreachable
  policy engine never allows.
- **Governed by default**: every evaluation (allow included) records a
  `policy.Decided` fact with engine id `cedar@v1`; deny reasons cite the
  Cedar policy ids from `diagnostics.reason` when present.
- **Credentials**: an optional `tokenProvider` resolves the engine credential
  out of the token broker; the adapter holds no raw secret and uses only the
  injected fetch.

Wire form of the verdict is pinned in
[`data-models/provider_cedar.proto`](./data-models/provider_cedar.proto)
(+ CUE bounds); the HTTP boundary is fixtured in
[`contracts/pacts/provider-cedar-boundary.pact.json`](./contracts/pacts/provider-cedar-boundary.pact.json).

## Architecture evidence

Untrusted engine responses become parsed derived types at the boundary —
the verdict parse follows parse, don't validate (parsed derived types, never booleans over raw JSON): only an explicit
`"Allow"` decision allows, anything else (including malformed documents)
fails closed to deny, and only string policy ids survive from
`diagnostics.reason`. The adapter emits no events itself beyond returning
`policy.Decided` facts on the gate decision: the command → event pipeline
is the broker's — its actors append the facts this plane returns to the
event store, and the broker's materialized views / projections (with
snapshots feeding read stores) expose decision history; this package only
lowers the engine verdict onto that flow.
