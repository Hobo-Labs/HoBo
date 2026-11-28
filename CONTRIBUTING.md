# Contributing to HoBo

Contributions implement and verify useful behavior. Keep code self-documenting and keep documentation focused on behavior that exists.

## Before you start

1. Read [`README.md`](./README.md) for project purpose and current state.
2. Read [`AGENTS.md`](./AGENTS.md) before using an AI coding agent in this repo.
3. Inspect the affected implementation and its tests.
4. Complete the requested behavior and verify the relevant user-facing path.

## What belongs here

Good changes usually fall into one of these buckets:

- Working product code, examples, and fixes.
- Tests and validation that exercise observable behavior.
- Current reference documentation, operational guidance, and repository automation.

Out of scope for now:

- Claiming HoBo is production-ready.
- Adding provider credentials, static secrets, or live cloud dependencies to default tests.
- Adding design or planning documents, deferred tasks, or explanatory code comments.

## Required local checks

Use Node.js ≥ 22.6 (CI is 24; `setup` and `pins:*` need `--experimental-strip-types`) and the repo `packageManager` (`pnpm@10.33.4`). Clone with submodules — a GitHub zip without `external/ts-autocode` is incomplete; `pnpm run pins:fetch` completes a clone made without them, `pnpm run pins:status` checks the checkout against its pin offline, and `pnpm run pins:bump ts-autocode <ref>` moves the pin (commit the gitlink it stages with the change that needs it).

```sh
bash scripts/bootstrap-dev.sh --project-only
pnpm install
pnpm exec turbo run build --filter @hobo/adapter-hono --filter @hobo/hobo
pnpm test
pnpm run standards:check
pnpm run docs:cli-lint
pnpm run docs:coverage
pnpm run docs:freshness
pnpm exec node --import tsx scripts/validate-sdk-contracts.ts
```

Optional local hook:

```sh
pnpm run prepare-hooks
```

For Impeccable live-preview changes, install Playwright Chromium and run
`node --import tsx --test scripts/test/impeccable-framework-capture.test.ts`.
The test exercises framework-mounted previews and capture fallback in a browser.

## Documentation rule

Docs must move with code. If you touch code, draft packages, tests, scripts, workflows, package metadata, hooks, or agent tooling, update the closest relevant documentation in the same pull request.

Use this checklist:

- README still describes the repo accurately.
- Reference documentation describes the behavior that ships.
- New public commands or examples pass `pnpm run docs:cli-lint`.
- New JavaScript-family implementation files follow the repository's TypeScript standards.

## Licensing of contributions

HoBo is released under the [MIT Licence](./LICENSE), and contributions come in on the
same terms — **inbound equals outbound**. By submitting a contribution you agree that
it is licensed under the MIT Licence in `LICENSE`, and you keep the copyright in your
own work. There is no CLA and no copyright assignment.

Sign off each commit with the [Developer Certificate of Origin](https://developercertificate.org/):

```sh
git commit -s -m "feat(scope): ..."
```

`-s` appends a `Signed-off-by:` trailer using your `user.name` and `user.email`. The
DCO is a statement that you wrote the contribution, or otherwise have the right to
submit it under the project's licence — it is not a copyright transfer.

If you forget, `git commit --amend -s --no-edit` fixes the last commit and
`git rebase --signoff <base>` fixes a branch.

Two rules that keep the licence surface clean:

- **Don't paste code you don't have the right to relicense** — including
  copyleft-licensed code and output you are not permitted to redistribute under MIT.
- **New dependencies must pass `pnpm run licenses:check`**, which enforces the
  permissive allowlist in `scripts/check-licenses.ts`. If a dependency's licence is
  not listed, raise it in the PR rather than editing the allowlist silently.

## Pull request expectations

Review changes and run suitable local checks while a pull request is a draft;
do not run GitHub Actions validation on drafts. Mark it ready for review to
start GitHub Actions. If an applicable check fails, return the pull request to
draft and fix the same branch before marking it ready again. Queue it only after
its required checks and applicable release jobs pass; pending, skipped, failed,
and cancelled jobs are not passes.

Every PR should include:

- Commits signed off with the DCO (`git commit -s`), per [Licensing of contributions](#licensing-of-contributions).
- Purpose and scope.
- Affected behavior and components.
- Tests and validators run.
- Documentation updated, or a clear reason no docs were needed.
- Known limitations and environment constraints.

Prefer small, stacked PRs with complete, verifiable behavior.
