# @hobo/bindings

Portable capability bindings and secret locators.

Provisioning a database does not decide how a Worker, a Vercel function, an OCI
container, a VM, a WASM component, or a local process reaches it. This package
keeps those two things apart: a product emits a portable **binding**, and a
runtime-specific **connectivity implementation** projects that binding into a
workload. Cloudflare Hyperdrive is connectivity, not a database provider.

## What is in here

- `secret-ref.ts` — `SecretRef` parsing, redaction, and the `SecretValue`
  wrapper that refuses to serialize.
- `binding.ts` — `CapabilityBinding` parsing and the connectivity registry.
- `standard-connectivity.ts` — first-party connectivity implementations
  (Hyperdrive, the Neon serverless driver, Upstash REST, Vercel/Netlify
  environment refs, OCI/VM service-binding files, WASI config).

## secretRef is a locator, never a value

A `SecretRef` is an opaque URI in a registered scheme (`vault://`,
`azure-kv://`, `aws-sm://`, `gcp-sm://`, `op://`, `infisical://`,
`hobo-secret://`, `hobo-token://`). The parser rejects raw values, embedded
userinfo, unsupported schemes, control characters and log-forging sequences, and
path traversal. Provider-returned connection strings and tokens are captured
server-side and deposited into the token authority immediately; plans,
manifests, events, receipts, projections, UI payloads, and logs carry only the
reference plus non-secret endpoint metadata. `redactSecretRef` is the only
formatter, and `SecretValue` exists so an accidental `JSON.stringify` cannot
leak a resolved value.

## Parse, don't validate

`parseSecretRef` and `parseCapabilityBinding` are the two parse boundaries.
They return derived domain types — a branded `SecretRef` and a
`CapabilityBinding` whose credential fields are branded rather than plain
strings — so a raw string cannot be substituted for a checked locator anywhere
downstream. The protobuf records in `data-models/` are the wire form; these
parsed types are narrowings of them.

## Rotation and identity

A binding rotates independently of the logical resource it points at: the same
`resourceRef` survives a credential rotation, which is what makes post-claim
rotation possible without rebinding every consumer. Expiry is only representable
alongside renewal or rotation support, because an expiring binding with neither
strands its workload.

## Event architecture

Binding resolution is pure and owns no aggregate. Rotation and revocation are
driven as commands into the claim coordinator actor in `@hobo/claims`, which
appends `CapabilityBindingRotated` and related events to the durable event
store. Projections over that stream produce the materialized view the site
renders, snapshots back the read store used for current status, and the receipt
records which connectivity implementation was chosen for each edge.

## Binding resolution

`resolution.ts` owns the record that says which product and which connectivity
implementation satisfy a capability profile inside a given Yard (ADR-0157). The
Yard is the binding authority: its binding rows are hard filters over ADR-0151
selection, never a ranking input. `BindingResolution` is the decision record
that falls out — Yard, profile, product, connectivity, realization
(`native` / `pack` / `bridge`), the canonical Yard binding row keys that
constrained the outcome, and how many candidates were considered.

`parseBindingResolution` is the parse boundary; `yardBindingRowKey` builds a
canonical row key from the same `(profile, productId, connectivityId)` tuple
`@hobo/yards` canonicalizes rows by, and `canonicalizeAppliedRows` sorts and
deduplicates a collection of them so authoring order can never become signal.
A resolution that considered zero candidates is refused: something was chosen,
so something existed to choose from.

## The `binding.*` event family

Exactly three facts, and the two absences are load-bearing:

| Fact | When | Carries |
|---|---|---|
| `binding.Resolved` | plan phase, per workload edge | the parsed `BindingResolution` |
| `binding.Projected` | **deploy time**, per wired binding | Yard, alias, binding profile ref, connectivity, projection kind |
| `binding.Unavailable` | fail-closed refusal | Yard, profile, code, remediation, considered count |

- **There is no `binding.Declared`.** Yard binding row state rides
  `yard.Registered`, so row state is never duplicated into a second stream.
- **Per-activation client construction emits nothing.** `binding.Projected`
  records deploy-time wiring only. Building the typed `ctx.bindings.<alias>`
  client during an ADR-0158 `init` is a hot path, and a control-plane write per
  activation would cost latency while describing wiring that was already
  recorded at deploy time.

`bindingUnavailable` cannot be constructed without remediation text —
`BINDING_UNAVAILABLE_REMEDIATION` holds the canonical, human-actionable string
for each of `YARD_BINDING_PRODUCT_UNKNOWN`, `YARD_BINDING_PROVIDER_MISMATCH`,
`YARD_BINDING_EXCLUDED_ALL`, and `NO_COMPATIBLE_BINDING`. A refusal without
remediation is a dead end for the operator, so the type system refuses to
produce one.

Every fact is frozen at both levels, copies incoming arrays, carries its own
name, and is screened for secret-shaped values through the same
plaintext-credential detector `parseSecretRef` uses — an event stream is the
most widely replicated surface in the system.

## Contracts

- `data-models/bindings.proto` / `.cue` — records plus the invariants that keep
  credentials out of endpoint metadata.
- `data-models/binding_resolution.proto` / `.cue` — the resolution record and
  the three event records, with the considered-count and remediation invariants
  as constraints rather than prose.
- `contracts/pacts/connectivity-binding.pact.json` — the producer/consumer
  boundary, including rejection with `BINDING_UNAVAILABLE` when no compatible
  connectivity path exists rather than silently downgrading the workload.

## HONEST SCOPE

- This package is **pure records and parsers**. It resolves nothing. The
  selection that produces a `BindingResolution` lives in `packages/cloud`
  (`planner/profile-matching.ts`); this package owns only the shape of the
  answer and the facts that carry it, so the planner and the event log cannot
  drift apart.
- **Nothing here appends to an event store.** `bindingResolved`,
  `bindingProjected`, and `bindingUnavailable` return plain frozen facts. A
  runtime wraps them in the shared envelope and writes them; there is no
  transport, no ordering, and no delivery guarantee in this package.
- **`binding.Projected` is not emitted by anything yet at activation time, by
  design** — see above. If you are looking for a per-activation audit record of
  client construction, it does not exist and is not planned.
- Secret screening is **shape-based**, not authoritative. It catches connection
  strings, bearer tokens, PEM private keys, and common provider key prefixes. A
  credential that resembles an ordinary identifier will pass; the guarantee is
  defense in depth over the `secretRef`-only rule, not a substitute for it.
- The Yard binding row **grammar** (`YARD_BINDING_PROFILE_PATTERN` and the parse
  error codes) is owned by `@hobo/yards`. `parseYardBindingRowKey` checks the
  key's structure — three segments, a named profile, at least one constraint —
  and deliberately does not re-implement the profile-id regex, so there is one
  home for that grammar.
