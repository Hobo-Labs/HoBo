# @hobo/adapter-better-auth

The default **self-hosted, full-featured** `hobo:auth` issuer adapter (ADR-0161).

HoBo's auth spectrum had a gap in the middle. At one end sits the thin built-in
issuer — passkey and email magic-link — which exists so `hobo dev` and an
air-gapped Camp can authenticate somebody with zero configuration. At the other
end sit the hosted IdPs (WorkOS, Auth0, Supabase Auth, Entra ID, Clerk). Between
them is what most self-hosters actually want: organizations, OAuth providers,
and real session management, with no SaaS dependency. Better Auth is the
TypeScript ecosystem's answer to that, and this package makes it a registered,
selectable adapter.

Nothing about ADR-0038's federate-and-verify model changes. Better Auth is an
**issuer**; verification stays on the existing JWKS/OIDC path with the unified
principal model.

## What is in here

- `ids.ts` — the contract id, adapter id, and the claims-mapping version every
  other module stamps itself with.
- `descriptor.ts` — `BETTER_AUTH_DESCRIPTOR`, the registry entry Matching
  selects on, plus the gate for the not-vendored runtime.
- `config.ts` — `parseBetterAuthConfig`, the authored-config parse boundary.
- `secret-locator.ts` — `parseBetterAuthSecretRef`, the locator-or-value
  decision, made once, at the edge.
- `claims.ts` — `mapClaimsToPrincipal`, the versioned claims to principal
  mapping.
- `claims-conformance.ts` — the executable case list that proves the mapping is
  total over what it accepts and refuses the rest.

## The bundle composes ports; it owns no private infrastructure

`BETTER_AUTH_DESCRIPTOR.requiredPorts` is the honest part of the descriptor:

| Port | Why |
|---|---|
| `hobo:data/relational` | The user, session, account, and organization tables live in the governed data plane and evolve through ADR-0160 gated migrations — not adapter-private DDL. |
| `hobo:secrets` | The signing secret is brokered custody (ADR-0113). The app holds a locator; it never holds the material. |
| `hobo:http` | Routes mount at `${basePath}/*` on the declared `api()`/`web()` surface. |

A Camp that cannot satisfy one of the three refuses the adapter at plan time
rather than failing at first login.

## The secret is brokered, and that is a deliberate divergence

Alchemy's Better Auth integration generates a random signing secret and persists
it into its own state file. HoBo does not. `parseBetterAuthConfig` accepts a
`secretRef` **locator** — `scheme://authority/path` in a registered custody
scheme — and refuses anything that reads as a value: connection strings, bearer
tokens, PEM private keys, JWTs, embedded userinfo, and bare opaque strings with
no scheme at all. A key named `secret`, `password`, `token`, `apiKey`, or
`privateKey` anywhere in the config is refused as an inline secret rather than
reported as a typo, because it almost never is one. Rejected input is never
interpolated into the error message — a rejected "reference" is frequently a
live credential, and an error message is a log line.

## Parse, don't validate

`parseBetterAuthConfig`, `parseBetterAuthSecretRef`, and `mapClaimsToPrincipal`
are the three parse boundaries. Each takes `unknown` and returns a frozen,
derived domain type — `BetterAuthConfig`, the branded `BetterAuthSecretRef`, and
`MappedPrincipal` — or throws a typed error with a `code` and remediation text.
There is no partially-parsed intermediate a caller can observe and no boolean
`isValid` anywhere in the package. Because the derived types are the ones the
rest of the platform plans against, a raw authored literal cannot be substituted
for a checked one downstream. The protobuf records in `data-models/` are the
wire form; these parsed types are narrowings of them.

Refusals are structural, not defensive. Unknown config keys and unknown claims
are rejected rather than dropped, because a silently ignored option reads as a
supported one.

## The claims mapping is versioned because a swap depends on it

ADR-0073 requires the claims to roles/tenancy mapping to be an explicit,
versioned, conformance-tested part of every IdP adapter. The reason is
concrete: when a Yard's issuer is swapped, group and role claim shapes differ
across providers, and an implicit mapping would silently drop or remap the
claims that populate a principal's roles.

So `mapClaimsToPrincipal` states its accepted vocabulary as exported data
(`BETTER_AUTH_ACCEPTED_CLAIM_KEYS`), maps it totally, refuses everything else
with a typed code, and stamps every principal it produces with
`claimsMappingVersion`. `BETTER_AUTH_CLAIMS_CONFORMANCE_CASES` is the executable
baseline: pass a candidate mapping to `runClaimsMappingConformance({ map })` to
check a replacement issuer against it before swapping on a live Yard. Two tests
assert the case list covers every accepted claim key and every refusal code, so
adding either without adding a case fails the build.

