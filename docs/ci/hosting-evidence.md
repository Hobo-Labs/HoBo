# Hosting evidence observation

The manually dispatched `HoBo hosting evidence (read-only)` workflow checks
whether this repository's main-branch GitHub Actions identity can list names in
the committed Infisical folder. It uses the HoBo secret-store SDK and reports
only a small allowlist of key names. It may also read and report the public,
numeric GitHub App ID from that original folder; it never reports credentials.
After that, it reads the enrolled project's environment and folder metadata,
then lists names only in scopes exposed by that identity and accepted by the
provider. It makes at most one GitHub OIDC request, one Infisical login, one
project metadata read, 16 folder metadata reads, 17 names-only reads and one
App ID read. It does not adopt a deployment, create or modify a provider
resource, or contact the hosted relay.

Once the workflow is present on main, run it with:

```sh
gh workflow run hosting-evidence.yml --ref main
```

A successful observation proves only that the identity could list those names
in the reported folders at that moment. `scopeDiscovery` is `partial` or
`unavailable` when metadata or scope reads are refused or bounded. A name's
presence does not verify its value,
provider permissions, account quota, shared-IP capacity, or hosting budget.
The workflow reports CI and CD `can-deploy` as not evaluated; run those commands
with the actual enrolled hosting supervisor before deploying or testing the
relay. An unavailable observation fails the job without printing provider error
bodies or credentials.
