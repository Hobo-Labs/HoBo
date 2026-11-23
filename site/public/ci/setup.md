# Set up HoBo CI: from nothing to a first routed job

This page is written for a coding agent working in a person's repository. A
person can hand it over with one prompt:

> Follow https://tyler-r-kendrick.github.io/HoBo/ci/setup.md to route this
> repository's GitHub Actions jobs through HoBo CI. Ask me before you commit,
> push or change anything outside the workflow files and `.hobo/ci.json`.

Do the steps in order. Each ends with a check; do not go on until it passes.
Stop and ask the person wherever a step says so.

HoBo CI routes GitHub Actions jobs. The repository commits a **runner order**
(`runnerOrder` in `.hobo/ci.json`): an ordered list of runner types, such as
the HoBo fleet, connected machines, GitHub-hosted runners and hosted
providers. A job takes the first runner type in the order that can run it
now, waits for a busy one, or fails with one sentence saying why. The design
is ADR-0183:
https://github.com/Hobo-Labs/HoBo/blob/main/docs/ci/runner-order.md

## 0. What you need

- A GitHub repository with workflows under `.github/workflows/`.
- The GitHub CLI, signed in: `gh auth status` must succeed.
- Node.js 22 or later and pnpm.

Check: `gh auth status` and `node --version` both succeed.

## 1. Install the three agent skills

The skills teach you the commands and the safe order of work. Put each
`SKILL.md` where your agent loads skills: `.claude/skills/<name>/SKILL.md` for
Claude Code, `.agents/skills/<name>/SKILL.md` for Cursor and Codex.

| Skill | Teaches |
| --- | --- |
| `hobo-ci` | Every `hobo ci` command, what it writes, and the error codes |
| `hobo-ci-route-jobs` | Plan, review, apply, confirm and undo for a repository's workflows |
| `hobo-ci-insights` | Which command or MCP tool answers which CI question |

```sh
for skill in hobo-ci hobo-ci-route-jobs hobo-ci-insights; do
  mkdir -p ".claude/skills/$skill"
  curl -fsSL "https://raw.githubusercontent.com/Hobo-Labs/HoBo/main/.claude/skills/$skill/SKILL.md" \
    -o ".claude/skills/$skill/SKILL.md"
done
```

Ask the person before adding these files to their repository; they may prefer
to keep them in their own agent settings instead. Read each skill before
going on.

Check: each `SKILL.md` starts with `name:` matching its directory.

## 2. Get the `hobo` CLI

HoBo is pre-release and not on npm. Do not run `npx hobo`: that name belongs
to an unrelated package. Build the CLI from source, outside the person's
repository:

```sh
git clone --recurse-submodules https://github.com/Hobo-Labs/HoBo.git ~/hobo-src
cd ~/hobo-src
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter @hobo/adapter-hono --filter @hobo/hobo
alias hobo="node $HOME/hobo-src/packages/hobo/dist/bin/hobo.js"
```

Check: `hobo ci --help` lists `route` and `init`.

## 3. Write the runner order

From the person's repository, read `.hobo/ci.json` if it exists. With no
`runnerOrder` the default order is `fleet`, then `machine`, then `github`.
Ask the person which runner types they want and in what order, then add the
block. For example, "my machines, then GitHub-hosted while under 80% of the
included minutes, then GitHub-hosted regardless":

```json
{
  "runnerOrder": {
    "steps": [
      { "key": "machine" },
      { "key": "github", "minutesLimitPercent": 80 },
      { "key": "github" }
    ]
  }
}
```

Keep every other key in the file as it was. A broken `runnerOrder` is refused,
never replaced by the default.

Check: `hobo ci route --github ubuntu-24.04 --json` succeeds and prints the
walk. A failure carries a `HOBO_CI_*` code; look it up in the error catalog:
https://github.com/Hobo-Labs/HoBo/blob/main/docs/ci/errors.md

## 4. Preview where jobs would go

`hobo ci route` contacts nothing and changes nothing. Name, per runner type,
the label the job would ask that type for:

```sh
hobo ci route --github ubuntu-24.04 --machine self-hosted --json
hobo ci route --github ubuntu-24.04 --machine self-hosted --public --json
```

The second shows a machine refusing a public repository's job. A runner type
the command does not name is never used for that job. Show the person the
walk: which step took the job and why each earlier step was passed over.

## 5. Plan the workflow change

```sh
hobo ci init --plan --json
```

Each job is ready to move, already moved, or left alone with a reason (a job
that routes other jobs; a job using secrets, an environment or an OIDC token
unless the person asks for `--include-secret-jobs`). Show the person the list.
**Stop** until they choose which jobs move.

## 6. Apply

Routing happens in HoBo CI, never in a workflow. The only change a workflow
gets is `runs-on` set to a HoBo label; HoBo CI routes the job by the runner
order when it claims it. Never add a routing or evaluator job to a workflow.

`hobo ci init --apply <jobs>` rewrites each chosen job's `runs-on` to `hobo`
and keeps the old label in a trailing `# was ...` comment. Such a job runs on
the HoBo fleet, so the repository must first be connected to a relay:
`hobo ci connect github --relay <origin>` with the relay operator's origin and
a `HOBO_CI_ACCOUNT_TOKEN`.

Show `git diff`. Nothing is committed by `hobo ci init`. **Stop:** commit and
push only when the person says so, on a branch, with a message such as
`ci: route jobs through the runner order`.

## 7. Confirm the first routed job

```sh
hobo ci list --json
hobo ci inspect <run-id> --wait --json
```

`hobo ci activity --json` says where each routed job went: `runner`, `step`,
`outcome` (`routed`, `waiting` or `none`) and `reason`. For `none`, fix the
order and push again. For any other failure run `hobo ci diagnose <run-id>`.

Report to the person: which job ran on which runner, and the run's link. The
setup is done when one run shows a job routed by the order.

## Undo

- Fleet label: restore the label from each job's `# was ...` comment, or
  revert the commit.
- To return to the default order, remove `runnerOrder` from `.hobo/ci.json`.
