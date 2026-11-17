---
type: One-Shot Agent Instruction
title: "One-shot instruction — optional Atuin memory provider + HoBo command journal"
description: >
  Self-contained swarm prompt. Adversarial critique of the Atuin-integration
  conversation, hardened decision, and file-disjoint work packages that land
  optional Atuin history (read-only) plus a Station-scoped native command
  journal in @hobo/code. No Atuin fork, no Atuin AI, no nested PTY proxy,
  no silent hook install.
tags: [hobo, plans, hobo-code, atuin, terminal-memory, one-shot]
---

# One-shot: Atuin as optional memory, HoBo as control plane

> Historical plan: `packages/code` and the `hobo-code` product were removed.
> The instructions and paths below are preserved as a record and are not an
> active implementation assignment.

Everything below this line is the prompt. Hand it (or this file's path) to a
coding agent with repo access. It requires no other chat. Do not reopen the
Atuin-vs-emulate debate. The decision is locked. Implement it.

## Mission

You are the coordinating agent in the HoBo repository. Land **optional Atuin
terminal memory** and a **HoBo-native command journal** in one pass.

Dispatch the six file-disjoint swarms **in parallel**, each in its own isolated
git worktree. When they return, you (and only you) edit the shared wiring
files listed under Integration. Then validate and stop.

There are no phases, no timelines, no follow-up waves, and no "later we will
add Atuin AI / hex / Litestream sync / atuin-server Bindle." Those are
explicitly out of scope.

## Locked decision

**HoBo owns the magical terminal memory.** Atuin is inspiration only —
never a HoBo-deployed sidecar, never a hard dependency.

**Atuin is not shipped or hosted by HoBo.**
**HoBo is the terminal control plane.**

| Plane | Owner | What it is allowed to do |
|---|---|---|
| History search of the user's existing shell | Atuin, if present | Read via `atuin mcp` / `atuin search` |
| Encrypted cross-machine sync of that shell history | Atuin, if the user already configured it | Remain Atuin's problem. Do not reimplement. Do not write Atuin's DB. |
| Panes, tmux, agent identity, exact-effect auth, review, Evidence, occupancy | HoBo | Authoritative |
| Commands HoBo itself launched (resident panes, `/dev`, harness tools, review publish) | HoBo journal | Durable, Station × env scoped snapshot |
| Command output | Two tiers | Ephemeral ring (never synced). Pinned artifact only when the user or an exact-effect grant says pin. |
| AI `?` / Atuin Hub / Atuin skills / `TERMINAL.md` exec | Not HoBo | Do not start, wrap, or canonicalize |
| Dotfiles / aliases / env sync | Not this landing | Detect only. Never import Atuin aliases into Stations |
| PTY | HoBo owns panes it launched | Do not nest `atuin pty-proxy` under tmux → hobo-code → shell |

If Atuin is missing, every HoBo surface still works. The native journal and
doctor chip are the only required path.

## Adversarial critique of the incoming conversation (read this; do not re-argue)

The incoming "hybrid" write-up is directionally right and factually sloppy in
ways that would ship the wrong product. These kills are binding.

1. **`hex` is dead.** Current Atuin docs: `atuin pty-proxy` replaced `atuin hex`.
   `hex` remains as a compatibility alias. Do not document or invoke `hex`.
2. **Atuin's search-vs-output TUI problem is already solved by tmux popups.**
   Atuin docs say: if you already use tmux, set `[tmux] enabled = true` and
   skip pty-proxy. hobo-code **already** owns tmux (`packages/code/src/mux.ts`,
   `resident-session-runtime.ts`). Nesting pty-proxy under
   `terminal → tmux → hobo-code TUI → Atuin pty-proxy → shell` is a PTY war
   (alt-screen, resize, OSC 133 duplication, crash restore). Kill it.
3. **The linked `atuin-server` page is sync, not AI.** `server.toml` /
   `ATUIN_DB_URI` is encrypted history/dotfile sync. Atuin AI is a separate
   service. Do not ship an Atuin AI sidecar. Do not treat `atuin-server` as
   "the AI backend."
4. **`db_uri` is a secret.** A `@hobo/package-atuin-server` Bindle with a
   postgres URI is residual classical credentials, not a secretless showcase
   (ADR-0027). Do not add that package.
5. **"Litestream-default" is a lie as used.** ADR-0135 makes **SQLite** the
   default EventStore engine. Litestream is optional replication, not the
   history sync plane, and not a reason to skip Atuin's E2EE store. Do not
   replicate Atuin rows through Litestream.
6. **Per-user `~/.local/share/atuin` leaks isolation.** One UNIX user can
   occupy many Stations, rifts, and PAM-elevated panes. Importing global
   Atuin history into a Station session without a grant is a cross-Station
   peek (ADR-0131 fail-closed). Default import filter: current workspace cwd
   prefix **and** current `HOBO_ENV`. Broader import requires an explicit
   user grant recorded on the journal (`grant: "atuin-unscoped"`), never a
   repo file.
7. **Silent hook install is forbidden.** `atuin hook install claude-code|codex|pi`
   writes `~/.claude/settings.json`, `~/.codex/hooks.json`,
   `~/.pi/agent/extensions/atuin.ts`. hobo-code must **detect** those files,
   never write them.
8. **`atuin mcp` session filter is usually a no-op.** Docs: `session` mode
   only works when MCP is launched from an Atuin-enabled shell. Editors and
   hobo-code will launch it as a child. Use `workspace` / `directory` /
   `host` / `global` (the last only with grant).
9. **Atuin MCP is read-only and Bash-only.** Hooks record `Bash` / `bash`
   tool calls, not file edits, MCP, review, or deploys. It cannot be the
   execution ledger. The HoBo journal is.
10. **Output is a 128×1MB in-memory ring.** It dies with the daemon. Do not
    treat `atuin_output` as Evidence. Evidence stays `session-evidence.ts`.
11. **Do not write Atuin's SQLite.** History SQLite is derived from an
    encrypted append-only record store. Direct writes bypass sync and
    encryption.
12. **Do not emulate `TERMINAL.md` shell substitutions.** Repo-controlled
    executable context is a supply-chain hole. HoBo context is inert data
    (parse-don't-validate). ADR-0023: untrusted text never widens a grant.
13. **Do not copy Atuin's permission lattice.** Deeper `allow` beating a
    parent `deny` is backwards for cloned repos. HoBo already has exact-effect
    authorization (`packages/code/src/review/review-runtime.ts`). Keep it.
14. **Do not make Atuin AI the orchestrator.** It duplicates model routing,
    tools, sessions, skills, and identity. Inspiration only.
15. **Suvadu / McFly / hiSHtory / atty / navi / carapace / chezmoi** are
    alternatives, not deliverables. Do not add them.
16. **Recipe-from-history promotion** (history → alias → skill → template)
    is YAGNI for this landing. The journal must be queryable; it must not
    grow a recipe compiler.
17. **A new `packages/events` body** would require a total upcaster and an
    append-only `golden-replay-baseline.json` entry. Do **not** add a new
    public event family. Persist a snapshot file like `endpoints.json`.
18. **Split-brain "last deploy command"** is the product failure mode.
    Every UI row and tool result must carry `trust: "hobo-executed" |
    "externally-imported"` and `source`. Prefer `hobo-executed` when both
    exist for the same argv+cwd window.

## Shared repo facts (re-verify paths; do not invent new packages)

- Product: `packages/code` (`@hobo/code`), CLI `hobo-code`. Chrome is the
  rubberhose TUI (`interactive-shell.ts`, `tui-*.ts`), not a SaaS dashboard.
- Occupancy header is Station (ADR-0131), not a topology parent.
  Topology is Bindle ⊂ Camp ⊂ Yard ⊂ Junction.
- Session scope already exists: `describeAuthedStationSession` +
  `assembleSessionResources` in `session-resources.ts`. Last-seen URLs live
  at `$HOBO_HOME/durable/code/sessions/<stationId>/<env>/endpoints.json`.
  The command journal snapshot lives **beside** that file as `commands.json`.
- Evidence journal is `session-evidence.ts` (asks/decisions/looks). Do not
  merge shell history into Evidence.
- Tasks board is `grok-build-parity.ts` / `hobo-code tasks`. History is not
  Tasks.
- Review exact-effect publish is `review/review-runtime.ts` + EventStore
  `hobo-code-reviews`. Do not put shell history in that aggregate.
- Resident panes are tmux: `mux.ts`, `resident-session-runtime.ts`.
  `send-keys` already exists. Agent exit is `@hobo_agent_exit`.
- Harness tools (ADR-0139) live in `harness-tools.ts` and must stay the
  single tool source. New tools go there **only in Integration**.
- Dual harness: Pi TUI + Flue (`harness-surface.ts`). Tools route through
  `runHoboCodeCli`.
- Doctor/status composition: `platform.ts`.
- Secretless: ADR-0027. No plaintext in events, agent context, or IaC.
- Tests: Vitest. `pnpm --filter @hobo/code exec vitest run test/<file>`.
  Never `node --test`. Never broad `test/*.test.ts`. Never live Atuin,
  live Postgres, or network.
- New TS files only (`.ts` / `.mts`). No new `.js`.
- Exported string literals need `// public-contract: <why>` on the previous
  line. Prefer one schema const.
- `exactOptionalPropertyTypes` is on: do not assign `undefined` to `?: T`.
- Design: `packages/code/DESIGN.md` (rubberhose). No SaaS blues. Ink table.
- Docs freshness: any `src/` change needs a docs change in the **same**
  Integration commit (`packages/code/README.md` + `ARCHITECTURE.md` + this
  plan already exists).
- Do not edit: `.github/workflows/**`, `site/DESIGN.md`, `pnpm-lock.yaml`
  unless a new MIT/Apache dep is unavoidable (it is not — stdlib only),
  `AGENTS.md`, `package.json` (no new dependency), Atuin itself.

## Hard constraints (repeat in every swarm prompt)

1. No live `atuin` binary in tests. Fake the CLI with a stub spawn.
2. No writes to `~/.config/atuin`, `~/.claude`, `~/.codex`, `~/.pi`.
3. No reads of real user Atuin DB in tests. Fixtures only.
4. No `child_process` of a login shell to "init" Atuin.
5. No secrets in snapshots. Redact before persist and before model.
6. No new npm packages.
7. No new EventStore event family.
8. No Atuin AI, pty-proxy process, or atuin-server Bindle.
9. Isolation fail-closed: unscoped Atuin import without grant returns
   `HOBO_ATUIN_SCOPE_REQUIRED`, empty rows, remediation text.
10. Untrusted Atuin/MCP JSON is parsed once into a branded type. Core
    functions accept only the branded type.

## Schema (shared; implement exactly)

```ts
// public-contract: HoBo command journal snapshot
export const COMMAND_JOURNAL_SCHEMA = "hobo.code.command-journal/v1" as const;

export type CommandActorKind = "human" | "agent" | "automation";
export type CommandTrust = "hobo-executed" | "externally-imported";
export type CommandSource =
  | "hobo-pty"
  | "hobo-harness"
  | "atuin-mcp"
  | "atuin-search";
export type CommandSensitivity = "public" | "internal" | "secret-suspected";

export type CommandActor = {
  readonly kind: CommandActorKind;
  readonly name: string;
  readonly instanceId: string;
  readonly generation: number;
};

export type CommandOutcome = {
  readonly exitCode: number;
  readonly signal?: string;
  readonly durationMs: number;
};

export type CommandEvent = {
  readonly schemaVersion: typeof COMMAND_JOURNAL_SCHEMA;
  readonly id: string;
  readonly recordedAt: string;
  readonly stationId: string;
  readonly environment: string;
  readonly sessionId: string;
  readonly paneId?: string;
  readonly actor: CommandActor;
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly command: string;
  readonly outcome?: CommandOutcome;
  readonly sensitivity: CommandSensitivity;
  readonly trust: CommandTrust;
  readonly source: CommandSource;
  readonly atuinHistoryId?: string;
  readonly outputPinId?: string;
};

export type AtuinCapability = {
  readonly binary: boolean;
  readonly version?: string;
  readonly mcp: boolean;
  readonly daemon: boolean;
  readonly ptyProxyConfigured: boolean;
  readonly hookClaude: boolean;
  readonly hookCodex: boolean;
  readonly hookPi: boolean;
  readonly syncConfigured: boolean;
};
```

`command` is `argv.join(" ")` after parse. Never store a raw shell line that
was not argv-split when the source is `hobo-*`. Atuin imports may only have
`command` (no argv); set `argv: Object.freeze(command.split(/\s+/u))` as a
best-effort display split and keep `trust: "externally-imported"`.

## Swarm dispatch

Launch all six as `general-purpose` subagents, `isolation: "worktree"`,
`capability_mode: "all"`. Each prompt must include this file's Hard
constraints, Schema, and that swarm's section **verbatim**. They must not
edit files outside their allowlist. They commit on their worktree with a
conventional scoped message. They write `.sdlc/report.json`:

```json
{ "ok": true, "files": [], "tests": "", "notes": [] }
```

### Swarm A — `atuin-probe`

**Allowlist**

- `packages/code/src/atuin-probe.ts` (create)
- `packages/code/test/atuin-probe.test.ts` (create)

**Job.** Pure capability probe. No network. No MCP session.

- `probeAtuin(options?: { readonly env?: NodeJS.ProcessEnv; readonly which?: (name: string) => string | undefined; readonly stat?: (path: string) => boolean; readonly exec?: (argv: readonly string[]) => { ok: boolean; stdout: string } })`
- Resolve binary from `PATH` via injected `which` (default: `process.env.PATH` scan, no `shell: true`).
- If missing: `{ binary: false, mcp: false, daemon: false, …hooks false }`.
- If present: run `atuin --version` through injected `exec`. Parse a semver-ish string. Never throw.
- `mcp`: `atuin mcp --help` exits 0 or stdout contains `atuin_history`.
- `daemon`: `atuin daemon status` ok, or `ATUIN_DAEMON=1` is **not** used as proof (env is not a daemon). Prefer `XDG_RUNTIME_DIR/atuin.sock` existence via `stat` if documented path exists; otherwise treat daemon as unknown/false.
- Hooks: `stat` `$HOME/.claude/settings.json` containing `atuin`, `$HOME/.codex/hooks.json` containing `atuin`, `$HOME/.pi/agent/extensions/atuin.ts` exists. Use injected HOME from `options.env`.
- `ptyProxyConfigured`: `stat` `$XDG_CONFIG_HOME/atuin/config.toml` or `~/.config/atuin/config.toml` and look for `[pty_proxy]` / `pty-proxy`. Read as text; do not execute.
- `syncConfigured`: same file contains `sync_address` or `[sync]`.
- Export `formatAtuinProbe(probe): string` — one scan, no emoji spam. Missing binary says `atuin: absent` + remediation `install atuin (optional) · https://docs.atuin.sh`.
- Export `ATUIN_SCOPE_ERROR = "HOBO_ATUIN_SCOPE_REQUIRED"` with public-contract marker.

**Tests (must fail first, then pass)**

- Missing binary → all flags false, format mentions absent.
- Stub exec version + mcp help → `binary` and `mcp` true.
- HOME fixtures for the three hook paths.
- Never calls real `atuin`.
- `exec` is not invoked with `shell: true`.

### Swarm B — `command-redaction`

**Allowlist**

- `packages/code/src/command-redaction.ts` (create)
- `packages/code/test/command-redaction.test.ts` (create)

**Job.** Classify and redact command text + optional output **before**
persist or model.

- `classifyCommand(command: string): CommandSensitivity`
- `redactCommand(command: string): string`
- `redactOutput(text: string, maxBytes: number): { text: string; truncated: boolean; sensitivity: CommandSensitivity }`

Heuristic (deterministic, no ML):

- `secret-suspected` if the line matches `token=`, `password=`, `Authorization:`,
  `AKIA[0-9A-Z]{16}`, `ghp_`, `github_pat_`, `xox[baprs]-`, PEM headers,
  `-----BEGIN`, or a `--token` / `--password` argv flag with a value.
- Replace flagged values with `***`.
- Cap output at `maxBytes` (default 8192) on the **redacted** text.
- Never throw on garbage input.

**Tests**

- `hobo-code status` → public, unchanged.
- `curl -H 'Authorization: Bearer ghp_aaa' https://api.github.com` →
  secret-suspected, bearer redacted.
- Output longer than maxBytes truncates and sets `truncated: true`.
- Empty string is public.

### Swarm C — `session-command-journal`

**Allowlist**

- `packages/code/src/session-command-journal.ts` (create)
- `packages/code/test/session-command-journal.test.ts` (create)

**Job.** Snapshot IO + parse. Same directory helper style as
`session-resources.ts` (`sessionDir(hoboHome, stationId, environment)`).

Path: `$HOBO_HOME/durable/code/sessions/<stationId>/<env>/commands.json`

```ts
export type CommandJournalSnapshot = {
  readonly schemaVersion: typeof COMMAND_JOURNAL_SCHEMA;
  readonly stationId: string;
  readonly environment: string;
  readonly recordedAt: string;
  readonly grantAtuinUnscoped: boolean;
  readonly events: readonly CommandEvent[];
};
```

- `emptyJournal(scope)` — ok snapshot, `events: []`, grant false.
- `readCommandJournal({ hoboHome, stationId, environment })` — missing file
  is empty, not an error. Corrupt JSON is empty + does not throw.
- `appendCommand(input)` — parse-don't-validate: reject empty command,
  empty stationId, empty environment. Stamp `id` (crypto random UUID),
  `recordedAt`. Cap file at 500 events (drop oldest). Call redaction on
  `command` before write if Swarm B is importable; **if you cannot import
  a file you do not own, duplicate a 10-line local redact of
  `secret-suspected` only** — do not edit Swarm B's files. Integration
  will switch the import to Swarm B.
- `grantAtuinUnscoped` / `revokeAtuinUnscoped` flip the flag.
- `queryJournal(snapshot, { q?, failedOnly?, authorKind?, limit? })` —
  substring match on `command`, filter exitCode !== 0, filter actor.kind.
  Default limit 20, max 50.
- Logged-out / missing station: callers pass stationId `"auth:out"` and get
  an in-memory empty journal; **do not write** that path.

**Tests**

- Round-trip append + read in a temp HOBO_HOME.
- Cap 500.
- Corrupt file → empty.
- Query failedOnly.
- Grant flag persists.
- `token=secret` stored redacted.

### Swarm D — `atuin-history-port`

**Allowlist**

- `packages/code/src/atuin-history-port.ts` (create)
- `packages/code/test/atuin-history-port.test.ts` (create)
- `packages/code/test/fixtures/atuin-mcp-history.json` (create)

**Job.** Read-only adapter. Never start a long-lived daemon.

```ts
export async function searchAtuinHistory(input: {
  readonly probe: AtuinCapability; // accept structural type; do not import probe file if that creates a cycle — duplicate the 8 boolean fields
  readonly cwd: string;
  readonly stationId: string;
  readonly environment: string;
  readonly grantUnscoped: boolean;
  readonly q: string;
  readonly failedOnly?: boolean;
  readonly author?: "human" | "agent" | "any";
  readonly spawn?: (argv: readonly string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
}): Promise<{ ok: boolean; code: string; events: readonly CommandEvent[]; message?: string }>
```

Behavior:

- `probe.binary === false` → `{ ok: true, code: "HOBO_ATUIN_ABSENT", events: [] }`.
- No grant and you cannot prove workspace scope → still **attempt** scoped
  search: pass cwd to the stub as `ATUIN_CWD` and filter results so
  `cwd === input.cwd || cwd.startsWith(input.cwd + "/")`. If after filter
  you would have dropped everything that existed in the raw fixture **and**
  `grantUnscoped === false`, return
  `{ ok: false, code: "HOBO_ATUIN_SCOPE_REQUIRED", events: [] }`.
- Default spawn argv: `["atuin", "search", "--format", "json", "--cwd", cwd, "--", q]`
  when `failedOnly` add a filter if the stub understands `--exit 1`; do not
  require a real flag that we cannot prove. Prefer JSON lines.
- Parse fixture shape:

```json
[{ "id": "h1", "command": "pnpm test", "cwd": "/tmp/app", "exit": 0, "duration": 12, "timestamp": "2026-08-14T00:00:00.000Z", "author": "user" }]
```

- Map to `CommandEvent` with `trust: "externally-imported"`,
  `source: "atuin-search"`, `atuinHistoryId: id`,
  `actor.kind` from author (`claude-code|codex|pi|copilot|opencode` → agent).
- `generation` for imported agents is `0` (unknown). Never pretend it is
  the current HoBo generation.
- `output` tool is **not** implemented. If asked, export
  `readAtuinOutput()` that returns
  `{ ok: false, code: "HOBO_ATUIN_OUTPUT_UNSUPPORTED" }` and a message
  that output is ephemeral and Evidence is the durable path.

**Tests**

- Absent probe → empty ok.
- Fixture two rows, one outside cwd, no grant → only the in-cwd row.
- All rows outside cwd, no grant → `HOBO_ATUIN_SCOPE_REQUIRED`.
- Grant true → both rows, still tagged `externally-imported`.
- Agent author mapping.
- `readAtuinOutput` refuses.

Do not implement a real MCP stdio client. argv + JSON is enough and
testable. Integration may later swap spawn for `atuin mcp` if a mock
protocol is added — not required.

### Swarm E — `osc133`

**Allowlist**

- `packages/code/src/osc133.ts` (create)
- `packages/code/test/osc133.test.ts` (create)

**Job.** Pure OSC 133 segmenter. No PTY. No tmux. This exists so HoBo
panes can later split prompt/output without Atuin pty-proxy.

Parse `\x1b]133;A` (prompt start), `\x1b]133;B` (prompt end / command
start), `\x1b]133;C` (output start), `\x1b]133;D;exit` (command end)
from a string of mixed text.

```ts
export type Osc133Segment =
  | { readonly kind: "prompt"; readonly text: string }
  | { readonly kind: "command"; readonly text: string }
  | { readonly kind: "output"; readonly text: string; readonly exitCode?: number };

export function splitOsc133(buffer: string): readonly Osc133Segment[];
```

Unmarked text is a single `output` segment. Incomplete sequences stay
unemitted (return only complete segments). Strip the CSI/OSC bytes from
`text`.

**Tests**

- Golden fixture with A/B/C/D and exit 1.
- Unmarked blob → one output segment.
- Truncated OSC at end → not emitted.
- Does not treat `\x1b[` color codes as OSC 133.

### Swarm F — `docs-terminal-memory`

**Allowlist**

- `docs/design/terminal-memory.md` (create)
- `docs/design/index.md` (add one table row only)
- `docs/plans/index.md` already lists 0021 after you land; if the row is
  missing, add it. Do not rewrite other rows.

**Job.** Design note, not a tutorial. Must state:

- Atuin optional read-only provider.
- HoBo journal path and schema id.
- Isolation rule + grant.
- PTY: HoBo owns launched panes; tmux popup if the user wants Atuin TUI;
  never nest pty-proxy.
- Output: ephemeral vs pin; Evidence is not shell history.
- Exact-effect remains the auth boundary.
- `TERMINAL.md` exec is rejected.
- Atuin AI / atuin-server Bindle / hex / Litestream-as-history-sync are
  non-goals.
- OKF frontmatter: `type: Design Note`.

## Integration (coordinator only — after all six return)

**You may edit only**

- `packages/code/src/index.ts` (export new symbols; no barrel rewrites beyond
  the existing pattern)
- `packages/code/src/cli.ts` (add `history` verb)
- `packages/code/src/interactive-shell.ts` (slash `/history`, Tab-able if
  the slash table is the only rail; do not invent a sixth default Tab
  unless `/resources` already shows the pattern — prefer slash + CLI)
- `packages/code/src/harness-tools.ts` (add `hobo_history` tool that calls
  the CLI JSON path)
- `packages/code/src/platform.ts` (include `atuin` probe on doctor/status)
- `packages/code/src/resident-session-runtime.ts` (append journal events
  when a pane command exits if you can do so without destabilizing tmux
  tests; if the file is too hot, append only from `workspace-actions.ts`
  `/dev` and from the `history record` CLI used by tests)
- `packages/code/src/workspace-actions.ts` (record `/dev` start as
  automation)
- `packages/code/README.md`, `ARCHITECTURE.md`, `DESIGN.md` (short
  paragraphs, rubberhose, honest optional Atuin)
- `packages/code/test/cli.test.ts` (one history --json case)
- `packages/code/test/harness-surface.test.ts` or the existing status test
  if one asserts doctor chips — only if it already exists

**CLI contract**

```
hobo-code history [--json] [--failed] [--author human|agent|any] [query]
hobo-code history grant-atuin
hobo-code history revoke-atuin
hobo-code doctor   # existing; add atuin row via platform.ts
```

`history` without Atuin still prints the native journal. With Atuin, print
native rows first, then imported rows labeled `imported`. JSON:

```json
{ "ok": true, "journal": { "...snapshot" }, "atuin": { "ok": true, "events": [] } }
```

Logged out: `ok: false`, `HOBO_AUTH_REQUIRED`, empty journal, no file write.

**Harness tool**

```
name: hobo_history
description: Search HoBo-executed commands for this Station × env. Optional Atuin import is scoped to cwd unless the user granted unscoped import. Read-only. Never returns raw secrets.
input: { q?: string, failedOnly?: boolean, author?: "human"|"agent"|"any" }
```

Runs `history --json` with flags. Do not spawn Atuin from the tool.

**TUI**

Ink table: time · author · trust · command · exit. Spark only for
`secret-suspected` (show redacted command). Go only for exit 0 on
`hobo-executed`. Do not take over the transcript. Empty logged-out card
matches `/resources` tone.

**Resident pane recording**

If wiring `resident-session-runtime.ts` risks breaking tmux tests, skip
it and record via CLI `history` in unit tests plus `/dev` in
`workspace-actions.ts`. Say so in ARCHITECTURE. A journal that only
records `/dev` + explicit CLI is still honest.

## Validation (coordinator)

```
pnpm --filter @hobo/code exec vitest run \
  test/atuin-probe.test.ts \
  test/command-redaction.test.ts \
  test/session-command-journal.test.ts \
  test/atuin-history-port.test.ts \
  test/osc133.test.ts
```

Plus the one CLI/harness test you added.

Then `pnpm agent:check -- --staged` before commit. Do not run repo-wide
test sweeps.

Merge worktrees into the parent with the Integration commit:

```
feat(code): optional Atuin memory + command journal
```

Body: why (isolation + no second orchestrator), not a file list.

## Acceptance checklist

- [ ] Atuin absent: `hobo-code history --json` works from the native journal.
- [ ] Atuin present in probe stubs: imported rows are `externally-imported`.
- [ ] Cross-cwd Atuin rows refused without grant.
- [ ] Grant/revoke persist on the snapshot.
- [ ] Secrets never stored or returned to the model tool.
- [ ] No file under `~/.claude`, `~/.atuin`, `~/.codex`, `~/.pi` is written.
- [ ] No `atuin pty-proxy`, `atuin hex`, Atuin AI, or atuin-server Bindle.
- [ ] No new EventStore event family.
- [ ] OSC 133 parser exists and is unplugged from any PTY (ready, not live).
- [ ] Docs name the isolation rule and the non-goals.
- [ ] DESIGN.md still rubberhose; history is an ink table.

## What "done" is not

Not a magical Ctrl-R. Not Atuin Desktop runbooks. Not Trails. Not cq
training on history. Not a Station-hosted sync server. Not a PTY overlay
library. Those remain user-space Atuin or later HoBo work.

The differentiating sentence you must not violate:

> Atuin remembers what the user's shells ran. hobo-code remembers what
> it executed, who (generation) authorized it, and whether that row is
> ours or imported.
