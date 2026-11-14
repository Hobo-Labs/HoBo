---
type: Runbook
title: "HoBo.CD runbook: Resolver components"
description: "Out-of-tree hobo:resolver WASM components. Assembled from the Runbook section of packages/resolver-components/README.md."
tags: [hobo, cd, runbook, resolver-components]
---

# HoBo.CD runbook: Resolver components

Out-of-tree hobo:resolver WASM components. This page is assembled from the **Runbook** section of `packages/resolver-components/README.md`,
which stays the source of truth; update that section and re-assemble. The
symptom index is [index.md](./index.md); the design is
[continuous-delivery.md](../../design/continuous-delivery.md).

## Procedures

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

Folder READMEs: `src/` (`src/README.md` beside the source README), `src/guest/` (`src/guest/README.md` beside the source README),
`src/build/` (`src/build/README.md` beside the source README), `src/conformance/` (`src/conformance/README.md` beside the source README),
`src/components/` (`src/components/README.md` beside the source README).
