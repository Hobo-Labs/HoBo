# @hobo/stage-gate

Reusable stage-gate runner (S0-12, and the release gate of ADR-0172). `defineStageGateS0()` declares the ordered S0
toolchain checks (boundary lint, architecture guard, schema drift, PACT
consumer/provider, conformance self-test, sign/verify, hello-bindle determinism
and health, tamper-refuse), `runStageGate` executes them and captures evidence,
and the `hobo-stage-gate` CLI emits an append-only `StageGateRecord` JSON file.
See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full evidence trail.

## Honest scope

Implemented: the check runner (spawning repo `pnpm` scripts, capturing exit codes
and failure output tails), the S0 gate definition, record parse/serialize, and
the fixture scripts under `scripts/` (sign/verify, determinism, health,
tamper-refuse against `@hobo/componentize` output). Not here: no durable event
engine — records are files/CI artifacts, not appends to a running event store —
and the gate does not decide promotion; it only produces the evidence record
other surfaces consume.

## Commands

```bash
pnpm --filter @hobo/stage-gate run build
pnpm --filter @hobo/stage-gate run typecheck   # src, then src + test/ + contracts/ (tsconfig.test.json)
pnpm --filter @hobo/stage-gate run lint
pnpm --filter @hobo/stage-gate run test
pnpm --filter @hobo/stage-gate run test:schema   # cue vet -c of test/fixtures/records; needs cue v0.14.0
pnpm --filter @hobo/stage-gate run test:contract:consumer
pnpm --filter @hobo/stage-gate run test:real   # selected by HOBO_AI_BDD_CMD
```

## Parse, don't validate

Untrusted JSON crosses one parser boundary: `parseStageGateRecord` applies the
protobuf shape plus CUE constraints and returns deep-frozen derived types —
`StageGateRecord`, `CheckResult`, `ComponentArtifact`, `SignatureEvidence` —
and malformed or tampered input throws `StageGateParseError`. Downstream code
consumes only parsed records — parse, don't validate. Wire forms live in
`data-models/stage_gate_record.proto` with CUE constraints alongside.

## ai-bdd run reports (ADR-0172)

`parseAiBddRunReport(bytes)` reads the bytes of an ai-bdd `report.json`
(`RunReport`, `schemaVersion` 1) and returns a frozen `AcceptanceEvidence`
(`data-models/acceptance_evidence.proto` + `.cue`): run id, the sha256 of the
exact bytes read (`report_digest`, equal to `sha256sum report.json`), scenarios
per status, fuzzy steps, model calls, the frozen/no-agent flags and the exit
code. It refuses a report that is not replay-only evidence: `schemaVersion` other
than 1, `options.frozen` or `options.noAgent` false, `options.updateRecordings`
true, any model call (a judge call means the verdict cache `.ai-bdd/cache/` was
cold), a status outside the seven, an exit code outside 0..4, totals that
disagree with the scenarios, exit 0 beside a failed/inconclusive/blocked/error
scenario, exit 0 for a run with no scenario or with none passed or healed (ai-bdd
exits 0 for an empty selection, so that pass replayed nothing), and a run id that
is not one directory name.

HoBo imports no ai-bdd code. The contract on this side is the schema and two
real reports copied byte for byte into `test/fixtures/ai-bdd/` (sha256 and origin
in its README); `src/acceptance-fields.ts` says, for every field the schema
requires, whether the parser reads it or ignores it and why, and
`test/acceptance-fields.test.ts` holds the parser to that table. Every object the
parser walks is closed to its schema key set (`src/report-keys.ts`, compared with
the copied schema by the same test): an unknown key is refused, a required key
that is absent is refused even where the gate ignores its value, a key repeated
in one object is refused, and a scenario's or step's `usage` must be zero like
the run's. The values of ignored fields (`recording`, `mode`, `coverage`,
`warnings`, ...) are not validated.

## The release gate (ADR-0172)

