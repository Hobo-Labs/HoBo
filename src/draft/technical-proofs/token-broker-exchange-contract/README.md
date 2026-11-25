# Token Broker Exchange Contract

Source issue: HOBO-629.

Draft POC promoting S3-03 broker exchange scenarios from
[`identity-auth-secrets-cross-app-access-xaa`](../../epic-proofs/identity-auth-secrets-cross-app-access-xaa/README.md)
into an executable contract package. Exchanges an attested JWT-SVID for a short-lived,
resource-scoped provider token via OIDC federation using signed Capability Manifest `auth.json`,
with grace-window-only renewal and full `token.Granted` / `token.Used` / `token.Revoked` events.

Production promotion target: `packages/identity/src/broker/` (blocked on S3-02 / HOBO-628).

## Contract Surface

- `parseSvid` — parse-don't-validate boundary for attested workload SVID inputs.
- `createTokenBrokerExchange` — deep module with `exchange`, `renew`, and `revoke`.
- Exchange resolves signed `auth.json`, selects preferred OIDC federation flow (HOBO-48), and
  returns brokered credentials via a pluggable STS seam (mocked in this proof).
- Renewal is allowed only inside the signed grace window and refuses scope widening.
- Revocation emits validated `token.Revoked` identity events (HOBO-66).
- Typed denial codes: `svid-expired`, `scope-outside-svid`, `renewal-grace-expired`,
  `scope-widening-requires-live-identity`, `grant-revoked`.

## Acceptance Mapping

| HOBO-629 acceptance | Proof |
|---|---|
| SVID exchanged for short-lived resource-scoped provider token via OIDC federation + auth.json | Exchange test with Cloudflare fixture manifest and `oidc-federation` flow |
| Grace-window-only renewal | Renew inside grace emits `token.Used`; after grace → `renewal-grace-expired` |
| Full TokenGranted/TokenUsed/TokenRevoked events | Exchange + revoke tests assert validated identity events |
| Expired/over-scoped exchange refused with typed error | `svid-expired` and `scope-outside-svid` adversarial tests |
| Zero static secrets / brokered path | Credentials carry `brokered: true`; no plaintext in audit events |

## Adversarial Coverage

- Expired SVID denied before manifest lookup.
- Over-scoped request denied before registry/STS dispatch.
- Scope widening on renew denied with typed error.
- Revoked grant cannot renew.
- Audit events never contain token plaintext or secret fields.

## Verification

```bash
pnpm --prefix src/draft/technical-proofs/token-broker-exchange-contract test
```

## Architecture Evidence

- `architecture/` — protobuf data shapes and CUE constraints.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.

## Scope (out)

- Real `packages/identity` service wiring (S3-02).
- Live Cloudflare deploy (tracked at production slice; mocked STS here).
- S2-07 Executor integration (separate slice).
- Registry ingest (S3-04).
