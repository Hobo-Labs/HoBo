# Hosting evidence observation

The manually dispatched `HoBo hosting evidence (read-only)` workflow checks
whether this repository's main-branch GitHub Actions identity can list names in
the committed Infisical folder. It uses the HoBo secret-store SDK and reports
only a small allowlist of key names; it does not read or print secret values.
It makes at most one GitHub OIDC request, one Infisical login, and one names-only
read. It does not adopt a deployment, create or modify a provider resource, or
contact the hosted relay.

Once the workflow is present on main, run it with:

```sh
gh workflow run hosting-evidence.yml --ref main
```

A successful observation proves only that the identity could list those names
in that folder at that moment. A name's presence does not verify its value,
provider permissions, account quota, shared-IP capacity, or hosting budget.
The workflow reports CI and CD `can-deploy` as not evaluated; run those commands
with the actual enrolled hosting supervisor before deploying or testing the
relay. An unavailable observation fails the job without printing provider error
bodies or credentials.
