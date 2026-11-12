# ADR — `@hobo/adapter-1password`

## Status

Accepted (ADR-0179 amendment "Secrets manager, not Infisical", 2026-11-12).

## Decision

- 1Password is one of three secrets-manager providers behind the `SecretsPort`
  (`kind: "1password"`), shipped as an optional adapter like
  `@hobo/adapter-infisical`; `@hobo/identity` only gains the kind.
- Drive the official JavaScript SDK's client, injected (no dependency): the
  SDK is the documented programmatic interface for service accounts and the
  desktop app; values stay in-process (no `op` command line carries them).
- One Password item per secret, title = name, tag `hobo`.
- Not used for the hosted relay's runtime reads: 1Password has no workload
  identity for Vercel and its GitHub Actions federation still needs a stored
  integration key (checked 2026-11-12).

## Consequences

- An owner who keeps secrets in 1Password can use it as HoBo's secrets
  manager on their own machine and in agent sessions; the relay's runtime
  store stays one that signs in with workload identity.
