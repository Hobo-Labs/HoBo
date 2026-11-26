# Dagger SDK contracts

- `checks-cli.pact.json`: native Dagger 1.x version/check subprocess boundary.
  `../test/checks.test.ts` executes the Pact through a real local CLI fixture,
  verifies version pinning, exact check argv, inherited Cloud/session removal,
  saved-login isolation, preserved proxy/CA settings, nonzero exits and planning.
  The fixture does not run a Dagger engine or contact external services.
  Native and legacy version formats, overall deadlines, process-group cleanup,
  named overlays, transport selection and nonblocking config-file rejection are
  covered by the same suite. The separate `../acceptance` lane verifies the built
  CLI on real operator-owned engines; it is not part of the offline Pact fixture.
- `readiness.pact.json`: synchronous-message expectation for immutable implemented
  readiness; `readiness.consumer.test.ts` invokes the real SDK getter/parser.
- `execution.pact.json`: synchronous-message command requests and output expectations
  from the shipped Dagger adapter; `../test/backend.test.ts` executes all interactions
  and verifies source-snapshot chaining, clean step environments, exact exit codes,
  binary artifacts, cancellation acknowledgment and uncertain shutdown.

- `sdk-graphql.pact.json`: loopback HTTP protocol requests for the actual default
  SDK connector. `sdk-graphql.consumer.test.ts` drives the real pinned SDK and
  verifies engine authentication, query structure and every interaction.

The fake boundary implements a deliberately narrowed fluent SDK port. A production
compile-time witness accepts the pinned actual Dagger Client as that port. These
are local consumer contracts; no live engine or vendor verification is claimed.
