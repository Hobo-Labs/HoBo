# ADR — `@hobo/adapter-bitwarden`

## Status

Accepted (ADR-0179 amendment "Secrets manager, not Infisical", 2026-11-12).

## Decision

- Bitwarden Secrets Manager is one of three secrets-manager providers behind
  the `SecretsPort` (`kind: "bitwarden"`), an optional adapter;
  `@hobo/identity` only gains the kind.
- Drive the official SDK's client, injected (no dependency), so values never
  ride a `bws` command line.
- Only the bound project's secret counts when a key repeats across projects.
- Not used for the hosted relay's runtime reads: machine accounts need a
  stored access token; no OIDC federation is documented (checked 2026-11-12).