`defineReleaseGate()` (`hobo-stage-gate run release [--out <file>]`) runs ai-bdd's
three replay-only commands against the project in `HOBO_AI_BDD_PROJECT`, with
`HOBO_AI_BDD_CMD` as the command (a JSON argv, default `["ai-bdd"]`; for the
project's own devDependency use its package manager's exec, for example
`["opm","exec","ai-bdd","--"]`, or a path). On Windows the default cannot start:
without a shell Node does not spawn the `ai-bdd.cmd` shim (and refuses a `.cmd`
outright, EINVAL), so `["ai-bdd"]` and `["ai-bdd.cmd"]` are both recorded
`not_run`; name Node and the CLI's script instead,
`["node","<project>\\node_modules\\@ai-bdd\\cli\\dist\\bin.js"]`. Each check is
`scripts/check-acceptance.mts <step>`:

| Check | ai-bdd command | Passes on |
|---|---|---|
| `acceptance-plans-fresh` | `compile --check` | exit 0 (4: a plan is stale) |
| `acceptance-replay` | `run --frozen --no-agent --reporter json,junit` | exit 0 and a report that parses as replay-only evidence with that exit code |
| `acceptance-evidence-intact` | `verify-run <runsDir>/<runId>` for the run the replay judged | that run directory's report has the replay's digest, and exit 0 |

The report must be this run's. Before spawning `run`, the replay step notes the
time and the run directories that exist; after exit 0 or 1 the report's `runId`
must name a run directory that did not exist before, its `startedAt` must be no
earlier than the spawn (5 s of clock skew allowed), that directory must be a
directory, not a symbolic link (ai-bdd makes a new directory for each run and
refuses one that resolves outside `runsDir`; the gate follows no link, and
`evidence-intact` checks again), and it must be the one this ai-bdd named in the
`Run: <dir>` line it prints on stdout after a run that wrote a report (ai-bdd's
`printRunSummary`, on exit 0, 1 and 3). Otherwise the check fails with a
message naming the run id and why, and records nothing of that report: an
earlier run's report survives exit 2 and 4, a wrapper that swallows ai-bdd's
failure, and a CLI that never loaded, and another `ai-bdd run` in the same
project can write the latest report after this one. The skew check fails
closed: when ai-bdd's clock runs more than 5 s behind this one, a run that
really is fresh is refused (`failed`, naming both times), not recorded as
`not_run`; `startedAt` has no upper bound, since the new run directory already
shows the report is new. ai-bdd writes the latest report to
`join(dirname(runsDir), "report")`; the gate takes `runsDir` from
`HOBO_AI_BDD_RUNS_DIR` (relative to the project, default `.ai-bdd/runs`), because
it cannot read a `.ts`/`.mjs` ai-bdd config without running project code. A
project that moves `runsDir` must set it; one that does not fails on freshness.

Each check `requires` the one before it; if that did not pass it is recorded
`skipped` (exit code -1) and never started; when it passed, the runner hands its
evidence to the next check in `HOBO_STAGE_GATE_REQUIRED_EVIDENCE`. That is how
`acceptance-evidence-intact` knows which run to verify: the replay's `run_id` and
`report_digest`, not whatever `report.json` says by then (another run in the
project may have replaced it); `check-acceptance.mts all` hands them over in
process, and `evidence-intact` alone, with neither, is a usage error. The exit
code is read before the
report: after `run` exits 2 or 4 no report was written and an earlier one may
still be on disk; after 3 ai-bdd writes a report when the run reached its
scenarios (not on an internal error), but of a run that could not be carried
out, which says nothing about the product. In all
three cases `report.json` is not opened. Exit 3 and a command that cannot be
started are `not_run` (check and record), never `failed` or `passed`, and the
runner then exits 3. A passed release record holds exactly the three checks; the
replay's evidence of a replay-only run that replayed a scenario (`report_digest`,
`run_id`, `model_calls` "0", `frozen` and `no_agent` "true", `report_exit_code`
"0", `scenarios_total` above 0 and `scenarios_passed` + `scenarios_healed` above
0, each count present and in decimal digits within int64, a leading zero
allowed, as the CUE's `strconv.Atoi` reads it); and evidence-intact naming the same `run_id` and
`report_digest` (`src/record-constraints.ts`, and the same in `stage_gate_record.cue`, where
every field the parser requires is marked `!`: CUE would otherwise fill an
absent `model_calls` with its constraint `"0"` and accept the record).
`test:schema` vets the records in `test/fixtures/records/` with `cue vet -c`
against both schemas and checks that the parser agrees; it needs the cue binary
(`HOBO_CUE_BIN`, the `.tools/cue/v0.14.0` cache the root `test:schema` fills, or
`cue` on `PATH`) and fails without it. An empty `HOBO_CUE_BIN` is unset, as the
bindles CUE gate reads it; one that names no file is an error. Whichever binary
it finds must print `cue version v0.14.0` (or `cue version 0.14.0`, which
schema-tools also takes) as its first line: another patch version is refused,
although it prints `cue.lang.version v0.14.0` too, because the fixtures and the
required fields (`!`) are checked against v0.14.0 only. A passed release record needs no
signature or artifact (the runner writes an unsigned signature and the zero
artifact); those requirements stay S0's.

