# Architecture — `@hobo/adapter-infisical`

## Shape

```
JwtSource ──► InfisicalAuth ──► createInfisicalClient ──► createInfisicalSecretsPort (kind "infisical")
 (Vercel,       (oidc |            login, token cache,        access / accessVersion / put / listVersions
  GitHub,        universal-auth |   retries, parsing
  test fake)     access-token)
```

- `binding.ts` is the parser for the non-secret coordinates (site, project,
  environment, folder). Parse, don't validate: past it, code holds the derived
  types `ParsedInfisicalBinding`, `InfisicalSecretKey` and `InfisicalIdentityId`,
  never raw strings.
- `wire.ts` is the parser for Infisical's answers: JSON into the generated
  protobuf records, then narrowed to the parsed derived types `ParsedLogin`,
  `ParsedSecret`, `ParsedSecretName`.
- `client.ts` owns the only network I/O. It never logs.
- `secrets-port.ts` adapts the client to `@hobo/identity`'s `SecretsPort`.
- `secret-ref.ts` maps entries to the `infisical` SecretRef scheme.

## Events, commands and state

The adapter is a boundary client: it accepts no command, emits no events, and
owns no event store, actor, projection (materialized view), snapshot or read
store. Its only state is the access token in process memory. The history of
the relay's configuration is Infisical's own secret versioning, which the
relay treats as an external read store; the relay's runtime-config loader in
`@hobo/ci-vercel` keeps an in-memory snapshot of it with a TTL. `secret.Accessed`
audit events stay the caller's (`@hobo/identity`), carrying references only.

## Failure model

| Situation | Behaviour |
|---|---|
| Workload token unavailable | `jwt-unavailable`, no request sent |
| Login refused (400/401/403) | `login-denied`, not retried |
| 401 on a request | one fresh login, then `unauthorized` |
| 403 / 404 / 400 / 422 | `forbidden` / `not-found` / `rejected`, not retried |
| 429, 5xx, transport failure | retried with backoff (`Retry-After` honoured, capped), then `rate-limited` / `unavailable` |
| 2xx with the wrong shape | `invalid-response` |
| Write held for approval | `approval-required` |
| Value not viewable by the identity | `value-hidden` |
