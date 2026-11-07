# Contributing to HoBo

HoBo is design-first. A useful contribution either clarifies the design, proves a design claim with an executable draft contract, or improves the maintenance system that keeps those two aligned.

## Before you start

1. Read [`README.md`](./README.md) for project purpose and current state.
2. Read [`AGENTS.md`](./AGENTS.md) before using an AI coding agent in this repo.
3. Find the relevant design area in [`docs/design/index.md`](./docs/design/index.md).
4. For implementation-facing work, find the matching proof note under [`docs/design/proofs/`](./docs/design/proofs/) or draft package under [`src/draft/`](./src/draft/README.md).

## What belongs here

Good changes usually fall into one of these buckets:

- Design docs, ADRs, glossary entries, CLI/spec changes, or traceability updates.
- `src/draft/<kind>/<slug>` proof/contract packages that make a design claim executable.
- Validation scripts, CI gates, and repository-maintenance automation.
- Reference notes in `docs/standards/`, `docs/technologies/`, `docs/patterns/`, or `docs/competitors/` that support a design decision.

Out of scope for now:

- Claiming HoBo is production-ready.
- Adding production product code without a linked design claim and proof path.
- Adding provider credentials, static secrets, or live cloud dependencies to default tests.

## Required local checks

Use Node.js ≥ 22.6 (CI is 24; `setup` and `pins:*` need `--experimental-strip-types`) and the repo `packageManager` (`pnpm@10.33.4`). Clone with submodules — a GitHub zip without `external/ts-autocode` is incomplete; `pnpm run pins:fetch` completes a clone made without them, `pnpm run pins:status` checks the checkout against its pin offline, and `pnpm run pins:bump ts-autocode <ref>` moves the pin (commit the gitlink it stages with the change that needs it).

```sh
bash scripts/bootstrap-dev.sh --project-only
pnpm install
pnpm exec turbo run build --filter @hobo/adapter-hono --filter @hobo/hobo
pnpm test
pnpm run standards:check
pnpm run docs:cli-lint
pnpm run docs:design-lint
pnpm run docs:coverage
pnpm run docs:freshness
pnpm exec node --import tsx scripts/validate-traceability.ts
pnpm exec node --import tsx scripts/validate-sdk-contracts.ts
pnpm exec node --import tsx scripts/validate-deployment-set-delta.ts
```

Optional local hook:

```sh
pnpm run prepare-hooks
```

## Documentation rule

Docs must move with code. If you touch code, draft packages, tests, scripts, workflows, package metadata, hooks, or agent tooling, update the closest relevant documentation in the same pull request.

Use this checklist:

- README still describes the repo accurately.
- `docs/design/index.md` still describes current design organization.
- Relevant design doc, ADR, proof README, or draft package README changed with the implementation.
- New public commands or examples pass `pnpm run docs:cli-lint`.
- New ADR references are indexed and pass traceability validation.
- New event families are added to `docs/design/event-families.md` before use.
- New JavaScript-family implementation files are TypeScript `.ts` sources, and `pnpm run standards:check` passes or the exception is recorded in an ADR/proof note.

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

Every PR should include:

- Commits signed off with the DCO (`git commit -s`), per [Licensing of contributions](#licensing-of-contributions).
- Purpose and scope.
- Files or design areas changed.
- Tests and validators run.
- Documentation updated, or a clear reason no docs were needed.
- Known limitations, especially environment limitations or intentionally deferred work.

Prefer small PRs tied to one design claim or one backlog slice.
