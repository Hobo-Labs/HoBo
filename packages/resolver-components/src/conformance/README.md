# `src/conformance/` — the resolver-component conformance kit

`runResolverComponentConformance(target)` drives a loaded component through
`componentResolvers` against the upstream you supply and returns a
`ConformanceReportRecord` with these checks, in order:

`describe.matches-manifest`, `describe.deterministic`, `reconcile.converges`,
`reconcile.idempotent`, `reconcile.updates`, `read.observes`,
`observe.retained-not-drift`, `outputs.secret-free`,
`egress.within-allowlist`, `credential.bound-hosts-only`, `delete.removes`,
`delete.idempotent`, `instances.typed`.

`fakes.ts` provides in-memory upstreams for the reference components
(`createFakeUploadEndpoint`, `createFakeSftpBridge`); each checks the bearer
token the host attaches, so a run without host-side injection fails.

## Runbook

- Run the kit locally before publishing; a report with `passed: false` lists
  the failing check ids (`failedChecks(report)`), each with a detail string.
- `observe.retained-not-drift` failing means a retained field leaked into
  `drift_kind`: declare it in the class's `retained_fields` and re-sign.
- `instances.typed` accepts a list or a typed `unsupported` refusal; anything
  else (a trap, an untyped error) fails.