The mapping is pure. Roles are deduped and sorted, optional fields are omitted
rather than set to `undefined`, and no clock is consulted — `exp`, `nbf`, and
`iat` are checked for shape only. Signature checking, issuer trust, and expiry
belong to the verification path, not here.

```ts
import {
	BETTER_AUTH_DESCRIPTOR,
	mapClaimsToPrincipal,
	parseBetterAuthConfig,
} from "@hobo/adapter-better-auth";

const config = parseBetterAuthConfig({
	basePath: "/api/auth",
	secretRef: "hobo-secret://camp-prod/auth/better-auth-signing-key",
	database: { profile: "data.relational/v1" },
	organizations: { enabled: true },
	socialProviders: ["github", "google"],
});

const principal = mapClaimsToPrincipal(verifiedClaims);
//    ^ { subject, issuer, email?, organizationId?, roles, claimsMappingVersion }
```

## Event architecture

This package is pure and owns no aggregate. It issues no command, appends
nothing, and holds no state between calls.

Its records are what other components write down. Registering or swapping this
adapter on a Yard is a command handled by the identity actor, which appends the
resulting governance fact to the durable event store; auth itself rides the
existing `user.*` / `session.*` event family (ADR-0073 adds no new one).
Projections over that stream build the materialized view the read store serves
for "which issuer is live on this Yard, at which claims-mapping version", with
snapshots backing current status. `claimsMappingVersion` on every mapped
principal is what lets those projections answer that question honestly across an
issuer swap.

## Contracts

- `data-models/better_auth.proto` / `.cue` — the descriptor, config, principal,
  and refusal records, with the locator-only and version-required invariants as
  constraints rather than prose.
- `contracts/pacts/better-auth-issuer-boundary.pact.json` — the adapter
  boundary, including four refusal interactions (inline secret, missing
  `basePath`, unmapped claim, gated runtime).

## HONEST SCOPE

Read this before assuming what the package does.

- **This is not a running auth server, and `better-auth` is not a dependency.**
  ADR-0161's non-goals say it plainly: the implementable surface is the
  registered adapter descriptor, the config parse, the versioned claims to
  principal mapping, the declared port requirements, and the conformance suite
  that proves the mapping. Nothing here serves a login page, issues a session,
  writes a user row, or signs a token.
- **Runtime execution is declared and gated, never simulated.**
  `assertBetterAuthRuntimeAvailable` refuses with
  `BETTER_AUTH_RUNTIME_UNAVAILABLE` and remediation naming the missing package.
  It does not fall back to the thin built-in issuer, because a silent downgrade
  would change who can log in without saying so. Runtime presence is supplied by
  the caller rather than probed, so the check stays pure — this package performs
  no module resolution, filesystem access, or network I/O anywhere.
- **No schema, no migration, no route mounting is implemented here.** The
  descriptor *declares* that the bundle needs `hobo:data/relational`,
  `hobo:secrets`, and `hobo:http`. Provisioning the store, running the ADR-0160
  gated migrations that create Better Auth's tables, brokering the signing
  secret, and mounting `${basePath}/*` are all the host's work. This package
  contributes the declaration, not the mechanism.
- **The claims vocabulary is Better Auth's, and it is deliberately closed.**
  Thirteen claims are accepted; everything else is refused. An Entra `groups`
  claim or an OAuth `scope` claim is a refusal, not a passthrough. Widening the
  vocabulary is a new `claimsMappingVersion`, by design.
- **The inline-secret screen is shape-based, not authoritative.** It catches
  connection strings, bearer tokens, PEM keys, JWTs, common provider key
  prefixes, embedded userinfo, and scheme-less strings. A credential that
  happens to look like an ordinary URI locator in a registered scheme will pass.
  The guarantee is defense in depth over the locator-only rule, not a substitute
  for it.
- **`MappedPrincipal` carries one field beyond the shared mapped-principal
  shape**: `claimsMappingVersion`. It is added last, deliberately, so the
  ADR-0073 obligation is visible on the record itself rather than only on the
  adapter descriptor. Consumers reading `subject` / `issuer` / `email` /
  `organizationId` / `roles` are unaffected.
- **The PACT contract is not verified by an executing provider.** The interaction
  bodies are asserted by this package's unit tests against the same parse
  boundaries; `contracts/pact-inventory.md` records the status as `pact_only`
  rather than claiming provider verification.
- **The registered secret-ref scheme list is mirrored from `@hobo/bindings`, not
  imported.** Adapters may not depend on layer-3 packages, so the vocabulary is
  duplicated and pinned by a test. If `@hobo/bindings` adds a scheme, this list
  must be updated by hand and the test will not catch the omission — only the
  drift within this package.
