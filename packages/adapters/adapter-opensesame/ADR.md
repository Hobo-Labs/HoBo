# ADR — `@hobo/adapter-opensesame`

## Status

Accepted. The decision record is
[ADR-0170](../../../docs/design/adr/02-identity-security.md#adr-0170); this file is the package-local summary.

## Context

HoBo deploys with provider credentials (`VERCEL_TOKEN`, AWS keys). Holding them is the exposure the
secretless-first ranking (ADR-0027) exists to avoid, and the residual ports (ADR-0113) still hand the
workload a value. OpenSesame already runs a command with **secret references in place of credentials**
(`opensesame dev --agent run`, ADR 0150 there): the child holds an `osr_` surrogate; a plugin proxy swaps it
for the sealed token at the provider's own host, inside a declared scope, and revokes it when the run ends.

## Decision

Ship the receiving end as an **optional L2 adapter** under `packages/adapters/`:

- Package name `@hobo/adapter-opensesame`; depends on `@hobo/identity` (the `SecretsPort` vocabulary, the same
  reason as `@hobo/adapter-openbao`) and `@hobo/bindings` (secret-reference parsing). Not a default dependency of
  `@hobo/identity` or the composed `hobo` binary.
- A `SecretsPort` of kind `opensesame`: `access()` returns the run's surrogate as `provider-federation`
  material; `put()` is read-only (`read_only`); a placeholder is `placeholders_only`, never a success.
- Bindings (`hobo.credentials.json`) hold references and a bounded scope; an unbounded scope is unrepresentable.
  Bounded is not narrow: a one-segment prefix with all five methods is bounded by path alone, the operator's choice.
  `env_name` may not name a variable the run depends on (`reserved_env_name`).
- The existing locator `hobo-token://vercel/deploy` maps to a connection. No new SecretRef scheme.
- Vercel only. AWS is a typed `provider_not_brokered` refusal until OpenSesame's STS mint lands.
- Node `^22.21 || >=24` is stated in this package's `engines` only (Node 23 has no `NODE_USE_ENV_PROXY`).
- The command starts from an environment the launch builds (an allowlist plus `passEnv`), never the caller's;
  `PATH` is reduced to trusted absolute directories only their owner can add to (an older OpenSesame's first act is a bare `node`
  lookup, a current one searches only directories others cannot write, and the adapter relies on neither; with no `node` there the
  run is `bridge_missing`); the `opensesame` is found on those, must sit in a trusted place (owner, ancestors, mode,
  location) and is identified with `--version`, a shape check, before the passphrase goes to it; an interrupt ends the run it
  started, except SIGKILL and a crash (the 0600 schema, references only, stays).
- The real lane builds or points at a local kit (`HOBO_OPENSESAME_KIT`); no public test-build plugin is published.

## Consequences

- The command a HoBo process starts this way holds a surrogate in place of the credential in the environment the adapter
  builds (an allowlist by name plus `passEnv`; a token under another name, in `passEnv` or in files the user can read is not
  seen), and the adapter fails closed (`placeholders_only`)
  instead of passing a run that silently got a placeholder.
- The status of a proxied run is read from OpenSesame's exit status **and** its own stderr lines, because a child can
  exit with 77, 143 or 129 itself. That is advisory; the port is the gate, and the port proves shape plus run markers,
  not cryptographic provenance. No text the child printed reaches an outcome or an error; the exit status it chose does.
- Deploys that need AWS credentials from OpenSesame wait for the STS mint (a slice in OpenSesame).
