# Legacy monolithic runner image

The hermetic runner is built in two steps:

1. **Base** — `base/Dockerfile` (Debian digest pin, `system-packages.txt`, Docker CLI, pinned GitHub Actions runner bundle, Playwright's pinned Chromium headless shell under `/opt/pw-browsers` with `PLAYWRIGHT_BROWSERS_PATH`, UID 1000). A Playwright bump that changes the `chromium-headless-shell` revision in `playwright-core/browsers.json` fails `scripts/test/ci-runner-image-contract.test.ts` until `CI_RUNNER_PLAYWRIGHT_CHROMIUM` and the Dockerfile ARGs move with it.
2. **Toolchain** — `mise oci build` from repo-root `mise.toml` / `mise.lock` (one OCI layer per tool).

Use `bash packages/ci-gh-actions/deploy/ci-runner/build.sh` on the box worker. If the content-keyed `hobo-ci-worker:<version>` is absent locally and `GHCR_TOKEN` is non-empty, the script logs in and pulls `ghcr.io/<owner>/<repo>/hobo-ci-worker:<version>` (repository from lowercased `GITHUB_REPOSITORY`, default `Hobo-Labs/HoBo`). Without a token it skips GHCR and builds natively without prompting. A pulled image becomes `:local` only after the same in-container runner contract as a native build; a pull miss or failed contract falls back to the native build. Every reuse or build removes the OCI layout and temporary archives, uses an ephemeral local registry, prunes BuildKit to `HOBO_CI_WORKER_BUILDER_CACHE_CAP` (default `4GB`), and retains only the current and previous unused `hobo-ci-worker:v*` tags plus `:local` and images used by running containers. `scripts/ci-runner-image-gc.mts` uses only Node builtins and the dependency-free selector, so this cleanup also runs before `pnpm install`. The daemon applies the same retention on its scheduled GC.

## Lockfile-keyed deps image

`scripts/ci/deps-key.mts` prints `<toolchainVersion>-<depsKey>`. The digest covers the lockfile, workspace config, optional root `.npmrc` and `patches/**`, every lockfile importer's `package.json`, the deps Dockerfile and build script, mise's Node and pnpm entries, and `linux/<arch>`. The ts-autocode importer manifests must be present (`pnpm run pins:fetch ts-autocode`, or a recursive submodule checkout).

Build and promote on the box:

```bash
bash packages/ci-gh-actions/deploy/ci-runner/deps/build-deps.sh
```

The build stages only those manifests into its Docker context. The `fetch` target runs `pnpm fetch --frozen-lockfile` with network access and lockfile integrity checks. A separate `docker build --network=none` installs offline as UID 1000 at `/opt/actions-runner/_hobo_work/HoBo/HoBo`, using `store-dir=/pnpm-store` and `package-import-method=copy`, then rebuilds only the `allowBuilds` packages. Both stages mount the persistent host store as BuildKit cache `hobo-pnpm-store`, so a new deps key does not start with an empty store. Root lifecycle scripts remain the job install's responsibility; the exact-match skip path runs `scripts/ensure-ts-autocode-links.mts` explicitly, while CI already skips root hook installation. The install stage moves only the `node_modules` trees and `.git` skeleton into a separate output directory, which the final toolchain stage copies; no deletion pass, fetch store or staged manifests enter the shipped image. Labels `hobo.ci.deps-key` and `hobo.ci.toolchain` let the worker reject a stale layer. `SOURCE_DATE_EPOCH` comes from the checkout's commit time.

An exact local hit returns before either build and can promote the existing image immediately. Before a new build moves `hobo-ci-deps:local`, the script streams the staged manifests into the candidate and requires `pnpm install --frozen-lockfile --offline --config.confirmModulesPurge=false` to print `Already up to date`. Every event can reuse a local or GHCR hit; `--no-promote` builds and verifies a new PR candidate without moving `:local`, and PRs never push GHCR. Trusted main/schedule/dispatch runs build and publish misses.

The install stage leaves an unborn git repository whose `remote.origin.url` is `https://github.com/Hobo-Labs/HoBo`. This relies on the pinned `actions/checkout` implementation: [`prepareExistingDirectory`](https://github.com/actions/checkout/blob/11bd71901bbe5b1630ceea73d27597364c9af683/src/git-directory-helper.ts) keeps the directory when `.git` exists and that URL matches; an unborn `HEAD` is treated as detached by [`isDetached`](https://github.com/actions/checkout/blob/11bd71901bbe5b1630ceea73d27597364c9af683/src/git-command-manager.ts), and `clean: false` skips `git clean -ffdx` and reset. All default-path box checkouts therefore set `clean: false`, enforced by `scripts/lint-actions.ts`.

On a push whose commit file lists contain no runner image input, the workflow skips `CI runner image (mise oci)` so Main full gate can start immediately. Missing file lists and forced pushes still run the job; a push with an image input builds it before either gate that needs it. The image job checks out at depth 2 for its `HEAD~1` diff. Full-history secret scans run in Main full gate, while pull requests keep their separate Secret scan job.

## Fallback Dockerfile (`Dockerfile.monolithic`)

Use only when `mise oci` cannot package a required tool (for example an **asdf** backend, a vfox plugin whose hooks write outside the install dir, or **rust** from a non-mise rustup). HoBo’s pinned set (`cue`, `gitleaks`, `node`, `pnpm`, `turbo`) uses aqua/core backends and is intended to stay on the OCI path.

If you must fall back:

```bash
version="$(node --no-warnings scripts/ci-runner-image-version.mts)"
candidate="hobo-ci-worker:${version}"
if ! docker image inspect "${candidate}" >/dev/null 2>&1; then
  docker build -f packages/ci-gh-actions/deploy/ci-runner/Dockerfile.monolithic \
    -t "${candidate}" .
fi
docker tag "${candidate}" hobo-ci-worker:local
node --experimental-strip-types --no-warnings scripts/ci-runner-image-gc.mts "${version}"
cap="${HOBO_CI_WORKER_BUILDER_CACHE_CAP:-${HOBO_CI_WORKER_BUILDER_KEEP_STORAGE:-4GB}}"
docker builder prune -f --keep-storage "$cap"
```

Document the tool and backend in a PR note and open a follow-up to restore the OCI layer split.
