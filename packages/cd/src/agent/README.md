# `@hobo/cd/agent` — agent enrollment, identity and HTTP transport (WP11: C10, D5, D19, I3, I24)

`createAgentEnrollment` implements the frozen `AgentEnrollment` port and
`createHttpTransport` the frozen `ReconcilerTransport` for `agent` mode
(`../ports.ts`). An agent runs inside the target boundary (`hobo deploy agent
run`), dials its Station's delivery feed (`../feed`) over outbound HTTPS only,
and keeps target credentials local. It replaces Plan 25's reverse-tunnel Relay
for delivery: nothing listens on the agent and the Station never connects to it.

## Lifecycle

```
operator  issueToken(campSet, campIds, mode, ttl)   governed reconciler.enroll → hcd_bt_… (shown once)
agent     POST /v1/cd/enrollments {token, publicJwk, claims}           → PENDING (or ACCEPTED by Rail auto-accept)
operator  approveKey(id)                             governed reconciler.approve-key   (grant 1)
operator  accept(id, campIds ⊆ token scope)          governed reconciler.accept        (grant 2, another principal
                                                                                         when separate_approvers)
agent     POST /v1/cd/svid/refresh {reconcilerId} + DPoP          → JWT-SVID with cnf.jkt (15 min)
agent     every request: Authorization: DPoP <svid>, DPoP: <proof>  (htm, htu, iat, jti, ath)
agent     POST /v1/cd/svid/refresh + SVID + DPoP     5 min before expiry → new SVID
operator  revoke(id)                                 governed reconciler.revoke → refused on the next request
```

## Event architecture

| Stream | Events | Body |
|---|---|---|
| `cd-reconciler-<id>` | `reconciler.EnrollmentRequested` | `ReconcilerRecord` (PENDING), public JWK, token scope Camps, claims, token hash |
| | `reconciler.KeyApproved`, `reconciler.Accepted` | grant principal, decision id, accepted Camps, `autoAcceptScope` |
| | `reconciler.Enrolled` | `ReconcilerRecord` (ACCEPTED) |
| | `reconciler.Revoked` | principal, reason, decision id |
| | `reconciler.SvidIssued` *(AGENT_EVENTS)* | SVID `jti`, expiry, `activate`/`refresh` (never the token) |
| `cd-bootstrap-<sha256(token)>` | `reconciler.BootstrapTokenIssued`, `reconciler.BootstrapTokenConsumed` *(AGENT_EVENTS)* | scope, mode, expiry, issuer / key thumbprint |
| `cd-dpop-<id>-<bucket>` | `reconciler.DpopProofAccepted` *(AGENT_EVENTS)* | idempotency key = DPoP `jti` |

- **Actors:** one per reconciler, one per token. Commands catch up from the
  journal and append with `expectedSeq` (CAS, retried), so Station replicas on
  one store agree; `verify` re-reads the stream, so revocation is effective on
  the next request on every replica.
- **Reconciler id** = `agent-` + first 32 hex of SHA-256(JWK thumbprint): one
  key, one reconciler; a revoked key can never re-enroll.
- **Single use** is a CAS on the token stream; a retry by the same key is
  idempotent, any other key gets `token-used`.
- **Replay store:** the journal's per-stream idempotency key is the jti record
  (atomic, shared by replicas). Proofs are valid for ±60 s, so streams are
  bucketed by `iat` (2 × skew) and old buckets are compaction-eligible.
- **Commands and events:** `issueToken`, `enroll`, `approveKey`, `accept`,
  `activate`, `refresh`, `revoke` are commands; each appends the events above
  to the durable event store (`DurableEventStore`, SQLite or Postgres), which
  is the only record.
- **Projection / read store:** the in-memory fold per reconciler is a
  materialized view rebuilt from the journal and caught up on every read; it
  is the read store `verify` uses. No snapshot is needed (a reconciler stream
  has a handful of events plus one per SVID).
- **Parse, don't validate:** `parsePublicJwk` → `PublicJwk` (EC P-256 or OKP
  Ed25519, never private material), `jwkThumbprint` → `JwkThumbprint`,
  `verifyDpopProof` → `VerifiedDpop`, `parseStationOrigin` → `StationOrigin`,
  `parseResolvedSet` → a digest-anchored `ResolvedDeploymentSet`.
