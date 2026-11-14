# `@hobo/resolver-components` contracts

- `resolver-component-host.pact.json` — consumer `@hobo/cd/reconcile`,
  provider `ResolverComponentHost`: reconcile converges then noops, a
  non-allowlisted egress is a typed `RESOLVER_PROVIDER_REJECTED` /
  `component.egress-denied`, and observe reports retained fields never as
  drift.
- `resolver-guest-imports.pact.json` — consumer
  `hobo:resolver/resolver-component@0.1.0`, provider
  `ResolverComponentHostImports`: `authorized-fetch` attaches the credential
  host-side; `wasi:http` `send` to an unlisted host answers `err(denied)`.

`test/contracts.pact.test.ts` replays every interaction against the real host.
