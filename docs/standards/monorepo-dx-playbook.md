---
type: Reference Standard
title: "Monorepo DX Playbook"
description: "Portfolio-wide standard for TypeScript repo/monorepo developer experience; canonical home for the DX.md contract adopted across the portfolio repos."
tags: [hobo, standards]
---

# Monorepo DX Playbook

**Status:** Standard · **Canonical home:** `HoBo/docs/standards/monorepo-dx-playbook.md`
**Applies to:** every TypeScript repo/monorepo in the portfolio (`HoBo`, `quickdeployai/monorepo`, `gitlang`, `epoch`, `universal-token-killer`, `agent_harness`; `awesome-tech` adopts the content-repo subset).

This playbook abstracts the DX/build/CI setup that **HoBo** and **quickdeployai/monorepo** independently converged on. Its goal: **blazingly fast, change-scoped builds; consistent setup; quality gates in local git hooks; and GitHub Actions reserved for staged deployments + genuinely server-side-only work.**

Every code block below is copied from a live reference file and cited. Adopt the **Baseline** everywhere; add **Advanced** patterns where the repo warrants them (§ each section marks which is which).

---

## 1. Philosophy — "fix it locally, keep CI thin"

> *"Everything fixable locally is enforced locally — CI runners are reserved for environment-level tests… CI intentionally does not replay architecture fitness, lint, typecheck, unit tests, builds, or format checks."*
> — monorepo `docs/contributing/hooks.md`

Three rules follow from this:

1. **Gates live in git hooks, not CI.** Lint, typecheck, unit/contract tests, format, and structural checks run at `pre-commit` (staged) and `pre-push` (affected). CI never replays them (monorepo enforces this with a `qdai/ci/no-local-check-replay` fitness rule).
2. **Everything is change-scoped.** Nothing runs over the whole repo when it can run over the staged files (commit) or the affected package graph (push/CI). This is what makes it fast.
3. **A workflow must earn its existence** (§8). Most repos need *few or zero* GitHub Actions workflows.

---

## 2. Toolchain & reproducible installs — *Baseline*

**Pin the toolchain** so every machine and CI runner resolves identically:

- `package.json` → `"packageManager": "pnpm@<x.y.z>"` (bootstrapped by corepack) and `"engines": { "node": ">=<x>" }`.
- **Commit the lockfile.** Installs use `--frozen-lockfile`. (A gitignored lockfile — as in `agent_harness` today — makes installs non-reproducible and is the single highest-impact bug to fix.)

**Make installs fast** with an `.npmrc` performance profile (from monorepo `.npmrc`):

```ini
# Skip re-hashing every file copied from the (trusted, local) pnpm store on each
# install. Removes a large CPU cost from the link phase.
verify-store-integrity=false
# Don't re-resolve when package.json is unchanged — use the committed lockfile.
prefer-frozen-lockfile=true
dedupe-peer-dependents=true
# Prefer the local store on repeat installs.
prefer-offline=true
# Parallel metadata fetches.
network-concurrency=16
# Fail before Node-incompatible scripts try to start.
engine-strict=true
```

**Harden the supply chain:**
- pnpm `onlyBuiltDependencies` (monorepo) / `allowBuilds` (HoBo `pnpm-workspace.yaml`) — an explicit allowlist of packages permitted to run install scripts.
- `minimumReleaseAge` version-cooldown (HoBo) so a compromised fresh release can't be pulled instantly.
- Security `overrides` to pin transitive deps out of known-bad ranges.

---

## 3. Task orchestration & caching (Turborepo) — *Baseline*

**Replace every hand-ordered `&&` / `-w` build chain with Turborepo.** A 20-command `npm run build -w a && … -w t` chain (as in `epoch`, `universal-token-killer`) is fragile and un-cached; Turbo gives you a dependency graph, content-hash caching, and `--affected` for free.

