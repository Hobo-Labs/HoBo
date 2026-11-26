# `@hobo/resolver-components`

Out-of-tree **`hobo:resolver` WASM components** behind the existing
`@hobo/core` `ResourceResolver` seam (ADR-0182: D6, I9, C12). Any
platform HoBo has no in-tree resolver for is reachable by a signed component,
with no change to HoBo: the reconciler, the hosting-transition coordinator and
the resolver registry see an ordinary `ResourceResolver`.

```ts
import {
  componentResolvers,
  createGuestModuleEngine,
  loadResolverComponent,
  verifyResolverComponentBundle,
} from "@hobo/resolver-components";

const verified = await verifyResolverComponentBundle(bundle, registryVerifier);
const loaded = await loadResolverComponent(verified, {
  componentHost,            // ComponentHostPort (runtime-local / runtime-wasm)
  engine,                   // ResolverComponentEngine
  mode: "conductor",        // or "agent"
  resolveHost,              // DNS port (injected; never ambient)
  credentials,              // CredentialResolver where the reconciler runs
  telemetry,                // TelemetrySink
});
const resolvers: readonly ResourceResolver[] = componentResolvers({ components: [loaded] });
```

## What the host guarantees

| Guarantee | Where |
|---|---|
| Only bundles signed through `@hobo/registry` load; the registry manifest binds the component-manifest digest **and** the wasm digest, so one signature covers bytes, allowlist, credential binding and limits. No verifier is `bundle-unverified`, never a pass. | `src/bundle.ts` |
| Outbound `wasi:http` reaches only the signed allowlist (exact host, port, path prefix; at most 32 hosts). Relay-proof SSRF rules: no IP literals, no metadata endpoints by name or address, every resolved address checked, private ranges refused unless agent mode and the host's registered local addresses, no redirects. | `src/egress.ts` |
| Credentials are resolved and attached **by the host**, only for the call's own `credentialRef` and only to hosts in the signed credential binding. Host-owned headers (`authorization`, `cookie`, …) set by a component are dropped. | `src/runtime.ts` |
| A component never sees secret material: upstream responses are redacted before the component reads them, and every request, log line and result is scanned for the injected values in raw, base64/base64url (any alignment), hex, percent, JSON and reversed forms. A hit fails the call with `component.secret-exfiltration` and withholds the result. | `src/secrets.ts` |
| Limits: 128 MiB, 30 s, 10⁹ fuel per call (CD_DEFAULTS caps; a manifest may only lower them). Fuel and memory are charged at host-observable points, so a limit trips at the same point on every run; time is read from the injected clock at every boundary and backstopped by an injected timer. A trapped instance is torn down and the next call gets a fresh one. | `src/limits.ts` |
| `describe()` runs once per (wasm digest, manifest digest) through a shared cache and must equal the signed manifest's classes. | `src/runtime.ts` |
| Any denial during a call fails the call closed, even if the component swallowed the error. | `src/runtime.ts` |
| `read` attributes are trimmed to the class's `observe_fields` ∩ the Camp's `observe_fields`, bounded to 16 KiB; retained fields (D22) are reported in `retained` and never as drift. | `src/resolver.ts` |

## Authoring a component

1. Implement the guest against `@hobo/resolver-components/guest`
   (`defineResolverGuest`) and the WIT world in [`wit/resolver.wit`](wit/resolver.wit):
   `describe`, `reconcile`, `read`, `delete`, `instances`. `reconcile` must be
   convergent and idempotent (`create`/`adopt` first, `noop` after);
   unauthenticated calls go through `send`, authenticated ones through
   `authorizedFetch(request, request.credentialRef)` — never build an
   `authorization` header yourself.
2. Write the component manifest (`data-models/resolver_components.proto`,
   `ResolverComponentManifestRecord`; constraints in
   `data-models/resolver_components.cue`): resource classes with
   `retained_fields`/`observe_fields`/`directives`, the exact egress hosts,
   the credential-bound hosts, limits, and modes (`CONDUCTOR`, `AGENT`; only
   agent mode may list `local_addresses`).
3. Build with the componentize recipe (`@hobo/resolver-components/build`):
   `componentizeResolver` (deterministic contract bytes) or
   `componentizeResolverReal` (pinned componentize-js; fails closed with
   `ComponentizeToolchainError` when absent), then `buildResolverComponent`
   to stamp the wasm digest and get the registry manifest + digest to sign.
4. Sign the registry digest with your identity issuer (`codeVersion.digest`)
   and ship `{ manifest, wasm, registry: { manifest, attestation } }`.
5. Pass the conformance kit (`@hobo/resolver-components/conformance`,
   `runResolverComponentConformance`) before registering.

