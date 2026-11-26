# `src/components/` — reference components

| Component | Product | Modes | Pattern |
|---|---|---|---|
| [`http-artifact-upload`](http-artifact-upload/README.md) | `http/artifact-upload` | conductor, agent | Generic authenticated PUT plus an unauthenticated health probe. |
| [`sftp-static`](sftp-static/README.md) | `sftp/static-file` | agent | Agent-local SFTP bridge over loopback HTTPS (R2: no shell escape hatch). |

`buildReferenceComponent(component)` componentizes one (synthetic lane) and
stamps its manifest; the operator signs the result for their hosts.

## Runbook

Both pass the conformance kit (`test/conformance.test.ts`). An operator's
bundle differs only in the signed allowlist; rerun the kit against the
operator's endpoint in a credential-gated lane before registering it.