- **Rails:** `separate_approvers` applies if any governing Rail sets it or has
  no `enrollment` block (default true, R14). Auto-accept applies only when
  every governing Rail lists the token's Camp set; it is recorded as
  `autoAcceptedByScope` and as `KeyApproved`/`Accepted` by
  `rail-auto-accept:<set>`.
- **Inventory:** activation/refresh report `CREDENTIAL_VALID=TRUE` (reason
  `expires-at:<RFC 3339>`), a failed refresh `FALSE` (`svid-refresh-failed`),
  revocation `FALSE` (`reconciler-revoked`), all as source `STATION`. A
  forged SVID never triggers a report (only signature-valid expired SVIDs do).

## Agent egress (promoted `hobo-relay-contract`: auth, SSRF, deny-by-default)

`parseStationOrigin` refuses non-HTTPS, userinfo, query/fragment, paths,
metadata endpoints (169.254.169.254, fd00:ec2::254, metadata.google.internal)
and link-local/unspecified literals. Every request goes through `@hobo/core`
`guardTransport` with the one Station host and the `/v1/cd/` prefix (no
redirects, bounded body and time, encoded separators refused). Tests:
`test/agent/relay-promoted.test.ts`.

## Telemetry

`hobo.cd.agent.tokens_issued`, `.enrollments` (`state` or `refused`),
`.grants` (`grant`), `.grant_refusals` (`code`), `.svids_issued` (`kind`),
`.refresh_failures` (`code`), `.verify_refusals` (`code`), `.revocations`,
`.inventory_report_failures`. Advisory: a failing sink never fails a command.

## Typed failures

`AGENT_FAILURES` (`errors.ts`) maps every code to an HTTP status and a
remediation: `token-invalid|expired|used|scope-invalid|ttl-invalid`,
`mode-invalid`, `jwk-invalid`, `claim-invalid`, `key-already-enrolled`,
`key-revoked`, `reconciler-unknown`, `reconciler-revoked`,
`enrollment-incomplete`, `separate-approvers-required`, `camp-out-of-scope`,
`proposal-only`, `policy-denied`, `svid-required|invalid|expired`,
`dpop-required|invalid|method-mismatch|url-mismatch|stale|ath-mismatch|replayed|key-mismatch`,
`store-unavailable`, `egress-refused`, `station-unavailable`, `response-invalid`.

## Gates

TypeScript (package typecheck); protobuf (`ReconcilerRecord`,
`CampClaimRecord`, `CampConditionRecord`, `DeliveryFeedFrame` via generated
schemas); PACT (`contracts/feed.pact.json`, verified by
`contracts/feed.pact.test.ts`); CUE: none owned here (records are constrained
by the frozen proto; WP21/coordinator may add `agent.cue`).

## Runbook

- **Agent stuck PENDING.** Read `cd-reconciler-<id>`: which of
  `KeyApproved`/`Accepted` is missing? Grant it as a principal the policy pack
  allows; under `separate_approvers` the two grants need different principals.
- **`enrollment-incomplete` at the feed.** Same as above; the feed refuses
  until both grants (or a matching Rail auto-accept) are recorded (I24).
- **`token-used` / `token-expired`.** Tokens are single-use, 1 h by default
  (max 24 h). Issue a new token; a retry with the same key after a network
  failure succeeds idempotently.
- **`dpop-stale`.** Agent clock is off by more than 60 s; fix NTP.
- **`dpop-replayed` bursts.** A proxy is retrying requests verbatim; disable
  request replay in the proxy. The agent mints a fresh proof per request.
- **`svid-invalid` after a Station restart or on another replica.** The
  Station replicas must share one SVID issuer key (compose `issuer`); with the
  default process-local key, agents re-activate by key possession
  automatically.
- **`hobo.cd/credential-invalid` taint.** See the inventory reason:
  `svid-refresh-failed` (check issuer and clock), `reconciler-revoked`
  (expected after revoke), or an expiring SVID (agent stopped refreshing —
  restart it).
- **Key compromise.** `revoke(id)`; the next request from that key is
  refused everywhere. Enroll a new key with a new token; the old key can never
  re-enroll.
- **`egress-refused` at agent start.** The configured Station URL is not an
  HTTPS origin, carries credentials/paths, or points at a metadata or
  link-local address. Fix `--station`.