Canonical `turbo.json` (from HoBo `turbo.json` — the smallest complete reference):

```jsonc
{
  "$schema": "https://turbo.build/schema.json",
  "globalDependencies": [
    "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json"
  ],
  "envMode": "strict",
  "globalPassThroughEnv": ["CI", "TMPDIR", "TMP", "TEMP", "SOURCE_DATE_EPOCH"],
  "tasks": {
    "build":     { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "typecheck": { "dependsOn": ["^build"], "outputs": [] },
    "lint":      { "outputs": [] },
    "test":      { "dependsOn": ["^build"], "inputs": ["$TURBO_DEFAULT$", "!**/*.md"], "outputs": [] },
    "dev":       { "cache": false, "persistent": true }
  }
}
```

Four things make the cache both **correct** and **fast**:

| Knob | Why | Reference |
|---|---|---|
| `dependsOn: ["^build"]` | topological ordering; a package builds after its deps | both |
| `inputs: ["$TURBO_DEFAULT$", "!**/*.md"]` | **doc edits never bust the test cache** | HoBo `turbo.json` |
| `outputs` declared (`dist/**`, `pacts/**`, `.eslintcache`) | Turbo can restore artifacts, not just skip | both |
| `globalDependencies` includes the lockfile **and shared config** | a preset change correctly invalidates dependent caches | monorepo lists `packages/config/**` |
| `envMode: "strict"` + `env`/`globalPassThroughEnv` allowlists | reproducible, no accidental env leakage into the hash | HoBo |

Do not list `turbo.json` itself in `globalDependencies`: Turbo already hashes each resolved task definition into that task's hash, while global environment settings are covered by the global hash. Self-listing only makes an unrelated task edit invalidate the whole repository.

`^build` reaches only the workspace packages a `package.json` names in `dependencies`, `devDependencies` or `optionalDependencies` with a `workspace:` specifier; turbo orders nothing on a `peerDependencies` entry, and nothing on a plain version (`"0.1.0"`, `"*"`) unless pnpm's link-workspace-packages is on (`linkWorkspacePackages` in `pnpm-workspace.yaml`, else `link-workspace-packages` in `.npmrc`; off by default from pnpm 9). A root `overrides` entry that links the package for pnpm does not change that: `ts-autocode-training` devDepends on `ts-autocode-rewrite: "0.1.0"`, and turbo never orders that build. A test that loads a sibling package turbo does not build first passes only when something else built it, and fails on a filtered run (`--filter=@hobo/runtime`) or a clean checkout. What needs building depends on how the test reaches the sibling. A relative import of the sibling's tracked source (`../../broker/src/budget-signals.js`) needs no build of the sibling, because vitest runs the source as written. It does need the builds that source loads by name: `examples/hello-bindle/src/bindle.ts` imports `@hobo/adapter-hono`. A by-name import, or a relative import of a path git does not track (`../../../runtimes/runtime-local/dist/…`), needs the sibling built. Order what is needed on the task that runs the test: `"@hobo/runtime#test": { "dependsOn": ["build", "@hobo/runtime-local#build"] }` (keep the generic task's `inputs` and `outputs`; a `pkg#task` entry replaces it for that package). This repository orders three such builds: `@hobo/runtime#test` on `@hobo/runtime-local#build` (its test imports `runtime-local`'s `dist/`), and `@hobo/conformance#test` on `@hobo/storage-sqlite#build` and `@hobo/hobo#test` on `@hobo/adapter-hono#build` (what `runtime-local/src` and `examples/hello-bindle/src` import by name, which those tests reach as source). A path assembled at run time is invisible to an import reader, so the check reads the path text a loaded file assembles and fails on a reach it finds there that no entry declares; the list below says exactly which paths count and which it cannot see. Declare the sibling in `devDependencies`, as `"workspace:*"`, only where the test imports it by package name, which needs the declaration to resolve: a devDependency also widens the package's own `build` and `typecheck`, and every dependent's. `pnpm run lint:test-deps` ([`scripts/check-test-workspace-deps.mts`](../../scripts/check-test-workspace-deps.mts)) lists every tracked test file under `packages/`, `examples/` and `src/draft/` whose task builds a sibling it loads after it, reading turbo's own graph (which fields and specifiers order a build, which task an override names, where a package's own `turbo.json` replaces a `dependsOn` and where `$TURBO_EXTENDS$` appends to it, which files a task runs, and every file a test reaches by a relative path, in its own package or a sibling's source, under the tasks of the tests that reach it); `scripts/test/check-test-workspace-deps.test.ts` holds the repository to none. Where the checkout leaves tracked files out (a sparse checkout, or a submodule not checked out), it names how many it skipped and passes with a warning; `--strict`, or `CI` set (not `0` or `false`), fails instead. What it does not model fails, naming the file and why, rather than passing unseen: a `catalog:` specifier that may name a workspace package; a `pnpm-workspace.yaml` written in YAML its catalog reader does not read (an anchor, an alias, a merge key, a block scalar, a value on the line after its key, a document in flow style, an explicit key, a tag other than `!!str`, a directive, a second document), which it names; a version range or tag on a workspace package while link-workspace-packages is on; and a submodule inside a submodule. It cannot see a specifier computed at run time (``import(`@hobo/${name}`)``), nor the reaches listed under *what it cannot see* below.

