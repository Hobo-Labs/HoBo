# Enrollment and credentials (L02)

`createEnrollmentAuthority(deps, parts)` is the authority's command side for
members and bootstrap tokens (design §6.5, §6.6, §6.13, §7.5). It implements
the member and token methods of `FleetApi` itself and routes the rest to
`AuthorityParts`: sign-in to `parts.signIn`; fleets, sessions, work
submission, views and verdicts to `parts.fleets`; work status and logs to
`parts.recorder`; `tick` runs `parts.projection.tick` and `parts.audit.tick`
after rejecting PENDING enrollments whose bootstrap token has expired.

## State

The only state is the `FleetEventStore`. Each instance folds the three
streams it writes from `readAll` (incrementally) into an index; commands read
the index, decide, and append with `expectedSeq`, retrying up to 8 times on a
lost compare-and-set. Any number of instances on one store agree, and a fresh
instance rebuilt by replay equals a live one (both property-tested).

| Stream | Events | Single-use rule |
|---|---|---|
| `fleet-token-<sha256>` | `TokenIssued`, `TokenConsumed`, `TokenRevoked` | consumption is a compare-and-set at the token stream's head |
| `fleet-thumbprint-<thumbprint>` | `ThumbprintBound` | appended at `expectedSeq: 0`; a key bound to another member is `key-known` |
| `fleet-member-<MemberId>` | the 16 member events of §7.5 | each transition appends at the member stream's head |

Event `data` carries `subject` (the registry key `member.<id>`, else the
stream id), `subjectSequence` (the record's `record_sequence` after the
event, 0 for events that do not change the record) and, for record-changing
events, `record`: the protobuf JSON of the whole `MemberRecord` after the
event, without `issued_at`, `not_after` and `authority_incarnation`. A
projection replays the registry by taking each stream's last `record`; the
audit chain takes `subject` and `subjectSequence` for `AuditEntry`.
Nothing secret is journalled: tokens and refresh nonces only as SHA-256,
credentials only as the session ticket id.

## Proofs and approval

- **Bootstrap token** (`hft_` + 43 base64url characters, shown once): scoped
  to one fleet and name; the inviter is the owner.
- **Person token**: verified by the authority's own `CredentialIssuer` (a
  self-minted token never verifies) and accepted only when its DPoP binding
  (`cnf.jkt`) is the request's identity key; otherwise `proof-invalid`.
- **OIDC assertion**: audience `<issuer>#<identity thumbprint>`, a matching
  `oidc_trust` rule, the assertion id used once (`ReplayStore`); EPHEMERAL at
  `T3_PLATFORM_IDENTITY`, ACTIVE at once.

Possession of the identity key is its signature on the key bundle. Tier T2
comes from `verifyCertificateChain` against the fleet's roots, T1 from
`held_key`, T0 otherwise. `AUTO_OWNER` activates at once only when the
inviter is the fleet's owner; `SINGLE` needs approve-key then accept;
`DUAL` needs them from two principals (`fleet-policy`, rule
`dual-control`). Empty `allowed_kinds`, `allowed_roles` and
`allowed_classes` place no restriction.

## Credentials and clone detection

`credentials` answers a request at the current generation and advances it;
repeats the answer (same new generation, nothing appended) for the previous
generation with the same nonce digest; and otherwise appends
`MemberLocked` and answers `generation-mismatch` with
`detail.generation`, the generation the authority holds (the client's pact
names it; L42). `unlock` resets the
generation. O6 (`test/membership/generation.test.ts`) checks the lock on the
second divergent refresh and zero locks over 1,000 randomised lost-response
retries across two replicas.

## authenticate

`DPoP <jwt>`: a member SVID or person token from this issuer, with a DPoP
proof (method, URL, `ath`, fresh `jti`) by the token's key; a member token is
refused as soon as the member is not ACTIVE. `Bearer <x>`: an account
credential, else a workload OIDC token. No `Authorization` with a DPoP proof
by an enrolled device's SIGN key: that device (how `credentials` is reached
before the device holds an SVID).

## Known gaps (reported to the coordinator)

- `signInComplete`, `signInPoll` and `signInRefresh` cannot pass the DPoP
  proof to `parts.signIn`, because `FleetApi` methods take only
  `(request, caller)`; they pass `""`. The HTTP service should call the
  sign-in part directly for these three routes, or the contract should add
  the proof.
- `ById<K>`'s default `Empty` makes the by-id requests (`getMember`, `leave`,
  `revokeToken`, `workStatus`, `workLogs`, …) unsatisfiable by an object
  literal; tests build them through one commented assertion.
- `report` passes `ranked: []` to `checkClaim`: no ranking entry point is
  frozen, so `claim-early` evidence is only as good as `checkClaim` without a
  ranking.
- The device-code refusal for `DUAL` fleets belongs to sign-in: the
  enrollment request does not say which flow minted the person token.
- `incarnation-stale` (L41, L42): when the verified token carries an
  `incarnation` claim (L09's `JwtSvidIssuer` mints one), it decides: a claim
  below `deps.incarnation` is `incarnation-stale`. Otherwise `authenticate`
  falls back to comparing the token's `iat` with the time the current
  incarnation began: the `issued_at` of the earliest journalled
  `fleet.TrustRotated` record (stream `fleet-trust`, `data.record`) naming
  `deps.incarnation`, counted only when it raised the incarnation (above the
  genesis incarnation 1, or above an earlier journalled record). An earlier
  `iat` (whole seconds) is `incarnation-stale`; before any restore nothing
  is. An issuer's own `incarnation-stale` refusal is passed through as it
  is, never rewrapped as `unauthenticated`. `credentials` applies the same
  rule again to a caller `authenticate` answered from a token (its claims
  remembered per `VerifiedToken` object), so a token checked before a
  restore is refused after it; a SIGN-key-proof caller holds no minted token
  and refreshes. Session tickets are never presented to these routes; the
  NATS callout refuses a ticket of another incarnation (L08).
