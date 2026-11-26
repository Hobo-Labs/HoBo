# S3-02 @hobo/identity draft POC (HOBO-628)

Draft traceability copy of the S3-02 identity slice. **Production code will live in
`packages/identity/` (`@hobo/identity`).** This tree proves attested-workload JWT-SVID
issuance, rotation, OIDC provider surfaces, and `identity.*` audit events as an
independent POC without importing unmerged blocker code.

## Scope

- Workload attestation intake → JWT-SVID issuance (`identity.Issued`) via parse-don't-validate derived types
- SVID rotation inside renewal grace (`identity.Rotated`)
- Rotated JWT-SVID preserves original audience claim (broker vs gateway)
- OIDC discovery + JWKS verification for Gateway auth
- Protobuf + CUE `data-models/` for identity records
- PACT boundary contract for `@hobo/gateway` consumer

## Out of scope

- Token broker / provider STS exchange (S3-03)
- Production `packages/identity/` workspace (follows S3-01 M0 acceptance merge)
- Real KMS/HSM, HTTP serving, HA broker cache

## Validation

```bash
pnpm --prefix src/draft/projects/s3-02-hobo-identity test
pnpm run test:file src/draft/projects/s3-02-hobo-identity/test/acceptance.test.ts
```

## Architecture evidence

- `data-models/` — protobuf + CUE constraints for attestation binding, SVID records, identity events
- `contracts/identity-boundary.pact.json` — Gateway ↔ Identity boundary pact
- `ADR.md` — parse-don't-validate and identity event evidence

## Promotion path

Promotes attested-workload SVID flows from
`src/draft/epic-proofs/identity-auth-secrets-cross-app-access-xaa/` into
`packages/identity/` when S3-01 acceptance record merges. Keep draft and production
trees aligned after promotion.

## Design refs

- [Plan 06 — Agent identity & token broker](../../../docs/design/ai-native-agent-auth.md#plan-06)
- [ADR-0023 — Key TTL / rotation](../../../docs/design/adr/02-identity-security.md#adr-0023)
