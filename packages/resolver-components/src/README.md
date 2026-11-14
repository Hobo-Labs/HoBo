# `src/` — the resolver-component host

| File | Role |
|---|---|
| `manifest.ts` | `parseComponentManifest` → `ComponentManifest`; `componentManifestDigest`. |
| `bundle.ts` | `verifyResolverComponentBundle` (registry signature + digest binding) → `VerifiedResolverComponent`; `resolverRegistryManifest`. |
| `egress.ts` | `checkEgress`: allowlist + relay-proof SSRF rules; `isPrivateAddress`. |
| `secrets.ts` | `createSecretScanner`: find/redact injected material in its encodings. |
| `limits.ts` | `CallMeter`, `FUEL_COSTS`, injected `ComponentTimers`. |
| `engine.ts` | `ResolverComponentEngine`; `createGuestModuleEngine`. |
| `runtime.ts` | `loadResolverComponent`: instantiate through `ComponentHostPort`, link host imports, meter, scan, report. |
| `resolver.ts` | `componentResolvers` (frozen return type `readonly ResourceResolver[]`), `isComponentResolver`, `observe` with retained fields. |
| `telemetry.ts` | Invocation metrics for the `TelemetrySink`. |
| `errors.ts` | `ResolverComponentError` (extends core `ResolverError`) with `componentCode` and `remediation`. |
| `wit.ts` | WIT package, world and interface ids. |

`isComponentResolver` recognises the objects `componentResolvers` returns;
`createResolverRegistry` hands out a delegating view for a resolver with
directives, so keep the original object when you need `observe` or
`instances`.

Calls on one loaded component are serialized; an instance that trapped or
tripped a limit is torn down and re-instantiated on the next call.

## Runbook

- A reconcile fails with `component.egress-denied`: read the
  `ComponentInvocationRecord.denials` (code + host + detail). Only an exact
  allowlist entry in a re-signed manifest changes the outcome.
- A reconcile fails with a limit code: the invocation record carries
  `fuel_used`, `peak_memory_bytes` and `duration_ms`; compare with the
  manifest limits before raising them (never above CD_DEFAULTS).
- `component.secret-exfiltration`: the result was withheld and nothing was
  reported upstream; rotate the credential and quarantine the bundle.
