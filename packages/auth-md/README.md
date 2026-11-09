# @hobo/auth-md

The **auth.md agent-principal / delegated-authorization plane**: discovery of a
protected resource's agent policy, anonymous agent registration, identity
assertion verification, human claim, and the rotation/revocation that follows.

> **auth.md is agent identity, not infrastructure ownership.** Everything in
> this package exists to keep those two apart.

## CLI integration

The composed `hobo` binary exposes the agent plane independently of human
`hobo login` and infrastructure `hobo claim`:

```sh
hobo identity agent discover https://broker.example
hobo identity agent register agent.json
hobo identity agent status https://broker.example/ <registration-ref>
hobo identity agent token https://broker.example/ <registration-ref>
hobo up --broker https://broker.example --anonymous
hobo identity agent claim https://broker.example/ <registration-ref>
# Approve the returned claim URL in a human browser, then poll.
hobo identity agent poll https://broker.example/ <registration-ref>
hobo claim <account> --broker https://broker.example --token <infrastructure-claim-token>
hobo identity agent rotate https://broker.example/ <registration-ref>
hobo identity agent revoke https://broker.example/ <registration-ref>
```

`agent.json` supplies the exact requested scope and authorization binding:

```json
{
  "resource": "https://broker.example/",
  "binding": {
    "sessionId": "session-1",
    "tenantId": "tenant-1",
    "projectId": "my-app",
    "audience": "broker-api",
    "service": "https://broker.example/"
  },
  "requestedScopes": ["deploy:write"]
}
```

For deployment, `projectId` must match the bindle name or `HOBO_PROJECT`;
`HOBO_TENANT` can select the intended tenant. Multiple matching registrations
are refused. The broker advertises its protected resource metadata through
`resourceMetadataUrl`; its placement endpoint must fall inside that resource.
All endpoints can be self-hosted. A network broker remains an explicit choice.
Identity lifecycle commands use standard protected-resource metadata first. If
that document is absent (HTTP 404 or 410), they rediscover the selected broker's
advertisement and follow its same-origin HTTPS `resourceMetadataUrl`. Malformed
or denied standard metadata fails closed; a changed registered resource is
refused. The HTTPS product test exposes only the custom metadata endpoint.

The authorization server must advertise `private_key_jwt` and a supported
signing algorithm in its OAuth authorization-server metadata. The CLI signs a
short-lived, unique, token-endpoint-bound assertion with the registered key,
then sends the server-issued scoped access token to placement. Private keys
are never used as bearer tokens. `token` verifies the exchange and returns only
references and expiry. TLS and redirect checks remain enabled.

Registrations, keys, and claim-poll material persist under
`$HOBO_HOME/auth-md/registrations` in owner-only files. Public results and durable
`authmd.*` facts contain references, scopes, and binding information, without
credential material. Human login and infrastructure ownership do not change
when an agent registers or completes its principal claim. After a recorded
infrastructure claim, management requires a human-bound agent and any required
key rotation. Rotation and revocation use the endpoints advertised by the
registration; rotation proves the replacement key through a fresh token
exchange before reporting success. Revoked references cannot be reused by a
new local registration.

`packages/hobo/test/auth-md-https.test.ts` proves discovery, registration,
actual signed-key token exchange, protected broker placement, independent
claims, scope refusals, rotation, and revocation against a local HTTPS server.

## Three independent state machines

HoBo tracks three things that are easy — and dangerous — to conflate. This
package models them as three separate machines in
[`src/state-machines.ts`](src/state-machines.ts), advanced by separate commands
and composed only in a read-only `PlaneSnapshot`. **Success in one never
implies another.**

| Machine | States | Advanced by |
|---|---|---|
| Human HoBo session | `anonymous` → `authenticated` | the human signing in |
| Agent principal | `unregistered` → `pre-claim` → `human-bound` \| `revoked` | registration, human claim, revocation |
| Infrastructure | `temporary` → `owner-controlled` \| `expired` | the owner claiming (or abandoning) the resources |

What that rules out, concretely:

- An authenticated human does **not** make a pre-claim agent human-bound.
- A human-bound agent does **not** make infrastructure owner-controlled.
- Owner-controlled infrastructure does **not** re-grant a revoked agent
  anything — it is precisely what makes rotation mandatory
  (`rotateAfterInfrastructureClaim`, enforced by `assertManagementAccess`).
- The safe outcome **"the work is claimed by the human, and the pre-claim agent
  is revoked"** is a first-class, representable, tested state
  (`isWorkClaimedByHumanWithRevokedAgent`).

## Metadata beats prose

Discovery reads two documents:

1. `/.well-known/oauth-protected-resource` — OAuth Protected Resource Metadata.
   **Machine-authoritative.**
2. `/auth.md` — the agent-readable companion document. **Advisory.**

When they disagree, the structured metadata wins. That is enforced structurally,
not by convention: every effective field on `AuthMdDiscovery`
(`effectiveScopes`, `anonymousRegistrationSupported`) is computed from the
metadata record, and prose disagreements surface as `conflicts` entries tagged
`authority: "metadata"`. A `/auth.md` file promising `admin:all` or promising
anonymous registration changes nothing about what this package will do.

## Security properties (all covered by tests)

