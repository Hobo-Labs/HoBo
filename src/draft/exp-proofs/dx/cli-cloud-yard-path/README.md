# CLI Cloud Yard Path

HOBO-625 proof for the CLI cloud command path against a mocked Yard Gateway.

## What This Proves

- `hobo login` obtains a dev SVID stub with deploy, projection, and log scopes.
- `hobo plan` previews DeploymentPlan output and cross-camp warnings for
  `examples/hello-bindle`.
- `hobo deploy`, `hobo destroy`, `hobo inspect deploy`, and `hobo logs` route through the
  mocked Gateway with PACT-pinned request/response shapes.
- The J1 journey (`hobo plan` → `hobo deploy` → `hobo inspect deploy`) completes against the
  `dx.lifecycle.hello-bindle.v1` reference fixture.
- Blocked paths emit NFR-017 actionable errors: root cause, two remediation steps, and a
  machine-readable correlation id.

## Fixture

Reference fixture id: `dx.lifecycle.hello-bindle.v1`. Bindle path: `examples/hello-bindle`.
All Gateway calls are mocked in-process; no production `packages/cli` binary, live Yard, or cloud
provider is required.

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\cli-cloud-yard-path test
```

## Architecture Evidence

- `architecture/cli_cloud_yard_path.proto` — protobuf record shapes.
- `architecture/cli_cloud_yard_path.cue` — parse-time constraints including NFR-017 remediation
  minimum.
- `architecture/pacts/cli_cloud_yard_path.pact.json` — Gateway boundary interactions.
- `ADR.md` — event flow and parse-don't-validate evidence.

## Scope Out

- Production `packages/cli` implementation (promotion target for a later slice).
- Merged `packages/cloud` Yard shell from HOBO-618.
- Gatekeeper engines from HOBO-624.
- Real OIDC login, credential storage, or provider apply.
