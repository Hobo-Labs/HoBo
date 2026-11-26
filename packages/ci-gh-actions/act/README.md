# Local `act` verification

This harness executes the unchanged [`workflow.yml`](workflow.yml) using pinned
[`nektos/act` v0.2.89](https://github.com/nektos/act/releases/tag/v0.2.89).
It submits a real HMAC-signed webhook over loopback HTTP to the shipped Relay,
asserts allocation routing and the exact provider dispatch contract, then runs the
original `runs-on: hobo` workflow with act's native host executor.

Six provider fixtures use the same workflow bytes: GitHub, Blacksmith, Depot,
WarpBuild, Kubernetes, and the local workstation. The workstation case runs with
zero monetary budget without inventing free-minute credits. Additional scenarios exercise free-before-paid,
cheapest-paid-after-exhaustion, and provider-budget fallback. A zero account
budget explicitly refuses admission and launches zero workflows. Prices and
allocations are synthetic contract data, not vendor price facts.

Every admitted case executes five jobs: prepare, two matrix shards, an expected
continued failure, and a dependent verification job. The harness checks `needs`,
job outputs, matrix coverage, failure outcome and artifact file contents. Both act
JSON logs and independent evidence files must match exactly, so an unsupported
runner-label skip or dry-run cannot produce a green result.

## Run

Run from the HoBo repository root with Node 24+, bash, git and act v0.2.89:

```sh
node --import tsx packages/ci-gh-actions/scripts/act-install.ts \
  --directory /tmp/hobo-ci-tools
node --import tsx packages/ci-gh-actions/scripts/act-harness.ts \
  --act /tmp/hobo-ci-tools/act --evidence /tmp/hobo-ci-act-evidence
```

The checksum-verified installer pins the Linux and macOS x64/arm64 assets. On another
platform, install the corresponding official v0.2.89 binary and pass `--act`.
If an outbound proxy requires Node's proxy support, set `NODE_USE_ENV_PROXY=1`
for the installer; keep normal proxy/CA trust configured. The runtime harness
performs no external GitHub/provider requests and downloads no action code or
container images. Its workflow contains only repository-owned shell steps.

Without `--evidence`, all temporary files are removed after verification.
With it, each invocation creates a fresh directory under the requested path;
each scenario stores act JSON output, two artifact files and evidence markers,
plus aggregate `summary.json`. Existing evidence is preserved. Workspaces and act caches are isolated;
ambient `.env`, `.input`, `.secrets`, and GitHub/provider credentials are not
injected into the fixture workflow. The harness uses `-P hobo=-self-hosted` and
does not need a Docker image pull. This native mode executes the owned fixture
shell commands on the local machine; it is intended for this fixed workflow.

## Boundary represented

Act is the local workflow executor. GitHub's provider dispatch, JIT registration,
OIDC issuance and remote machine provisioning remain simulated contract boundaries;
act does not implement GitHub's hosted runner queue or run vendor machines. This
harness verifies actual workflow semantics and substitutable provider routing,
while the package's signed-token/HTTP/JIT contract suites verify those boundaries.
No public/private repository connection, GitHub App creation, or paid resource is
required or created.

The ordinary unit lane tests the evidence gate with negative controls. The binary
lane above fails if act is missing, has the wrong version, skips jobs, fails a
step, or produces incomplete artifacts. It never silently skips verification.
