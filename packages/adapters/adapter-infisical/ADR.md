# ADR — `@hobo/adapter-infisical`

## Status

Accepted (phase 3 of ADR-0179 (`docs/design/adr/hosted-relay-stateless.md`, from PR #1887))

## Context

ADR-0179 moves the hosted CI relay's configuration and secrets to a separate
config service, first bound to Infisical Cloud, read-only at run time, with no
secret zero: the relay signs in with its Vercel OIDC token, CI with GitHub
Actions OIDC.

## Decision

- Ship Infisical support as an optional adapter under `packages/adapters/`,
  like `@hobo/adapter-openbao` and `@hobo/adapter-opensesame`; `@hobo/identity`
  only gains the `infisical` port kind.
- Talk to Infisical's documented HTTP API directly (`fetch`), not through an
  SDK: four endpoints, no new third-party dependency.
- The JWT source is injected. The adapter does not depend on `@vercel/oidc`;
  `@hobo/ci-vercel` passes `getVercelOidcToken`.
- Owner machines use Universal Auth client credentials or an `INFISICAL_TOKEN`
  from the environment at run time; HoBo never stores either.

## Consequences

- One request lists a folder, so the relay loads its whole configuration in one
  call; writes are per entry.
- `listVersions` reports the current version only.
- The PACT provider side is verified against a local stand-in, not Infisical.
