# The authority service (L09)

The running authority of design §6.15 and §6.16: the HTTP service over
`EnrollmentAuthority`, its composition for both profiles from one
configuration record, the identity pieces it needs, and the
`hobo-fleet-authority` and `hobo-fleet-witness` binaries. Operations and the
status feed are L27's (`src/ops/`, `src/status/`).

## Layout

| Directory | What |
|---|---|
| `src/service/` | `routes.ts` (the route table: one `FleetApi` method per route, its auth modes, request building, protobuf JSON), `http.ts` (`createAuthorityHandler`: a fetch-style `Request` to `Response`), `page.ts` (the approval page), `device-flow.ts` (the dual-control refusal), `node.ts` (`serveAuthority` over `node:http`) |
| `src/compose/` | `assemble.ts` (`createEnrollmentAuthority` with its real parts and loops), `ranking.ts` (the projection's ranking for `report`, D59), `config.ts` (the configuration file), `profile.ts` (both profiles), `keys.ts` (key slots), `witness.ts` and `registry-changes.ts` (the witness) |
| `src/identity/` | `CredentialIssuer` (`issuer.ts`), `IdentityAssertionVerifier` (`assertions.ts`), `PrincipalDirectory` (`directory.ts`), `AccountCredentialVerifier` (`accounts.ts`), `PolicyEngine` (`policy.ts`), `PolicyDecisionRecorder` (`decisions.ts`) |
| `src/signin/` | The `oidc`, `github` and `atproto` sign-in providers, each off unless configured |
| `src/bin/` | `hobo-fleet-authority`, `hobo-fleet-witness` |

## Routes and auth

Every route of §6.15 is exactly one `FleetApi` method (41 routes) plus
`/healthz` and `/readyz` (ready once the registry projection has published
everything journalled when it started). Each route declares how it admits its
caller:

| Auth | Admits | Routes |
|---|---|---|
| `none` | anyone; credentials are not read | discovery, JWKS, `signin/start`, `signin/callback`, `signin/device` |
| `browser` | the `__Host-hobo-fleet-signin` cookie the callback set: an HMAC of the sign-in state under the session key replicas share | `GET` and `POST /approve/{state}` |
| `signin-key` | a DPoP proof; sign-in checks it is made with the key `signin/start` named | `signin/complete`, `signin/device/poll` |
| `identity-key` | a DPoP proof made with the request's `identity_jwk`; the proof in the body is enrollment's | `POST /members` |
| caller kinds | `authenticate` (L02), then the kind must be listed, else `forbidden` | every other route |

`signin/complete`, `signin/device/poll` and `signin/refresh` call the sign-in
part with the request's `DPoP` header (D56); the methods of
`EnrollmentAuthority` cannot carry it. A person token whose key signed in by
the device-code flow is refused enrollment into a `DUAL` fleet
(`fleet-policy`, rule `dual-control-device-code`), read from the journal
(`fleet.PersonSignedIn` names the state, `fleet.SignInStarted` the flow).

Errors are `FleetError` JSON with the status of §7.6. Bounds: 8 KiB URL,
256 KiB body (413), 30 s per call (`unavailable`). The only redirects are the
callback to the approval page and the approval to the CLI's loopback address.
Every API request is recorded on the status feed (`enrollment-api`, up when
the status is below 500).

O28 (`test/routes.test.ts`) runs every route as each of none, person, device,
account credential, workload OIDC token, self-minted token and DPoP key
mismatch: admitted cells are never refused for authentication, every other
cell answers 401 (`unauthenticated`, `proof-invalid`, `proof-replayed`) or
403 (`forbidden`).

## Composition

`assembleAuthority(deps)` builds `createEnrollmentAuthority` with
`createSignIn`, `createRecorder` (started), `createRegistryProjection`,
`createFleetCommands` in `mode: "authority"`, `createAuditChain` and
`checkClaim` wrapped to rank claimants from the fleet view the projection
publishes when the caller passes no ranking (D59). `tick` runs about once a
second (projection, audit chain, pending expiry), the status feed once a
minute.

`composeAuthority(config, adapters)` reads, from the secret store: the NATS
credentials, the `record-signing` slot (re-read every minute, so a rotation's
switch takes effect), the token ring (`loadSecretStoreKms`, reloaded every
minute), the browser-session key (created once), the sentinel credentials,
and the callout's xkey and scoped seeds. The incarnation is the pinned trust
record's `authority_incarnation`. Standalone journals to SQLite
(`createRuntimeLocalEventStore`); high availability to `FLEET_JOURNAL`
(`createJournalEventStore`). Every replica answers NATS auth callouts; a
refusal counts as an answered callout on the status feed, an unopenable
request as a failed one.

Tokens are RS256 JWTs through `JwtSvidIssuer`, signed with the ring's
`activeKeyId()` when offered, else the lowest-numbered `<prefix>#<n>` key
that still signs; the JWKS lists every key the ring holds. They carry the
incarnation; a token from before a restore is `incarnation-stale`.

## Configuration

One JSON file, the protobuf JSON of `FleetAuthorityConfig`
(`data-models/fleet_authority.proto`), shared with the operations. Defaults:
`profile` standalone, `secretPrefix` `hobo-fleet/<tenant>`, `dataDir` `data`
beside the file, `listen` `0.0.0.0:8443`, secrets `<secretPrefix>/nats-authority`,
`/nats-witness`, `/nats-sentinel`, `/callout-xkey`, `/session-key`. Sign-in
providers, directory entries, claim rules, pinned OIDC issuers, accounts and
overlay providers are lists; an absent list turns the feature off.

## Binaries

`hobo-fleet-authority --config <file>` and `hobo-fleet-witness --config
<file>` (`src/bin/`). The secret store is OpenBao (`secretStore`, with the
workload's token file). The package's `bin` entries are the coordinator's
(cascade delta). The witness binary composes and then refuses to run: its
co-signatures go to `fleet.audit.witness`, for which `@hobo/fleet-nats` has
no entry point yet (cascade delta to L08).

## Fallbacks

None taken (`fallbacks: []`).