**Runtime reaches.** The check reads the path text each file it loads assembles: string and template literals, `join`/`resolve` arguments (a spread of an array literal, or of a name bound to one, read as its elements), and `+` concatenations, a computed part read as `*`. A reach it finds there fails unless [`scripts/test-deps-runtime-reaches.json`](../../scripts/test-deps-runtime-reaches.json) declares what the file needs (`{ "from", "needs": ["<package>#build"], "why" }`), and every test task that loads the file must have those builds. A file whose only reaches are stub trees declares that instead (`{ "from", "stubOnly": true, "reason" }`, below).

- **What names a package:** its directory (`packages/runtimes/runtime-local`), its name (`@hobo/runtime-local`), or a run of its directory's trailing segments (`runtimes/runtime-local`, `runtime-local`), at a path's start or right after a computed part, `..` or `node_modules`. In an absolute path (`/…`, `C:\…`, `file:…`) a package's whole directory names it anywhere. A path that starts `./` or `../` is also read from the file's directory, as `new URL(…, import.meta.url)` resolves it.
- **What counts:** a path into the package's build output directory (the first segment of the `outDir` its build's tsconfig sets, else `dist/`), always. A path that ends at the package, or goes on into a computed segment, in a file that runs or loads something by a computed path: a child process (`spawn`, `exec`, `execFile`, `fork` and their sync forms, under another name, as a `node:child_process` method, promisified or bound), `import()` or `require` of a non-literal, `createRequire`, `symlink`, a copy (`cp`, `cpSync`, `fs.promises.cp`) or `new Worker`. Such a path ends at the package where it names the directory in more than one segment (`packages/hobo`) or right after `..` (`../../hobo`), or names the package after `node_modules`.
- **A package named by a computed segment** fails closed the same way: a directory that holds workspace packages (`packages`, `packages/runtimes`, or `runtimes` after an anchor) or their scope (`@hobo`), then a computed segment (`join(root, "packages", name, "dist")`, `` `node_modules/@hobo/${name}` ``, `` new URL(`../../${name}`, import.meta.url) ``). `join(root, "packages", name, "package.json")` reads a tracked file and does not count.
- **Stub trees.** A reach whose path is rooted at a temporary directory the file visibly makes, and that has no `..`, is a stub: `tmpdir()`; `mkdtempSync(prefix)` or `mkdtemp(prefix)` where the prefix is itself temporary (`join(tmpdir(), "x-")`, `"/tmp/x-"`), since with any other prefix (`join(repoRoot, "x-")`) the directory is made where the prefix names; a path built on one; a literal under `/tmp/`; or a name every binding of which in the file is one (a name also bound as a parameter, a loop variable or by destructuring, or anywhere to another directory, is not). A temporary path with any `..` is read as a real path, and also resolved lexically with its root unknown, so `/tmp/../repo/packages/hobo/dist` and `` `${tmp}/../../packages/hobo/dist` `` reach hobo. A stub still needs an entry, since the reader may misjudge a root, but never a build: it is the only reach a `needs` entry need not name, and only while its whole path stays under its temporary root.
- **What is not a reach:** a path into anything else of a package's (its source, `bin/`, `package.json`, its `node_modules`); one segment after a computed root (`join(evidence, "events")`), which on this repository flagged 7 files, all falsely; a package name at a string's start (`"@hobo/bindles"`, `` `@hobo/app-${name}` ``) unless it goes on into `dist/`; `exec` called on a RegExp; a package named only inside another directory (`…/s0-04-protobuf-cue-codegen/packages/schema-tools` is not `@hobo/schema-tools`); a glob's literal `*`.
- **What it cannot see**, and so passes:
  - a reach whose path is built in one file and used by a loader in another: a helper that returns `join(root, "packages", "hobo")` to a test that spawns from it, where the helper loads nothing itself. A reach built and loaded in one file is seen: a source file that builds `join(repo, "packages", "hobo")` and loads hobo's `dist/` by `import()` in the same file is caught and must be declared. Counting every path to a sibling's directory in a loaded non-test file, loader or not, flagged 99 files here, every one sampled falsely (dependency keys, fixture labels, `".."` in a URL check), so the check does not;
  - a path whose anchor is behind a name: `join(packagesDir, "hobo")`, with `packagesDir = join(root, "packages")`, is one segment after a computed root;
  - a path with no literal anchor: `join(here, "..", "..", name)`, a path passed in or read from the environment;
  - a path built another way: `segs.join("/")`, `+=`, `path.format`, a `join` under another name;
  - a loader the file reaches only through another module (`runCli(dir)` from a helper), or one not listed above (`execa`, `vm`);
  - what a child process loads. A tracked file handed to one (`bin/hobo.mjs`, a sibling's `src/run.ts` under tsx, a script outside `test/`) is tracked source, so it needs no build by this rule, and its own imports, by name or into `dist/`, are not read.
- **Entries.** An entry fails when its file is not tracked, no test task loads it, it no longer reaches another package, or its `from` appears twice. A `needs` entry also fails when a need is not `<package>#build` of a workspace package, when it names no package other than that of every task that loads the file (`"needs": []`, or only the file's own package where only its own package's tests load it; a helper in `packages/a/test` that `b`'s test also loads may need `@hobo/a#build`), or when the reader sees the file reach a package (not a stub, not the loading task's own) whose `<package>#build` it does not name; the error names the file, the package, the path and the missing need. A need the reader sees no reach for may stand, since it cannot see every reach. A `stubOnly` entry needs a non-empty `reason`, cannot carry `needs`, and fails when the reader sees the file reach anything outside a temporary root. A refused entry declares nothing.
- **On this repository** the rule flags 9 files, all real and all declared: code's `composed-hobo.ts` and `generated-app-runtime.ts`, and its `composed-hobo`, `dev-browser` and `hobo-bin-resolve` tests; cli's `codegen-app-compilation`, `generated-runtime-execution` and `typescript-project-codegen` tests, which link packages into generated projects; hobo's `persistent-local-deployment` test. The first, broader rule flagged 15 files, 8 of them falsely: paths read as source text, a tool's binary or working directory, and a corpus label.

**Scope every run:** `turbo run build typecheck lint test --affected` (or `--filter=[HEAD^]`). Never run the whole graph when the affected sub-graph will do.

**Caching tiers:**
- **Baseline:** local `.turbo/cache`, restored in CI via `actions/cache` (HoBo's approach — no secrets, no service).
- **Advanced:** remote cache shared across machines/CI. Do it **secretlessly** — monorepo injects `TURBO_TOKEN` via OIDC → Pulumi ESC and reads `TURBO_TEAM` from repo `vars`; no stored secret. Start local; graduate to remote when a team feels the pain.

---

## 4. Lint & format — *Baseline*

**Use a fast Rust-based formatter/linter as the baseline gate.**

- **Default: Biome** — one binary, format + lint, no config coupling (HoBo's model). Adopt in repos with *no* linter today (`universal-token-killer`, `agent_harness`) and any greenfield.
- **Keep existing ESLint** where a repo already invested (`gitlang`, `epoch`), but optimize it:
  1. Move rules into a **shared config package** (§10) so every workspace extends one source.
  2. Run it through the **turbo `lint` task** with `outputs: [".eslintcache"]` and `inputs` that include `eslint.config.*` (from monorepo `turbo.json`) so config changes bust the cache:
     ```jsonc
     "lint": {
       "outputs": [".eslintcache"],
       "inputs": ["$TURBO_DEFAULT$", "eslint.config.js", "eslint.config.mjs", "eslint.config.ts"]
     }
     ```
  3. **Scope it:** Oxlint/Biome on **staged** files at pre-commit; full ESLint only on **affected** packages at pre-push.
- **Keep `konsistent`** (already present in all repos) for structural conventions — which files/dirs/exports must exist. It's the portfolio's lingua franca; build the conformance layer (§12) on it.
- Layer `ast-grep` (HoBo) / semantic fitness functions (monorepo) only where boundary rules already exist.

---

## 5. Typecheck — *Baseline*

- One **`tsconfig.base.json`** with the strict flags, ideally exported from the shared config package (§10). Every workspace extends it and sets only `rootDir`/`outDir`/`references`.
- **Use project references + `tsc -b`** for incremental typecheck. monorepo's pattern: each app `tsconfig.json` has `"files": []` + `"references": [...]` and the script is `"typecheck": "tsc -b"`. This reuses `.tsbuildinfo` across the graph instead of cold-checking every package (the gap in `epoch`, `universal-token-killer`).
- Run it through the turbo `typecheck` task (`dependsOn: ["^build"]` or `["^typecheck"]`) so it's cached and topological.
- HoBo's root `pnpm run typecheck` covers `./packages/*` and explicitly adds `@hobo/draft-connectivity-tier-ir-contract`, whose public declaration consumer guards the typed-plan/untrusted-JSON parse boundary. Other draft proofs remain outside the root filter until their own typechecks pass; `test/root-script-pins.test.ts` pins the explicit inclusion.
- *Advanced:* the native TS compiler preview (`tsgo`, `@typescript/native-preview`) is a large speedup HoBo/epoch experiment with — adopt once it's stable enough for your risk tolerance.

---

## 6. Test runners — *Baseline*

- **Converge on Vitest** for unit/integration (already the plurality across the portfolio). Keep **Pact** (consumer/provider contract tests) and **Cucumber** (behavior specs) where they already earn their keep.
- **Set an explicit coverage-threshold policy** per repo (`universal-token-killer` runs 100%; `epoch` runs lines 85 / branches 75 / functions 79 / statements 85). Pick a number and enforce it; don't leave it unset (as `gitlang` does).
- Cache tests via the turbo `test` task with `inputs: ["$TURBO_DEFAULT$", "!**/*.md"]` and declare contract outputs (`pacts/**`, `.tmp/pacts/**`).

---

## 7. Local git hooks — the primary gate — *Baseline*

**Use native git hooks — not Husky/lefthook.** Neither reference repo uses a hook manager; both point `core.hooksPath` at a tracked directory and install it from a **fail-open `prepare` script**.

```jsonc
// package.json
"scripts": { "prepare": "node --import tsx scripts/install-hooks.mts" }
```

The installer must **fail open** — exit 0 on CI, when `<REPO>_SKIP_HOOKS` is set, or when there's no `.git` (HoBo `scripts/install-hooks.mts`) — so installs never break in those environments.

**Two tiers.** `pre-commit` is fast and staged-scoped; `pre-push` is the affected turbo gate. HoBo's entire `pre-commit` is three lines:

```sh
#!/usr/bin/env sh
set -eu
pnpm run generated:guard
BASE="${HOBO_ARCHITECTURE_BASE:-$(pnpm --silent run fetch:pr-base)}"
pnpm run check:relevant:staged -- --base="$BASE"   # maps changed paths → minimal check set
```

A fuller "what runs when" contract (adapted from monorepo `docs/contributing/hooks.md`):

| Stage | Check | Scope |
|---|---|---|
| pre-commit | git hygiene (whitespace, EOF, merge markers, large files) | staged |
| pre-commit | secret scan (gitleaks / no-secrets) + staged `.env` block | staged diff |
| pre-commit | format + lint (Biome / Oxlint) — re-stage after fixes | staged paths |
| pre-commit | structural / fast fitness (konsistent quick, ast-grep) | staged |
| pre-push | konsistent structural lint | whole-repo (ms) |
| pre-push | **turbo affected gate**: `lint typecheck test [pact] build` | affected graph |
| pre-push | dependency audit / semgrep | changed / affected |

**Escape hatches (document them):** `git commit --no-verify`, per-hook `SKIP=<id>`, and repo-specific overrides (e.g. `<REPO>_ALLOW_GENERATED=1`). After any bypass, run the full local gate before handoff.

---

## 8. CI/CD workflow policy — the decision tree — *Baseline*

**Before adding ANY GitHub Actions workflow, answer in order:**

1. **Is it a deploy/release step?** → Justified **only** if the repo does **staged deployment** (dev → staging → prod with environment approval) **or staged package release** (npm publish with provenance). **Direct-to-Vercel git-integration does *not* qualify** — Vercel's own build is the deploy + PR preview; add **no** workflow. To earn a deploy workflow, first adopt staging (disable Vercel git auto-deploy — `vercel.json` → `"git": { "deploymentEnabled": { "main": false } }` — and orchestrate via Actions, §9).
2. **Can it run in a local git hook?** (lint, typecheck, unit/contract test, format, structural) → **It belongs in a hook, never a workflow.** Do not replay local gates in CI.
3. **Is it genuinely server-side-only and un-hookable?** (full-history secret scan, cross-OS / Windows / Deno build artifacts, Docker/testcontainers env suites, cross-app guards, scheduled CVE scan) → **one thin workflow** is justified.
4. **Otherwise → no workflow.**

**Every workflow that does exist MUST:**
- be **`paths:`-filtered** to the changes it cares about,
- set **`concurrency: { group: …, cancel-in-progress: true }`** (superseded runs are cancelled),
- scope work with **`turbo … --affected`**,
- authenticate **secretlessly via OIDC** (no stored GitHub secrets),
- and **never replay a local gate**.

`awesome-tech`'s single `konsistent.yml` (pull_request + push:main, with `concurrency`) is the reference-quality **minimal** workflow for a content/structural repo.

---

## 9. Deployment (staged, env-gated) — *Advanced; staged-deploy repos only*

For repos that promote through environments (monorepo `deploy.yml` is the reference):

- **Disable Vercel git auto-deploy** (`git.deploymentEnabled.main: false`); Actions owns every deploy.
- **Build once, promote the artifact.** One `vercel build` output flows dev → staging → prod (rebuild only for prod-specific env). `--prebuilt` deploys.
- **Gate prod on a GitHub `environment:`** with required approval.
- **Fan out on shared-package changes** — a changed design-system/auth package redeploys *every* consumer, so a fix can't ship to some microfrontends but not others.
- **Split secrets by blast radius** — cache creds (`qdai/ci`) are a different OIDC environment from deploy creds (`qdai/ci-deploy`), so a test job can never read a deploy token.

Repos deploying **direct to Vercel** (`gitlang`, `epoch`, `agent_harness`) get **none** of this — Vercel's git integration builds previews and prod; their gate is the local hook (§7). That's the whole point of §8 rule 1.

---

## 10. Shared config as a package — *Baseline for multi-package repos*

Centralize config as a real workspace package (monorepo's `@quickdeployai/config`) that exports:
- ESLint presets (`eslint/react`, `eslint/node`, `eslint/typescript`, …) + custom rules,
- `tsconfig.base.json`,
- formatter config (Biome / Oxfmt / Prettier).

Every app extends it (`import reactPreset from "@org/config/eslint/react"`), and it's listed in turbo `globalDependencies` so changes bust dependent caches. Pin shared tool versions with a pnpm **`catalog:`** (monorepo `pnpm-workspace.yaml`) — one version source of truth referenced as `catalog:` in each manifest (warranted at ~15+ packages).

---

## 11. DX tooling — *Baseline*

- **A single dev CLI** for the common loop (monorepo's `vp` / `qdai-*`; HoBo's `pnpm doctor` + `ci:preflight`). Contributors learn one surface.
- **A `doctor` / `preflight`** command that checks the toolchain is correctly provisioned.
- **Devcontainer `postCreateCommand`** that runs setup so containers come up fully wired.
- **The per-repo `DX.md`** stub (links here + carries the repo's adoption checklist).

> **Portability note:** monorepo's `vp` (Vite+) tooling is *not* portable — this playbook abstracts the *principles* (native hooks, turbo `--affected`, staged/affected scoping), which you implement with plain scripts + Turbo + Biome/ESLint. Don't take a dependency on `vp` to adopt the baseline.

---

## 12. Adoption checklist / conformance

A repo is **baseline-conformant** when:

- [ ] `package.json` has `"packageManager"` + `engines`; lockfile is committed (not gitignored).
- [ ] `.npmrc` install-perf profile present; installs use `--frozen-lockfile`.
- [ ] `turbo.json` exists with `globalDependencies`, declared `outputs`, and md-ignoring test `inputs`.
- [ ] A fast formatter/linter (Biome or optimized ESLint) runs **scoped** (staged/affected).
- [ ] `tsconfig.base.json` shared; incremental typecheck (`tsc -b` or turbo-cached).
- [ ] Native git hooks auto-installed via fail-open `prepare`; `pre-commit` (staged) + `pre-push` (affected turbo gate).
- [ ] Every workflow passes the §8 decision tree; each has `paths` + `concurrency` + `--affected` + OIDC; none replays a local gate.
- [ ] Staged-deploy repos only: Vercel auto-deploy disabled, build-once-promote, prod `environment` approval.
- [ ] `DX.md` present, linking here.

**Make it machine-checkable:** extend the shared **`konsistent.json`** (present in every repo) with rules asserting `packageManager` presence, a committed lockfile, `turbo.json` shape, the `prepare`/`.githooks` wiring, and that no workflow replays a local gate. Then `konsistent check` verifies conformance on the pre-push gate.

**Smoke test after migrating a repo:**
```sh
corepack pnpm install --frozen-lockfile                         # reproducible install
pnpm turbo run build typecheck lint test --affected --dry=json  # graph resolves, scoped
# trivial edit → git commit / git push                           # hooks fire, scoping works
pnpm turbo run build                                             # second run = full cache hit
```

---

*Derived from the HoBo and quickdeployai/monorepo reference implementations. Keep this doc's code blocks in sync with those repos' `turbo.json`, `.npmrc`, `.githooks/`, and `docs/contributing/hooks.md`.*