Reference components: [`http-artifact-upload`](src/components/http-artifact-upload/README.md)
(generic PUT-to-endpoint plus health probe) and
[`sftp-static`](src/components/sftp-static/README.md) (agent-local SFTP
bridge — the R2 pattern for imperative targets; there is no shell-script
escape hatch).

## Engines

`ResolverComponentEngine` turns verified bytes into the lowered
`hobo:resolver/resolver` export table; every engine routes imports through the
component host's link table (`invokeLinkedImport`), which is where egress,
credentials and limits are enforced. The in-tree `createGuestModuleEngine`
binds a guest program to the exact wasm digest it was built into and runs it
in-process under the same lifted/lowered ABI. **Honest scope:** like
`@hobo/componentize`, the in-tree build lane emits contract-shaped bytes, not
a StarlingMonkey guest; an engine that executes real component bytes in
Wasmtime plugs in behind the same interface. Fuel is metered by the host at
boundaries; a Wasmtime engine adds instruction-level fuel on top.

## Parse, don't validate

Every untrusted input crosses one parser and becomes a parsed derived type:
the manifest document → `ComponentManifest` (`parseComponentManifest`, strict
protobuf JSON, CUE-equivalent bounds), the bundle → `VerifiedResolverComponent`
(constructible only by `verifyResolverComponentBundle`), every guest value →
the WIT types in `src/guest/types.ts` (`src/guest/abi.ts` lifters; an
out-of-contract value is `component.output-unparseable`), every request and
outcome → `parseResolveRequest`/`parseResolveOutcome` from `@hobo/core`, so the
core credential screen runs on both sides of every call. Wire records are the
generated types in `src/_generated/resolver_components_pb.ts`.

## Position in the event architecture

This package is a host library with no actor, no command handler and no event
store of its own. It is invoked by the CD reconciler (the per-Camp actor in
`@hobo/cd/reconcile`), which owns the command (apply a Delta), the event
store streams (`cd-camp-status-<id>`), and the projections and materialized
views built from them. Each invocation produces a secret-free
`ComponentInvocationRecord` (outcome, fuel, peak memory, egress calls,
denials) delivered to `onInvocation` for the reconciler to fold into its
observation events, and metric points to the `TelemetrySink`. The describe
cache is a content-addressed snapshot keyed by digests, so it is safe to share
and to rebuild; it is a read store only for `describe()` results, never for
provider state — provider state is always re-read (`read`), never cached.

## Telemetry

| Metric | Kind | Attributes |
|---|---|---|
| `hobo.resolver_component.invocations` | counter | id, operation, outcome |
| `hobo.resolver_component.duration` | histogram (ms) | id, operation, outcome |
| `hobo.resolver_component.fuel` | histogram | id, operation, outcome |
| `hobo.resolver_component.memory.peak` | histogram (By) | id, operation, outcome |
| `hobo.resolver_component.egress.calls` | counter | id, operation, outcome |
| `hobo.resolver_component.egress.denials` | counter | id, denial |

## Runbook

| Symptom (`componentCode`) | Meaning | Action |
|---|---|---|
| `component.bundle-unverified` | No registry verifier configured. | Configure the JWKS/issuer/audience for the publisher; never bypass. |
| `component.bundle-signature-failed` / `bundle-digest-mismatch` | Tampered bytes or manifest, foreign signer, or a widened allowlist that was not re-signed. | Quarantine the bundle; rebuild and re-sign from source. |
| `component.engine-unavailable` | No engine can run this wasm digest. | Register the guest program for the digest, or install the Wasmtime engine. |
| `component.describe-mismatch` | `describe()` disagrees with the signed manifest. | Fix the guest or the manifest; re-sign. |
| `component.egress-denied` | A call reached a host, port, path or address outside the allowlist, or a redirect. Denials are in the invocation record. | If legitimate, add the exact host to the manifest and re-sign; private/metadata addresses stay denied (agent mode + `local_addresses` for bridges). |
| `component.secret-exfiltration` | Injected material appeared in a request, log, result, or an upstream echo. | Treat as a security incident: quarantine the bundle, rotate the credential, audit the upstream. |
| `component.fuel-exhausted` / `memory-exceeded` / `timeout` | A limit tripped; the instance was torn down. | Reduce work per call (paginate, stream smaller bodies) or raise the manifest limit up to the CD_DEFAULTS cap and re-sign. |
| `component.credential-unavailable` | The locator did not resolve where the reconciler runs. | In agent mode the credential must be agent-local; check the agent's credential store. |
| `component.guest-rejected` | The provider refused the desired state. | Fix the desired state named in the message. |
| `component.output-unparseable` / `component.trap` | The component broke the WIT contract or threw. | Run the conformance kit locally; fix the guest. |

Folder READMEs: [`src/`](src/README.md), [`src/guest/`](src/guest/README.md),
[`src/build/`](src/build/README.md), [`src/conformance/`](src/conformance/README.md),
[`src/components/`](src/components/README.md).
