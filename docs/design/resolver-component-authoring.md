---
type: Guide
title: "Authoring a hobo:resolver component"
description: "How to reach a platform HoBo has no in-tree resolver for: write a signed hobo:resolver@0.1.0 WASM component, declare its egress allowlist, credential binding and limits, pass the conformance kit, and register it, with no change to HoBo."
tags: [hobo, design, cd, resolver, wasm, component, guide]
---

# Authoring a `hobo:resolver` component

HoBo.CD realizes every platform through a `ResourceResolver`
([ADR-0180](./adr/01-architecture-core.md#adr-0180) D6). Platforms with an
in-tree resolver need nothing from you. For any other platform, write an
out-of-tree **resolver component**: a WASM component exporting the
`hobo:resolver@0.1.0` world, hosted by `@hobo/resolver-components` behind the
same `ResourceResolver` seam. The reconciler, the hosting-transition
coordinator and the resolver registry cannot tell it from an in-tree resolver.

There is no shell-script escape hatch. If the target is imperative (an SFTP
drop, an on-premises appliance), the component calls an **agent-local bridge
endpoint**, as the `sftp-static` reference component does, or the pipeline uses
a typed `RUNBOOK` hook.

The package reference, including every host guarantee, is
`packages/resolver-components/README.md`.

## What the host guarantees, so you don't have to

- **Signature.** Only bundles signed through `@hobo/registry` load. One
  signature covers the wasm bytes, the egress allowlist, the credential
  binding and the limits; widening any of them needs a new signature.
- **Egress.** Outbound `wasi:http` reaches only the hosts in the signed
  allowlist (exact host, port and path prefix; at most 32 hosts). IP
  literals, metadata endpoints, redirects and private addresses are refused;
  private addresses are allowed only in agent mode, for addresses the manifest
  declares as local.
- **Secrets.** Credentials are attached **by the host**, from a
  `credentialRef`, only to hosts in the credential binding. The component never
  sees a secret: upstream responses are redacted before it reads them, and any
  injected value found in a request, log line or result (raw or encoded) fails
  the call with `component.secret-exfiltration`.
- **Limits.** 128 MiB memory, 30 s and 10⁹ fuel per call by default
  (`CD_DEFAULTS`). A manifest may lower these, never raise them past the cap.
- **Determinism.** Time comes from the injected clock; a trapped instance is
  torn down and the next call starts fresh.

## Steps

1. **Implement the guest.** Use `@hobo/resolver-components/guest`
   (`defineResolverGuest`) against the WIT world
   (`packages/resolver-components/wit/resolver.wit`). Export `describe`,
   `reconcile`, `read`, `delete` and `instances`.
   - `reconcile` must converge and be idempotent: `create` or `adopt` the
     first time, `noop` afterwards.
   - Send unauthenticated calls with `send`. Send authenticated calls with
     `authorizedFetch(request, request.credentialRef)`; never build an
     `authorization` header yourself (the host drops it).
   - `read` reports only the attributes your resource class declares in
     `observe_fields`, secret-free and at most 16 KiB per resource. Those
     attributes feed drift detection and [posture](./continuous-delivery.md#policy-delivered-and-observed).
2. **Write the manifest** (`ResolverComponentManifestRecord`). Declare:
   - resource classes, with `retained_fields` (fields a target-side
     controller owns, such as replica counts, which are never drift),
     `observe_fields` and directives;
   - the exact egress hosts, and the subset that receives credentials;
   - limits, and the modes you support (`CONDUCTOR`, `AGENT`; only `AGENT` may
     list local addresses).
3. **Build.** Use the componentize recipe in
   `@hobo/resolver-components/build`, then `buildResolverComponent` to stamp
   the wasm digest and produce the registry manifest and digest to sign. The
   real componentize-js lane is opt-in and fails closed when its toolchain is
   absent; the default lane emits contract-shaped bytes (see
   [live-provider-matrix.md](./live-provider-matrix.md) for honest scope).
4. **Sign** the registry digest with your identity issuer and ship
   `{ manifest, wasm, registry: { manifest, attestation } }`.
5. **Pass the conformance kit** (`@hobo/resolver-components/conformance`,
   `runResolverComponentConformance`) against an upstream you supply. Its
   checks: `describe.matches-manifest`, `describe.deterministic`,
   `reconcile.converges`, `reconcile.idempotent`, `reconcile.updates`,
   `read.observes`, `observe.retained-not-drift`, `outputs.secret-free`,
   `egress.within-allowlist`, `credential.bound-hosts-only`,
   `delete.removes`, `delete.idempotent` and `instances.typed`.
   `failedChecks(report)` lists what failed.
6. **Register.** The Yard operator configures the publisher's verifier and
   adds the bundle; `componentResolvers` turns it into ordinary
   `ResourceResolver`s. Nothing in HoBo changes.

## Troubleshooting

Every failure carries a `component.*` code with a remediation; the table is in
the [resolver components runbook](../runbooks/cd/resolver-components.md). The
codes you will meet while authoring:

| Code | Usual cause |
|---|---|
| `component.describe-mismatch` | `describe()` disagrees with the signed manifest: fix one and re-sign. |
| `component.egress-denied` | A call left the allowlist, or followed a redirect. |
| `component.output-unparseable`, `component.trap` | The guest broke the WIT contract or threw: run the conformance kit locally. |
| `component.fuel-exhausted`, `component.memory-exceeded`, `component.timeout` | Too much work in one call: paginate or stream smaller bodies. |