Every ai-bdd command runs in a process group of its own and is bounded by
`HOBO_AI_BDD_TIMEOUT_MS` (milliseconds, default 30 minutes; a value that is not a
whole number from 1 to 24 hours is a usage error, exit 2). One that outlives it is
stopped and the check is `not_run`, with a reason naming the command and the
bound. Stopping a group (`src/process-group.ts`) sends it SIGTERM, probes it
every 100 ms, and sends SIGKILL to what is left after a grace period of 10 s
(`AI_BDD_GRACE_MS`). What ai-bdd leaves running in its group when it exits is
stopped the same way, and SIGINT or SIGTERM to the check is passed on to the
group (which, being a group of its own, does not see the terminal's Ctrl-C)
before the check exits. The signal goes first because Playwright launches each
browser as the leader of a group of its own, which a signal to ai-bdd's group
does not reach, and closes it from its own SIGTERM and SIGINT handlers. Each
stop ends one of three ways, which the run carries (`AiBddRun.stop`):

- **gone**: kill answered `ESRCH`, so the kernel found no member; nothing more
  is sent.
- **killed**: SIGKILL went to the group, and a probe then found it gone or
  holding only zombies. SIGKILL goes when the grace ends, or at once when, on
  Linux, `/proc` shows every member as a zombie of one thread (state `Z`,
  `num_threads` 1): under a PID 1 or subreaper that never reaps (a container
  whose PID 1 is not an init), zombies would otherwise hold every stop for the
  whole grace, and the scan can miss a member forked while it ran, which the
  group signal reaches (it is atomic with `fork`).
- **unconfirmed**, with a reason: kill answered `EPERM` or `EACCES` (members
  this check may not signal: another user's, such as the command `sudo` or `su`
  runs, or a security module refusing), or members were still running a second
  after SIGKILL was sent (SIGKILL cannot reach another user's members unless the
  check has `CAP_KILL`). The check then records `not_run` with that reason before it
  reads any exit code or report: it never passes over a group it could not
  confirm stopped.

On Linux `/proc` is read only while the kernel still finds a member, so a group
that is gone costs no scan. A member is a process of the group's pgid in the
session ai-bdd leads (it is spawned detached, so it calls `setsid`): processes
of that pgid only in another session mean the number now leads a stranger's
group, ours is gone, and nothing is sent to it. Anything the scan cannot read as
a zombie of the group counts as live and waits out the grace: a process whose
main thread exited while its other threads run (`Z`, `num_threads` above 1), an
entry whose `stat` cannot be read for any reason but its process being gone
(`ENOENT`, `ESRCH`), and a `/proc` that cannot be read or is another PID
namespace's (its `self` does not name the check).

What the stop does not guarantee:

- A process ai-bdd starts in another group that ignores SIGTERM can outlive the
  check. It cannot hold the check open by holding ai-bdd's output: once ai-bdd
  has exited and its group is gone, the output is waited for a second more at
  most.
- A member `/proc` does not list at all (`hidepid=2`, systemd's
  `ProtectProc=invisible`) is not seen. Beside a zombie the group is then
  SIGKILLed at once, which reaches that member if the check may signal it; one
  it may not signal is not reported.
- A process that takes the group's freed number with `setsid` leads a session
  numbered like ai-bdd's, so it counts as a member: between two polls, after
  pid wrap-around, it could be SIGKILLed. There is no pidfd for a process group.
- Where the scan cannot tell a zombie from a member (another PID namespace's
  `/proc`, or `hidepid=1` hiding other users' entries), every member counts as
  live: the stop waits the whole grace, and a group whose zombies are not
  reaped within a second of SIGKILL is reported unconfirmed.

The runner bounds each release check too (`timeoutMs`: ai-bdd's bound plus a
minute, read from the env the runner runs the check with), a backstop that stops the check with SIGTERM (which
it passes on as above) and records it `not_run`. Of ai-bdd's output the check's
stderr gets the first 2 MiB live and the last 2 MiB at exit, with a line saying
how much between them was not relayed (`RELAY_BYTES`, an eighth of the runner's
16 MiB capture limit `CHECK_OUTPUT_LIMIT`), so a passing run that prints a lot
is never killed for its output; the evidence keeps its last 2,000 characters.

Zero model calls is required, and `--no-agent` stops the agent but not the judge:
a subjective step is judged from the verdict cache (`.ai-bdd/cache/`, not
committed) or by a model call. A clean CI checkout therefore replays with zero
model calls only when that cache is restored first (or the suite has no
subjective step); otherwise the replay check fails and names the cache.

The real lane (`test/acceptance-real.test.ts`, `test:real`) runs the gate
against a real ai-bdd and is selected by setting `HOBO_AI_BDD_CMD`; it then also
needs `HOBO_AI_BDD_PROJECT` (a project whose plans, recordings and verdict cache
replay with no agent) and `HOBO_AI_BDD_STALE_DOC` (one of its docs, which the
negative control edits for one run and restores). Once selected it fails, never
skips, when either is missing or the command cannot run (the gate then records
`not_run`, which the lane does not accept). ai-bdd's offline test project (fake
driver and fake models, built by its `tests/acceptance/helpers/project.ts`) is a
project of that kind; its CLI is
`["node","--conditions=source","<ai-bdd>/packages/cli/src/bin.ts","-c","<the project's test config>"]`
and needs ai-bdd's own dependencies installed (no build: Node runs its sources).

Run on 2026-10-17 against ai-bdd `7f9456a` (`main`, the merge of its run report
schema), its dependencies installed by the package manager (`opm ci`, 361
packages, 352 from the shared store, no install script run): a project laid out
as `createProject` does (the corpus config, the `release-notes` and `reports`
docs, the base fake-model rules, a test config as `writeTestConfig` writes it),
compiled and characterized once (`compile`, then `run`: 10 model calls,
recordings created), then `test:real` with
`HOBO_AI_BDD_STALE_DOC=docs/release-notes.md`: both tests passed, the stale
control failing `acceptance-plans-fresh` with exit 4 and starting nothing after
it. The release record of that project (`hobo-stage-gate run release`) passed
with `report_digest` `sha256:c40d6ce5...cf4ce3a`, equal to `sha256sum
.ai-bdd/report/report.json`, `model_calls` 0 and 2 scenarios replayed, the
report bound to the `Run: .ai-bdd/runs/<id>` line ai-bdd printed, and `cue vet
-c` accepts the record. `HOBO_AI_BDD_CMD='["/bin/true"]'` over the same
project's real report failed the replay on freshness, and SIGINT to
`check-acceptance.mts replay` mid-run reached ai-bdd ("interrupted, finishing
up"), after which the check exited 130 with no ai-bdd process left. (The first
record, on 2026-10-17 against the pull request's `4190d7e`, passed the same
way.)

The gate's tests run real processes against a stand-in ai-bdd
(`test/helpers/fake-ai-bdd.mts`) that plays back
`contracts/pacts/stage-gate-ai-bdd-report.pact.json`, one interaction per exit
code, writing the copied real reports.

## Position in the event architecture

This package is build/CI-time tooling: it hosts no actor and runs no durable
event engine. The gate run is the command, each check completion appends a
`CheckResult` to the run record (append-only evidence, never mutated), the
emitted `stage-gate-s0.record.json` is the current-run snapshot, and acceptance
docs/CI artifacts are the read store that projects the latest passed record.
