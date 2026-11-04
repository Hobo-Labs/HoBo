# Legacy monolithic runner image

The hermetic runner is built in two steps:

1. **Base** — `base/Dockerfile` (Debian digest pin, `system-packages.txt`, Docker CLI, pinned GitHub Actions runner bundle, Playwright's pinned Chromium headless shell under `/opt/pw-browsers` with `PLAYWRIGHT_BROWSERS_PATH`, UID 1000). A Playwright bump that changes the `chromium-headless-shell` revision in `playwright-core/browsers.json` fails `scripts/test/ci-runner-image-contract.test.ts` until `CI_RUNNER_PLAYWRIGHT_CHROMIUM` and the Dockerfile ARGs move with it.
2. **Toolchain** — `mise oci build` from repo-root `mise.toml` / `mise.lock` (one OCI layer per tool).

Use `bash packages/ci-gh-actions/deploy/ci-runner/build.sh` on the box worker.

On a push whose commit file lists contain no runner image input, the workflow skips `CI runner image (mise oci)` so Main full gate can start immediately. Missing file lists and forced pushes still run the job; a push with an image input builds it before either gate that needs it. The image job checks out at depth 2 for its `HEAD~1` diff. Full-history secret scans run in Main full gate, while pull requests keep their separate Secret scan job.

## Fallback Dockerfile (`Dockerfile.monolithic`)

Use only when `mise oci` cannot package a required tool (for example an **asdf** backend, a vfox plugin whose hooks write outside the install dir, or **rust** from a non-mise rustup). HoBo’s pinned set (`cue`, `gitleaks`, `node`, `pnpm`, `turbo`) uses aqua/core backends and is intended to stay on the OCI path.

If you must fall back:

```bash
docker build -f packages/ci-gh-actions/deploy/ci-runner/Dockerfile.monolithic \
  -t hobo-ci-worker:local .
```

Document the tool and backend in a PR note and open a follow-up to restore the OCI layer split.