- **No material in returned values, errors, or fixtures.** Assertions, claim
  tokens, private keys, and access tokens live in a `SensitiveRef` whose
  material is held in a module-private `WeakMap` — never an own-property — so
  `JSON.stringify` yields `"[redacted]"`. `formatRedacted` is the defence-in-depth
  formatter for everything else; `AuthMdError` scrubs its own message and details.
  `redactText` keeps line breaks and length; its private-key and JWT patterns are
  the shared linear ones from `@hobo/core/provider-redaction`.
- **Pre-claim authorization is bound to four things at once**: session, tenant/project,
  audience, and the exact service (`SessionBinding`, `assertBindingMatches`).
- **Post-claim scopes never silently widen.** Anything above the pre-claim set
  requires an explicit `HumanAuthorization` naming those scopes; otherwise
  `AUTHMD_SCOPE_WIDENING_DENIED`.
- **Rotation is forced after an infrastructure claim.** Management access fails
  closed with `AUTHMD_ROTATION_REQUIRED` until `rotateAgentCredentials` runs.
- **Transport is fenced**: injected `fetchImpl` only (never global fetch in
  production paths), HTTPS-only, byte-bounded, deadline-bounded, and
  cross-host redirects are refused.

## Error codes

`AUTHMD_DISCOVERY_FAILED`, `AUTHMD_METADATA_INVALID`,
`AUTHMD_REGISTRATION_UNSUPPORTED`, `AUTHMD_ASSERTION_INVALID`,
`AUTHMD_CLAIM_EXPIRED`, `AUTHMD_SCOPE_WIDENING_DENIED`,
`AUTHMD_ROTATION_REQUIRED`, `AUTHMD_REVOKED`.

## Architecture

Parse, don't validate: untrusted provider JSON and prose cross exactly one
parser boundary in [`src/types.ts`](src/types.ts) and
[`src/discovery.ts`](src/discovery.ts) and become branded parsed domain types
(`HttpsUrl`, `Scope`, `Instant`, `RegistrationRef`, `SessionBinding`). Nothing
downstream re-checks a string.

The library's agent-principal actor appends refs-only `authmd.*` facts to an
event store; `foldAgentPrincipalEvents` materializes their public view. The
composed CLI uses the same registration, claim, token, and lifecycle primitives
and appends those facts to a stream scoped by tenant, project, resource, and
registration reference. Its owner-only custody record persists the keys and
claim-poll material required across CLI processes, together with the parsed
principal and deployment bindings. Status reads that private record through
the domain parsers. Public event replay never reconstructs key material.

Wire forms and their constraints live in
[`data-models/auth_md.proto`](data-models/auth_md.proto) and
[`data-models/auth_md.cue`](data-models/auth_md.cue); the boundary is pinned by
[`contracts/pacts/auth-md-protected-resource.pact.json`](contracts/pacts/auth-md-protected-resource.pact.json).

## Ports you must inject

| Port | Why it is injected |
|---|---|
| `HttpPort.fetchImpl` | production paths never close over global fetch; tests run fully offline |
| `AssertionVerifier` | this package invents no cryptography and ships no JWT/JWKS dependency (the repo has none). Bind a real verifier in deployment; `createFixtureAssertionVerifier` is the offline HMAC stand-in for tests |
| `RotationPort` | credential lifecycle belongs to the identity plane, not here |

## Usage

```ts
import {
  discoverAuthMd,
  registerAnonymousAgent,
  initiateHumanClaim,
  pollHumanClaim,
  toAgentPrincipalClaimRef,
  parseScopes,
  parseSessionBinding,
} from "@hobo/auth-md";

const port = { fetchImpl: fetch };
const discovery = await discoverAuthMd({ port, resource: "https://api.example.com" });

const registration = await registerAnonymousAgent({
  port,
  discovery,
  binding: parseSessionBinding({
    sessionId,
    tenantId,
    projectId,
    audience: "https://api.example.com/",
    service: "https://api.example.com/",
  }),
  requestedScopes: parseScopes(["repo:read"]),
});

const initiation = await initiateHumanClaim({
  port,
  registration,
  requestedPostClaimScopes: parseScopes(["repo:read"]),
});
// show initiation.claimUrl to the human, then poll
const result = await pollHumanClaim({ port, initiation, registration });
if (result.status === "claimed") {
  const claimRef = toAgentPrincipalClaimRef(result.principal);
}
```

## Testing

```bash
pnpm --filter @hobo/auth-md run build
pnpm --filter @hobo/auth-md run test
```

Transport deadlines remain active while reading the response body. The stalled-body
regression checks cancellation after headers, alongside successful streaming reads.

Tests include bounded transport fixtures and real self-hosted HTTPS exchanges
with Ed25519, ES256, and RS256 assertions. The composed CLI lifecycle proof is
`packages/hobo/test/auth-md-https.test.ts`. These checks require no hosted broker,
relay, identity service, or cloud account.

## Sources

The protocol semantics above were taken from the official auth.md material,
**checked 2026-08-08**:

- <https://workos.com/auth-md/docs/flows/claimed> — claimed (human-bound) flow
- <https://workos.com/auth-md/docs/flows/anonymous> — anonymous agent flow
- <https://github.com/workos/auth.md> — the specification repository

HoBo is not affiliated with, endorsed by, or sponsored by WorkOS.
