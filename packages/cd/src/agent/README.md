# `@hobo/cd/agent` — reconciler enrollment over the fleet and the agent HTTP transport (WP11, L19: C10, D5, D19, I3, I24)

`createAgentEnrollment` implements the `AgentEnrollment` port and
`createHttpTransport` the `ReconcilerTransport` for `agent` mode
(`../ports.ts`). An agent runs inside the target boundary (`hobo deploy agent
run`), dials its Station's delivery feed (`../feed`) over outbound HTTPS only,
and keeps target credentials local. Nothing listens on the agent and the
Station never connects to it.

Since L19 (ADR-0183) a reconciler is a **fleet `DEVICE` with role
`RECONCILER`** in the fleet named after its Yard. `@hobo/fleet` holds its
identity: the single-use `hft_` bootstrap token, the identity and SIGN keys,
the key bundle, the member SVID, DPoP proofs and their replay store, and
revocation. This module keeps what is delivery policy: the Camp-set scope of a
token, the two grants with Rail rules, governance through the delivery
authorizer, and the accepted Camps. It defines no JOSE or DPoP code of its own
(O23); proofs are minted with `@hobo/fleet/keys` `mintDpopProof` and verified
by the fleet's `authenticate`.

## Lifecycle

```
operator  issueToken(campSet, campIds, mode, ttl)   governed reconciler.enroll → fleet TokenCreateRequest (role
                                                     RECONCILER, 10–30 min) → hft_… (shown once)
agent     POST /v1/cd/enrollments {request: EnrollmentRequest, campIds} + DPoP   forwarded to the fleet `enroll`
                                                     → PENDING (or ACCEPTED by Rail auto-accept)
operator  approveKey(id)                             governed reconciler.approve-key   (grant 1)
operator  accept(id, campIds ⊆ token scope)          governed reconciler.accept        (grant 2, another principal
                                                                                         when separate_approvers)
station   both grants held                           fleet approve-key, then accept: the member is ACTIVE
agent     fleet `credentials` (hobo fleet run), or POST /v1/cd/svid/refresh {memberId, request} + DPoP
                                                     → member SVID (CredentialResponse)
agent     every request: Authorization: DPoP <member SVID>, DPoP: <proof by the SIGN key> (htm, htu, ath, jti)
operator  revoke(id)                                 governed reconciler.revoke → fleet revoke → refused next request
```

`hobo deploy agent token|enroll|approve-key|accept|run|revoke` are aliases of
`hobo fleet token create|enroll --token-file|member approve|member accept|run|member revoke`.
On the agent's host, `generateReconcilerKeys()` makes its identity (P-256),
SIGN (Ed25519) and SEAL (X25519) private JWKs, which stay there (written
`0600` under `--key-dir`), and `reconcilerEnrollment(...)` builds the
`EnrollmentRequest` (role RECONCILER, key bundle 1 signed by the identity key,
the bootstrap token as proof) and a bare DPoP proof by the identity key for
`<authority>/v1/fleet/members`. `agent enroll --token <value>` is refused
with `token-on-command-line`.

## Ports

`DeliveryFleet` (`../ports.ts`): `station` (issueToken, approveKey, accept,
revoke as the Station's principal), `forward(dpopProof)` (enroll and
credentials with the agent's own proof, never re-signed; the proof's `htu` is
the authority URL at `origin`) and `authenticate`. `remoteDeliveryFleet` builds
it over `@hobo/fleet/client` `createFleetClient`; `inProcessDeliveryFleet` over
an authority composed in the same process (tests use `createTestAuthority`).
Without a fleet every identity step refuses with `fleet-unavailable`.

## Event architecture

| Stream | Events | Body |
|---|---|---|
| `cd-reconciler-<memberId>` | `reconciler.EnrollmentRequested` | `ReconcilerRecord` (PENDING, `reconcilerId` = fleet member id), token scope Camps |
| | `reconciler.KeyApproved`, `reconciler.Accepted` | grant principal, decision id, accepted Camps, `autoAcceptScope` |
| | `reconciler.Enrolled` | `ReconcilerRecord` (ACCEPTED), appended after the fleet member is activated |
| | `reconciler.Revoked` | principal, reason, decision id |
| `cd-bootstrap-<sha256(token)>` | `reconciler.BootstrapTokenIssued` *(AGENT_EVENTS)* | scope, mode, expiry, issuer (never the token) |

Single use, key binding, SVIDs and DPoP replay are the fleet's; the journal
holds no token, key or SVID. Commands catch up from the journal and append
with `expectedSeq`, so Station replicas on one store and one fleet agree.

A reconciler whose token names one Camp is named after that Camp in the fleet,
so the Camp mapper (`../inventory`) finds the DEVICE backing it; any other is
named after its Camp set plus a random suffix.

## Inventory

A refresh reports `CREDENTIAL_VALID=TRUE` (reason `expires-at:<RFC 3339>`), a
failed refresh `FALSE` (`svid-refresh-failed`), revocation `FALSE`
(`reconciler-revoked`), all as source `STATION`.

## Agent egress (promoted `hobo-relay-contract`: auth, SSRF, deny-by-default)

`parseStationOrigin` refuses non-HTTPS, userinfo, query/fragment, paths,
metadata endpoints and link-local/unspecified literals. Every request goes
through `@hobo/core` `guardTransport` with the one Station host and the
`/v1/cd/` prefix (no redirects, bounded body and time). Tests:
`test/agent/relay-promoted.test.ts`.

## Telemetry

`hobo.cd.agent.tokens_issued`, `.enrollments` (`state` or `refused`),
`.grants` (`grant`), `.grant_refusals` (`code`), `.svids_issued` (`kind`),
`.refresh_refusals` (`code`), `.verify_refusals` (`code`), `.revocations`,
`.inventory_report_failures`.

## Typed failures

`AGENT_FAILURES` (`errors.ts`) maps every code to an HTTP status and a
remediation. Fleet failures keep the fleet code in the message; the ones with
a delivery meaning map to it (`token-used`, `token-expired`, `token-invalid`,
`key-known` → `key-already-enrolled`, `proof-invalid` → `dpop-invalid`,
`proof-replayed` → `dpop-replayed`, `member-revoked` → `reconciler-revoked`),
the rest are `fleet-refused`.

## Runbook

- **Agent stuck PENDING.** Read `cd-reconciler-<id>`: which of
  `KeyApproved`/`Accepted` is missing? Under `separate_approvers` the two
  grants need different principals. The fleet member stays PENDING (and gets
  no SVID) until both are held.
- **`fleet-refused` on a grant.** The Station's fleet principal could not
  approve or accept the member; `hobo fleet member list` shows its state.
- **`token-used` / `token-expired`.** Fleet tokens are single-use and live 10
  to 30 minutes. Issue a new token.
- **`dpop-invalid` / `dpop-replayed`.** The proof is not by the member's SIGN
  key or was reused; the agent mints a fresh proof per request.
- **Key compromise.** `revoke(id)`; the fleet refuses the member on the next
  request everywhere. Enroll a new device with a new token.
