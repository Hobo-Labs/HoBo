# `@hobo/code` · binary **`hobo-code`**

Catalog patterns and atomic snippets render through **`hobo-code template`**
and **`/template`** (ADR-0153). That route is offline and records
`0 LLM calls · 0 LLM tokens`. Known chat phrases (ADR-0152) still emit from
the interactive session.

```bash
hobo-code template list
hobo-code template "web frontend backed by an api"
hobo-code template render bindle.named --params '{"resourceName":"shop"}'
hobo-code
# then: /templates
#        /template frontend backed by an api
#        create a hello world app
#        deploy to azure
#        /review
```

Durable review (ADR-0154) is a separate aggregate from the session:

```bash
hobo-code review start --target range --base HEAD^ --head HEAD
hobo-code review mark --id <reviewId> <fileId>
hobo-code review thread --id <reviewId> "please name this constant"
```

**App-building agent / helper** for HoBo — not a control-plane management CLI.

CLI name is **`hobo-code`** (dash is fine). There is **no** `hobo code` nested verb.

### Build vs install (read this)

The installed binary is **compiled** (`dist/`). Source lives in `src/`.

| Do this | Not this |
|---|---|
| `pnpm --filter @hobo/code build` then `hobo-code …` | Only edit `src/` and assume `~/.local/bin/hobo-code` updated |
| Link bin: `pnpm --filter @hobo/code link --global` (uses `bin/hobo-code.mjs`) | Symlink straight at `dist/bin/hobo-code.js` and forget rebuilds |
| Evidence / optimizexp: exercise the **installed** `hobo-code` after build | Capture only via `node --import tsx src/bin/…` (can pass while dist is stale) |

`bin/hobo-code.mjs` **tries** to rebuild when `src/` is newer than `dist/`
(`tsc` for `@hobo/code` only — no nested `@hobo/core` / stations prebuild
fan-out). If workspace `@hobo/stations` `dist/` is missing exports that its
`src/` already has (common after a fast-forward), the launcher also runs
`tsc -p` in that package only — still no `pnpm run build` prebuild fan-out.
Skip stations refresh with `HOBO_CODE_SKIP_STATIONS_REBUILD=1`. A type error
in an unrelated file **does not block the CLI**: the launcher falls back to
`src/bin/hobo-code.ts` via tsx so you can still run `hobo-code agents init`.
Skip code rebuild with `HOBO_CODE_SKIP_STALE_REBUILD=1`. Force source with
`HOBO_CODE_FROM_SOURCE=1`. If even src cannot load, run
`pnpm exec turbo run build --filter=@hobo/code`.

The Vitest config reuses the root `hobo-test-homes.ts` and
`isolate-hobo-home.ts` setup. Every test file gets a throwaway `HOBO_HOME`
inside a per-run temporary root, removed when the run ends; a `HOBO_HOME` set by
the runner is preserved. This keeps package tests from writing `/tmp/.hobo`
under turbo's strict environment or the developer's real `~/.hobo` outside it.

The launcher runs `dist/bin/hobo-code.js` (or `src/` via tsx) as a child, in a
session of its own except on Windows, so neither a signal sent to `hobo-code`
nor the terminal's hangup reaches that child directly. The launcher passes
SIGINT, SIGTERM, SIGHUP and SIGQUIT on to it, the SIGHUP of a closing terminal
included, waits for it to end, and exits with its status, or 128+n when it
ends by signal n. Killed outright (SIGKILL), the launcher passes nothing on:
the child sees its IPC channel to the launcher close and quits as on SIGHUP.
On Windows the child shares the console, and only SIGINT and SIGTERM are
passed on.

| Binary | Product |
|---|---|
| **`hobo-code`** | App-building coding agent plus local browser-debug deployment (this package) |
| **`hobo`** | Control-plane shell (`up` / `dev` / `plan` / …) — **not** the coding harness |

### Interactive TTY (bare `hobo-code`)

On a real TTY, bare `hobo-code` opens the **HoBo InteractiveShell**, drawn to
the rubberhose identity in [`site/DESIGN.md`](../../site/DESIGN.md) — Steamboat
Willie ink and Cuphead title cards, *never flat SaaS chrome*
([`DESIGN.md`](./DESIGN.md) — same tokens as the site). Chrome is a retained
TUI component tree (queryable by id/role/class); `pi-tui` only paints frames:

- **Title card** on entry: the Chewy wordmark framed in ink, then it scrolls
  into the transcript. It is a moment, not a permanent header.
- **Ink cards** with hard sticker shadows (`┏━┓` + offset `▒`), not hairline
  rules or soft Material elevation.
- **The transcript is the surface** — roughly 19 content rows on an 80x24,
  where the previous chrome left about 8. A command rail
  (`[ /dev ] [ /templates ] [ /hobo ] …`) sits on the card so slash verbs
  are visible without opening the palette. `/templates` and bare `/template`
  list the local catalog (zero LLM); `/template <query>` searches.
- **Strict black and white.** Vermillion appears only for a decision that can
  change the real tree; green only for done. `NO_COLOR` is honoured.
- **Bo** rides the one-line status strap and squash-stretches only while a
  turn is in flight (reduced motion keeps him still).
- **Station sidecars** start with the session: the Aspire dashboard
  (`http://dashboard.code.local.hobo.localhost:8787`), the Evidence SPA
  (`http://evidence.code.local.hobo.localhost:8788`), the always-on
  evals sidecar (`http://evals.code.local.hobo.localhost`) hosting gold
  exact-match and silver property/fuzz suites (`POST /run` loads live
  `.js` / `.mjs` / `.cjs` invokers, including a sibling next to a
  TypeScript `"use training"` region), and the Station-local OpenDelivery sidecar
  (`http://rollout.code.local.hobo.localhost`) that runs the real
  `hobo:delivery` engine — Bindle `rollout` is not a Camp/cloud mock.
  Experiments are not a catalog row: occupancy always starts the
  Station-local OpenExperiment sidecar
  (`http://experiment.code.local.hobo.localhost`) that runs the real
  `hobo:experiment` engine. Residual secret and crypto Bindle kinds
  use a Station-local KMS sidecar
  (`http://kms.code.local.hobo.localhost`) — real RSA-2048 + AES-256-GCM
  on the occupancy host, persisted under the Station home.
  Command history, aliases, and env vars live in a Station SQLite sidecar
  (`http://history.code.local.hobo.localhost`) — frecency search, no Atuin
  binary, no off-box sync. `hobo-code history` / `hobo-code alias`.
  A local Station
  auto-seeds `yard:local` with `camp:code` / `bindle:code` (the hosting
  Station's occupancy bindle — not stoppable from the dashboard). Developing an app writes
  `camp:<app>` / `bindle:<app>` under that yard. Station, Yard, and Camp
  are primitives with their own managed children that start and stop
  independently. Stopping a yard stops camps in that yard, not other yards.
  Occupancy endpoint cards list sidecars that are actually listening
  (dashboard, Evidence, controls, OTLP, evals, rollout, experiment, kms/secret/crypto, history) even before a Bindle `/dev`.
  Each endpoint is a new-tab link with a copy button and shows the loopback
  listen address next to the named `*.hobo.localhost` URL — the only surface
  that prints IP addresses.
  The dashboard features the Station as the primary pane: occupancy
  endpoints (dashboard, Evidence, OTLP, evals, rollout, experiment, KMS)
  sit as three occupancy doors (dashboard / Evidence / OTLP) with named
  + listen URLs; other sidecars fold closed. Buttons are 44px ink planks
  (play/stop toggle, Bindle restart, copy, lock) — not Start/Stop labels.
  Chewy, grain, and a spark focus ring match Evidence. Day/night follows
  the system setting and a moon/sun toggle (`hobo-theme`); Station occupancy
  sidecars (dashboard, Evidence, OTLP, …) cannot be stopped from the board.
  Pane titles are glyphs. Yard / camp / bindle / resource detail panes
  open with a lifecycle lamp strap, a compact identity/endpoint facts plaque,
  then (on resources) labeled named / listen / backend links; scope and
  manifest fold closed. The Yard card nests Yard ⊃ Camp ⊃ Bindle and
  hangs bindle endpoints on their bindle. The Station plaque ends with
  a labeled **capabilities** fold (collapsed by default) listing every
  Bindle kind as ready or off. There is no independent capabilities
  card and no look-alike “signals” board. Unavailable means we do not
  host it.
  Stopping
  Yard flow on the dashboard actually halts Bindle
  traffic until you start it again; camps in other yards stay up.
  `/dev` writes Camp + Bindle fulfillment that
  matches the deployed Bindle (api/web/kv/data/… as named endpoints).
  Evidence is a child of `camp:code` and is stoppable; the hosting Station
  and `camp:code` / `bindle:code` are not. It paints a live rubberhose journal for **this**
  `hobo-code` chat: asks, decisions with reasons, impact, and visual
  looks (screenshots/recordings), not a static sectioned site. `/dev`, Bindle stop,
  TTY quit, and `session.complete()` do not tear it down. Logout (or
  `stopStationSidecars`) does. Opt out with `HOBO_CODE_SIDECARS=0`.

| Key | Does |
|---|---|
| type | talk to the model |
| `/` | commands (`↑`/`↓` to pick, Enter to run) |
| Tab | cycle chat → mux (when work) → status → resources (resets pane scroll; leaves attach) |
| `↑`/`↓` | scroll focused surface (Mux detached: capture; while attached, keys go to the pane) |
| PgUp / PgDn | scroll Mux TV capture (works while attached too) |
| Home / End | oldest / live (chat + Mux) |
| Enter (empty, Mux) | **attach** — keys → focused split pane; TV chrome stays |
| Ctrl+\ (or Ctrl+]) | leave attach |
| `/mux` | open live agent terminal TV (connect / steer) |
| `/mux attach` | same as Enter attach |
| `[` / `]` | focus other split pane (both stay visible) |
| `/mux pane` | split focused tab (tmux + side-by-side in TV) |
| `{` / `}` | Mux only (detached): cycle tabs (redundant with `[`/`]` on single-pane seats) |
| `,` / `.` | Mux only (detached): cycle sessions when more than one exists |
| `/agents` | configure harnesses (model/effort); not session attach |
| `/mux …` | tab · pane · attach · focus · detach · stop — slash only, never bare letters |
| PgUp/PgDn, Ctrl+U/D | half-page scroll |
| Home / End | oldest / live follow (chat); top / bottom (document panes) |
| Ctrl+O | transcript less-mode (`j`/`k`, PgUp/Dn, `q`/Esc/`Ctrl+O` exit) |
| Esc | cancel the turn in flight |
| Ctrl+C | quit |

Mux is herdr-shaped (Session → Tab → Pane): session line, Detach/Stop/New tab,
tab strip, pane headers with focused + Focus/Prompt/Split/Close/Start agent,
live ANSI capture preview (`tmux capture-pane -e`) for every leaf in the focused
tab (herdr multi-pane). **Enter** attaches **inside the TV bezel** — keys forward
to the focused leaf while chrome stays; **Ctrl+]** or **Ctrl+\** leaves.
`[`]` cycles panes while attached. `/mux pane` splits the focused tab. Window resize
force-clears and reflows the bezel (no stale differential cells). type+Enter
steers without attaching. Codex seats under `$HOBO_HOME/durable/code/seats/codex`
(auth/config linked from `~/.codex`) so a nested TUI does not fight an IDE /
Windows Codex app-server on the shared home. Status strap leads with the
active agent — `Hobo Bo` on chat, `Codex` / `Pi` when that pane is focused.

Scroll is app-owned (alternate screen), not terminal scrollback. Agents capture
pins to the newest lines (`paneScroll === 0`); **PgUp/PgDn** (and Home/End)
scroll the TV — including while attached. Streaming preserves a non-zero
`chatScroll` so reviewing history does not yank to live. Mouse-wheel CSI is
not decoded yet — scroll is **keyboard-complete**.

### The model is local by default

hobo-code thinks **without a cloud account**. A locally hosted SLM is the
default engine and BYOK is the fallback, not the price of entry:

```bash
ollama pull qwen2.5-coder:1.5b   # once
hobo-code                        # streams from your machine, $0
```

Resolution order is local → cloud → honest dispatch-only, and every failure
prints a reason you can act on rather than pretending. Overrides:
`HOBO_CODE_ENGINE=local|pi|none`, `HOBO_CODE_MODEL=ollama/<tag>`,
`OLLAMA_HOST`. Token counts come from the model server and cost reads `$0`
because local inference is free.

**Tool calling runs on [Cactus Needle](https://github.com/cactus-compute/needle)** —
a 26M-parameter model distilled purely for function calling. Needle decides
*which tool to run with which arguments*; the chat model writes prose. Asking a
small general model to emit tool JSON is slow and unreliable; a model trained
for that one job is neither.

```bash
git clone https://github.com/cactus-compute/needle.git ~/.cactus/needle
cd ~/.cactus/needle && python3 -m venv .venv \
  && .venv/bin/pip install jax jaxlib flax sentencepiece huggingface_hub datasets
```

Weights download on first use. Override with `HOBO_CODE_NEEDLE_DIR` /
`HOBO_CODE_NEEDLE_PYTHON`, or turn tools off with `HOBO_CODE_TOOLS=0`. Without
Needle the shell still runs — conversation only, and it says so.

Tools are confined to the sandbox (`list_files`, `read_file`, `write_file`);
any path that resolves outside it is refused, so a small model cannot wander
into your real tree. Because tools now actually run, an editing turn reaches
the promotion gate below.

**The default model adapts to what you have pulled.** Rather than pinning one
name, the shell picks the *smallest* chat-capable model the server reports —
responsiveness is what makes a local shell usable, and a 1.5B model on a CPU
box can take ~10s per token. `HOBO_CODE_MODEL` always wins if you disagree, and
`HOBO_CODE_MAX_TOKENS` (default 384) bounds a reply.

Turns run inside a mediated isolation sandbox — the canonical tree stays
read-only. When work changes files, promotion asks first:

```
┏━ promote run-1a2b3c? ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃The canonical tree is untouched until you say yes.     ┃▒
┃                                                       ┃▒
┃  M  src/app.ts                                        ┃▒
┃  A  src/new.ts                                        ┃▒
┃                                                       ┃▒
┃  y promote · n keep sandboxed                         ┃▒
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛▒
```

The prompt is modal — stray keys do nothing, `n`/Esc keeps the work sandboxed
and tells you how to promote later, and only `y` promotes. Promotion runs the
project's real gates, then copies the sandbox diff into your working tree
**staged but not committed**, so you review before anything is permanent. If
the gates fail, or there is nothing to apply, or the patch conflicts, it fails
closed and the sandbox is left untouched — promotion never destroys work it
did not manage to apply.

Evidence capture: `HOBO_CODE_SHELL_MAX_MS` bounds a session so a recording
ends through the normal quit path, and `HOBO_CODE_SHELL_KEYS` scripts
interactive paths — both opt-in.

The browser evidence overlay can capture a PNG screenshot or record a WebM
plus a secret-free semantic action/checkpoint manifest. Both appear in the
live Evidence report. After a completed recording, **Save as capability**
compiles the same stored manifest into
`.hobo/recordings/<name>/{SKILL.md,scripts/run.spec.ts,references/recording.json}`
under the selected project root (the repository root when launched there).
Generated Playwright uses role/label/test-id locators before stable ids, emits
fresh checkpoint screenshots, takes recorded input through named environment
variables, and can target another deployment with
`HOBO_AUTOMATION_BASE_URL`. Playback pins viewport, locale, timezone, color
scheme, reduced motion, serial execution, zero retries, and fixed-time
auto-waited locator priority; recorded offsets remain evidence rather than
workstation-dependent sleeps. Ambiguous locators, cross-origin exports, and
recorded route/title drift fail closed. Generated source is byte-stable for the
same recording, while app data and third-party network responses remain the
target application's responsibility. Built-in skill names receive a
`recording-` prefix instead of being shadowed. Run playback from the project
root that contains the selected `.hobo/recordings` directory. The control
server validates the overlay origin, capture signatures, recording schema, and
capability path before writing. HoBo harnesses discover these project-local
recording skills before general agent skill roots.

Product identity lives in `/about`. Stock Pi TUI remains an escape hatch only
(`HOBO_CODE_TUI=pi` or `hobo-code --pi`) and is never the product frame.

When stdin is not a TTY, an empty invocation fails closed with
`HOBO_CODE_INTERACTIVE_REQUIRED` and prints `hobo-code help` plus the prompt
form to use. `--json` includes `interactiveRequired: true` and `remediation[]`.
It never attempts a default dispatch or durable-state write.

Fail-closed exit codes are stable: `HOBO_CODE_INTERACTIVE_REQUIRED` means the
caller supplied no prompt without a TTY; use `hobo-code help` or provide a
prompt. Machine callers should branch on `code` and consume `remediation[]`.

| Shell slash | One-shot CLI |
|---|---|
| `/templates` `/template` | `hobo-code template` · `hobo-code templates` (bare = list) |
| `/config` `/cost` `/harness` | `hobo-code config` · `cost` · `harness` |
| `/status` `/resources` `/guide` `/tasks` `/login` | `hobo-code status` · `resources` · `guide` · `tasks` · `auth login --agent` |
| `/agents` | Configure harnesses (Hobo Bo first; subagents under Bo). Enter → model/effort. Esc closes. Not the live terminal TV |
| `/mux` | Connect to agent terminal sessions (TV). Bare `/mux` opens the mux; subcommands: `tab` · `pane` · `attach` · `focus` · `detach` · `stop`. Tab also opens mux when work exists |
| `/agents init` | `hobo-code agents init` — register harness plugins |
| `/help` | keys + map · outside: `hobo-code help` |

### In-session agent chats (Herdr / T3-shaped)

`hobo-code` on a TTY **stays the session**. Chat is the first tab.
Detected harness CLIs (Codex, Claude, cursor-agent, …) are **subagents**
on one Agents screen — not a separate harness view and not the first tab.
Claimed tasks nest under the subagent that took them. That subagent gets
its own rift or git worktree branch and lands work with incremental
checkins, stacked PRs, and squash-merge. The Agents TV tab appears while a
subagent is working or a task is claimed (Tab or `/mux`). `/agents` configures
harnesses (Hobo Bo first; expandable subagents under `.hobo/agents`) — model and
effort, not attach. `/tasks` runs the session work board CLI. `/mux` opens the
live agent terminal TV; type+Enter steers; empty Enter attaches inside the bezel. You do **not** `tmux attach` to write
app code. Bo keeps HoBo verbs (`/dev`, `/resources`, `/history`, `/alias`,
`run it` / `debug it`).

```bash
hobo-code                         # chat first
# /agents → configure harnesses · /mux → live terminals
# Tab → chat · (mux if a subagent or claimed task exists) · status · resources
# [ ] cycle working subagents · type in Mux to steer
```

Register harnesses first (Vercel `coding-agents setup` analog — Station
occupancy, not a minted key). Each agent is a JSON plugin under
`packages/code/harnesses/` (or `$HOBO_HOME/durable/code/harnesses/`).
`runtime.adapter` is the AI SDK harness id — builtin packages
(`claude-code`, `codex`, `pi`, `opencode`, `grok-build`, …) load
`@ai-sdk/harness-*`; `cli` / `eve` / `sdk` are in-repo HarnessV1 adapters
for runtimes the SDK does not ship yet. CLI plugins carry `runtime.prompt`
one-shot argv so Cursor/Copilot/Gemini/Aider/Goose still run without a
builtin SDK package. TTY seating still uses mux.
Programmatic turns use `createHarnessV1(spec)` or `createHarnessAgent(spec)`
(AI SDK `HarnessAgent` + just-bash for host adapters; bridge adapters need
an injected network sandbox).

```bash
hobo-code agents init                # TTY: check/uncheck harnesses, then write
hobo-code agents init --dry-run
hobo-code agents init --yes          # write without a checklist
hobo-code agents init --non-interactive
hobo-code agents init codex eve
```

Bo subagents live under `.hobo/agents/<id>/` (instructions + optional nested
`subagents/`) and optionally legacy `agent/` + `agent/subagents/`. `/agents`
lists them under Hobo Bo. HoBo Bo configure always shows `+ create subagent`
(even when the list is empty) — Enter, type a lowercase id, Enter again writes
`.hobo/agents/<id>/instructions.md` and opens that agent. Model pick for Bo /
subagents uses the Bo catalog (local ollama tags, saved harness models as
provenance, `OPENAI_BASE_URL` locals). Coding harnesses (Codex, Claude, …)
use a **separate** per-harness catalog of real CLI model ids for every
bundled coding-agent / sdk harness (Codex, Claude, Cursor, Copilot, Gemini,
Grok, OpenCode, Aider, Goose, SDK) — never Bo’s ollama dump. **Pi** shares
the Bo catalog. Codex / SDK also list OpenAI-compatible endpoints
(`OPENAI_BASE_URL`, `HOBO_CODE_OPENAI_COMPAT_URLS`); Claude lists
Anthropic-compatible endpoints (`ANTHROPIC_BASE_URL`,
`HOBO_CODE_ANTHROPIC_COMPAT_URLS`). Cursor / OpenCode / Grok merge live
`list-models` / `models` CLI output when the binary is present. Mux seating
launches each CLI with the configured `api_endpoint` (env), model, and
effort from `/agents`. Each offer uses a LiteLLM-style `provider/model` id
plus optional `via` / `baseUrl` fields so provenance stays explicit. ←→ cycles
offers; type for custom.
They also register at `/agents/<id>` in the virtual filesystem. A seated CLI
can `ls /agents`. Bo still does not write app code.

`hobo-code mux` is the same seating, useful for dry-run / remote / virtual
trees. Join stays in-session (`hobo-code` · Tab chat, then Agents when work starts). `tmux attach -t hobo`
is the optional out-of-session escape, not the product path.

The resident-session core stores versioned snapshots and events in HoBo's
SQLite EventStore while tmux owns the PTYs. A process restart reloads the same
session, pane IDs, branch, and worktree; stale writers fail before tmux is
mutated. The protobuf/CUE boundary in `data-models/code_harness.*` and the
executable boundary Pact protect the shared CLI/TUI/web contract.

Each managed session gets a real Git branch and worktree. The shared command
router starts or interrupts agent harnesses in panes, captures dirty Git state
as restorable stash commits without moving the branch, and refuses commit,
push, PR, stack, or squash-merge operations until its caller explicitly
approves them. Failed worktree creation is fatal; it never falls back to an
empty or shared directory.

`hobo-code session serve` also exposes the live evidence report and records a
privacy-redacted debug timeline beside each resident session. Replay levels are
`metadata`, `observable` (default), `diagnostic`, or `off` via
`HOBO_REPLAY_LEVEL`; `HOBO_REPLAY=0` is the process kill switch. Browser,
terminal, agent, Git, test, annotation, and approval tracks share the existing
`@hobo/replay` store. The player is read-only; continuing from history requires
a new checkpoint-backed resident session.

Agents are **auto-detected** from evidence on your machine — a binary on PATH
and/or a config directory — and each gets its own tmux window:

```bash
hobo-code mux                     # detect agents, create/reuse session "hobo"
hobo-code mux --dry-run           # show the plan without touching tmux
hobo-code mux --session work      # name it
hobo-code mux --host box.example  # same panes, over ssh
# stay in hobo-code — chat first. optional: tmux attach -t hobo
```

```
✓ mux
 created hobo with 6 window(s)
  claude    · coding-agent · bin:/home/you/.local/bin/claude
  codex     · coding-agent · bin:/home/you/.local/bin/codex
  ollama    · inference    · bin:/usr/local/bin/ollama
 in-session · stay in hobo-code · chat first · optional tmux attach -t hobo
```

Re-running is idempotent: an existing session is reused and only missing
windows are added — it never duplicates or kills a pane you are working in.

**Panes open in the devenv workspace, one virtual worktree per agent.** The
workspace is the directory that declares the toolchain (`DEVENV_ROOT`, else the
nearest `devenv.nix`, else the git root) — not wherever your shell happened to
be. Each agent then gets its **own tree**, because agents sharing one checkout
collide:

```
workspace · /home/you/app/packages/code (devenv-config)
trees · rift
  claude · /home/you/.rifts/claude
  codex  · /home/you/.rifts/codex
```

[rift](https://github.com/anomalyco/rift) is the default — copy-on-write trees
are near instant and cheap in space. It needs btrfs, reflink-capable XFS, or
APFS, and ships per-platform binaries, so when it cannot run hobo-code falls
back to a **git worktree per agent** and prints why:

```
trees · git-worktree — rift ships no binary for this platform
```

The worktree is cut from the enclosing git root, so a devenv workspace nested
inside a monorepo still gets real per-agent isolation. `--shared` opts out and
puts every agent in the workspace root.

**Local and remote are the same shape.** A local agent, a locally running
inference server, and an ssh'd host are all just *a command in a pane*. Local
inference is not a special case with its own lifecycle, so naming, detach and
reattach behave identically wherever the work runs. `hobo-code agent` shows
what was detected and the evidence for it.

### hobo-code declares its own environment (devenv)

The harness shells out to git, tmux, ssh, node/pnpm, python (for the Needle
bridge) and ollama. Those are declared in [`devenv.nix`](./devenv.nix) rather
than assumed:

```bash
devenv shell     # the declared toolchain
devenv test      # check the environment is actually usable
hobo-code env    # reports whether that toolchain is installed here
```

Nix covers Linux and macOS natively; Windows runs it under WSL2. `hobo-code
env` says plainly when nix or devenv is missing instead of implying a
hermetic shell you cannot enter.

## Quick start (Copilot-CLI-like)

```bash
# 0) Optional map if you know Claude Code more than git
hobo-code guide

# 0.5) Discovery-gated seed (ADR-0155): inspect this machine, match it against
# the default localhost capability set on the declared dev-scenario Station
# (Node/git/isolation matrix required; ollama/devenv/harnesses degrade with
# remediation), then seed station:local. Required-missing writes nothing.
hobo-code init
hobo-code init --dry-run              # discover + match only
hobo-code init --scenario ephemeral   # station:code-ephemeral

# 1) Login to a Station
hobo-code auth login
# Local Station is auto-resolved (station:local / only local station; auto-init).

# Remote Station (tenant + domain required)
hobo-code auth login --tenant acme --domain stations.acme.example
# → one-time device code + verification URL
hobo-code auth login --complete ABCD-EF

hobo-code auth status
hobo-code auth whoami
hobo-code auth logout

# Models / BYOK (open models — secret values never printed)
hobo-code models
export HOBO_CODE_MODEL=openai/gpt-4.1
# export OPENAI_API_KEY=…  # BYOK; hobo-code models only shows the env *name*

# Interactive brand moment (GHCP-style): bare TTY
# hobo-code

# 2) Build
hobo-code "add a settings page to the bindle"
hobo-code "hello world app"      # copy examples/hello-world — no hobo CLI
# In the Bo TUI: "create a hello world app" · "run it" · "debug it"
# replies with the live bindle / debug / controls / report URLs
# against the Station you are logged into (strap shows station + env)
# Create fills local atomic templates (@hobo/patterns atoms). CLI: hobo-code template.
hobo-code scaffold --name demo
hobo-code dev --cwd demo          # run its Bindle on a local Yard + Evidence
hobo-code status                 # plain English session hierarchy (default)
hobo-code status --dense         # power-user glyph box + Herdr/Grok footers
hobo-code tasks                  # background task board
hobo-code session create review
hobo-code session list
hobo-code session attach <session-id> # tmux attach, or switch-client in tmux
hobo-code session serve               # token-authenticated loopback browser
hobo-code attach                 # tmux-like reattach + named endpoint
hobo-code attach --mode overlay  # Tailscale/overlay host
hobo-code isolate my-run
hobo-code promote my-run
```

`session attach` ensures every resident tmux session has a native ANSI `Git`
window; `hobo-code session git <sessionId>` opens the same pane directly.
`session serve` mirrors that workbench beside the browser terminal tabs. Its
Status, Files, Branches, Commits, Stash, and diff panels follow lazygit's
keyboard model: `1`–`5` focuses a panel, arrows or `j`/`k` move, and `Space`
stages the selected whole file. Fetch/fast-forward pull, discard/ignore,
branch create/checkout/delete, stash create/apply/pop/drop, and commit revert
stay in the same pane. Commit, push, PR, stack, and merge remain on the existing
exact-effect approval boundary; commits use only the reviewed index. Bounded
panels show a `+`, always retain the current branch, and disable committing
when the complete changed-file set cannot be reviewed.

Inside the interactive shell, `/dev` (or saying `run it` / `debug it`) runs the
current project's Bindle through the same local Yard as `hobo dev`; it does
not invent a static-site server. Default path is **in-process**: hobo-code
loads sibling `@hobo/hobo` and calls `serveProjectOnLocalYard` (same function
the composed `hobo` binary wires). No `hobo` on PATH. It sets
`HOBO_CODE_DEV_BRIDGE=1`, attaches Evidence controls, and links generated app
deps (`@hobo/adapter-hono`, `@hobo/bindles`, `hono`) so `src/bindle.ts` loads
without `pnpm install`. Set `HOBO_CODE_HOBO_BIN` only for an explicit
child-process override (tests). Use `/hobo <args>` for the full control plane
(also in-process via `createComposedHoboCli`), for example `/hobo yard status`
or `/hobo plan`. That composition keeps a throwaway event store in a
`hobo-yard-*` directory under `TMPDIR`, removed when hobo-code exits and, since
the entry point asks for it (`removeOwnedDirsOnSignals`, loaded beside
`createComposedHoboCli`), on SIGTERM, SIGHUP, SIGINT or SIGQUIT as well,
which the launcher passes on to the process that holds the store (above). The
shell quits on each of the four: it leaves the alternate screen, shows the
cursor and restores the terminal's settings, and hobo-code's status is the
quit's (0).

| lazygit workflow | HoBo Code workbench |
|---|---|
| Status and sync | ahead/behind, fetch, fast-forward pull |
| Files | diff, whole-file stage/unstage, discard, local ignore |
| Branches | inspect, create, checkout, safe delete |
| Commits | graph, inspect, revert |
| Stash | create with untracked files, inspect, apply, pop, drop |
| Delivery | staged-only commit, push, PR, stacked PR, squash merge with exact-effect approval |
| Deliberate boundary | partial-hunk editing and interactive rebase stay in the adjacent terminal |

## Usage

```bash
hobo-code "refine the openui bindle"   # default = dispatch
hobo-code dispatch "…"
hobo-code auth login
hobo-code auth status
hobo-code status                       # plain hierarchy; --dense for glyph box
hobo-code session list --json
hobo-code scaffold --name demo
hobo-code dev --cwd demo
hobo-code isolate --json
hobo-code promote --run <id>
hobo-code env --json
hobo-code help                         # grouped Start here / Session / Craft / Agent
hobo-code auth --help                  # verb-scoped help
hobo-code help --dense                 # power-user glyph strip (opt-in)
# Unknown CLI-shaped tokens fail kindly (not a fake success star):
#   hobo-code not-a-verb → ? cmd · try help · or quote as prompt
```

## Verbs (app-building)

| Verb | Role |
|---|---|
| **dispatch** (default) | App-building agent dispatch |
| **auth** | Station login / status / logout (local auto, remote tenant+domain) |
| **models** | Active model + BYOK env presence (open models; no secret values) |
| status | Session / agent multiplexer chrome |
| **resources** | Session topology + real endpoints (Station occupancy × `HOBO_ENV`) |
| **history** | Station SQLite command search (frecency). Not Atuin. |
| **alias** | Station aliases + env vars; `alias export` prints a shell snippet |
| **dashboard** | Local Aspire SPA (`camp:code` bindle). Hosting Station / `camp:code` / `bindle:code` refuse stop. Sidecars, other camps, and Bindle `/dev` start/stop. Yard stop takes camps in that yard only. |
| session | Resident branch/worktree sessions: tmux tabs/panes, harness agents, checkpoints, attach/switch, approved Git/PR delivery, and loopback browser control (`session --help`) |
| **attach** | Dev-terminal attach (tmux reattach · mosh? · Tailscale overlay named endpoint) |
| **resume** | Reopen the last (or given) interactive chat; prefix ids work |
| **compact** | Shrink the working pane; durable journal stays intact |
| **tasks** | Session work board — same ledger as Evidence. Dense TUI list; Evidence is the visual report with provenance. |
| **guide** | Claude Code → hobo-code map (plain English for non-dev app builders) |
| **cost** | Budget, $0 free/local path, savings scoreboard, cheapest-capable routing |
| **harness** | Pi/Flue dual surface, skills, Bo subagents, self-improve, brain notes |
| **edit** | Open [neo]vim in managed harness pane (tmux/stdio bridge + hobo-code.nvim) |
| **config** | Env/flags inventory by stack (setup critique; secrets presence-only) |
| **agent** | Agent-native readiness: human-free auth, MCP/ACP, unattended/no-elicitation |
| scaffold | Copy a shipped repo example (`examples/hello-world`, `examples/barebones`, …) |
| **dev** | Run the project Bindle on a local Yard + Evidence controls |
| isolate / promote | Built-in mediated sandbox + gated promote |
| env | Optional hermetic shell + durable layout |
| help | Plain help (or `--dense` glyph idioms) |

Type `btw what's going on` or `/btw` for a temporary overlay side-chat that
stays live with the parent thread (station, last turns, gate, agent state).
Esc dismisses. The overlay sits on the CRT glass so both threads stay
visible; the main transcript is unchanged and no workspace action runs.

`hobo-code resume` reopens the latest persisted InteractiveShell transcript
for this working directory (`hobo-code resume <session_id>` for a specific
one; a unique prefix is enough). Quit prints that command after leaving the
alternate screen. `/compact` (or `hobo-code compact`) shrinks the working
pane with a deterministic briefing and keeps the last user turns; the
journal file is never rewritten. Chats live under
`$HOBO_HOME/durable/code/chats`. If the id is a resident tmux session
instead, resume attaches to that.

Bare `hobo-code` paints through `buildShellTree` → `ShellChrome` inside a
`BroadcastFrame` (algorithmic old-TV / film-broadcast bezel). A live TTY
uses the alternate screen so quit restores the prior terminal instead of
leaving the CRT frame in scrollback. The initial
screen is an `InkTable` of talk / patterns / focus plus occupancy named
endpoints (`*.hobo.localhost`, never loopback IPs). Chat, slash, approval,
and tasks/status/resources are queryable TUI components
(`ChatTranscript`, `InkTable`, `SlashPalette`, `ApprovalDialog`, `TextPane`),
not pre-baked card strings. Every `tui-*` source is in DESIGN.md lint scope.

`dev` reuses the durable Evidence port, report, screenshot/recording capture,
replay, and `.hobo/recordings` capability exporter. Its browser boundary is
protected by the TypeScript exact-message parser and
`contracts/pacts/code-dev-browser-boundary.pact.json`. The printed **bindle**
and **debug** URLs are the named endpoint
(`http://web.<app>.local.hobo.localhost:<port>/?__hobo_debug=1` for debug). That
view always serves the Evidence workspace chrome with the animated Bo idle
launcher, then iframes the raw app (`__hobo_evidence_raw=1`). The loopback
`127.0.0.1` listen URL is printed once as **loopback** so the IP stays visible.
The Yard host maps the public `Host` onto overlay `parentOrigin` (the
component-local rewrite stays internal) and serves `bo-idle.png` as bytes so
the Bo idle launcher paints. **Open Evidence** is a direct read-only report
link.

**GHCP-adjacent differentiators:** animated title on bare TTY, enterprise-style Station auth, BYOK/open models via `models`, mediated sandbox (`isolate`/`session`).

**Herdr multiplexer differentiators** (vs single-stream agent CLIs):

| Capability | Where |
|---|---|
| Multi-pane agent mux + semantic state glyphs | `hobo-code status` / `session` |
| Detachable session model | `session` + durable handback |
| Highlight-to-copy | status footer `highlight→copy`; JSON `copyOnHighlight` / pane `highlightBuffer` |
| Session persistence | `$HOBO_HOME` durable root + `session-end.json` (`session --json` → `persistence`) |
| Capability legend | status human footer · `status --help` · `session --help` |

Dense pane chrome stays quiet; discoverability lives in the status footer, verb help, and `--json` (`herdr` / `capabilities`).

**Remote dev terminal (tmux · mosh · Tailscale mental model):**

| Preferred tool | hobo-code analogue |
|---|---|
| tmux attach | `hobo-code attach` + durable session under `$HOBO_HOME` |
| cmux / multi-pane | `status` / `session` Herdr panes |
| mosh | optional; `attach --json` → `registration.mosh` when lossy |
| Tailscale | `attach --mode overlay` named endpoint (ADR-0130) |

`attach` is a **dev-terminal** surface, not a control-plane admin verb. Local mode works offline without Tailscale.

**Grok Build–shaped TUI (AI-native expectations):**

| Grok Build | hobo-code |
|---|---|
| Fullscreen mouse TUI / click targets | `status`/`tasks` JSON `clickableRegions` + task-row story |
| Tasks pane / still-running | `hobo-code tasks` board + working panes |
| Workflows + multi-agent progress | Local World + `planDurableWorkflowRun` on `tasks --json` |
| Headless `-p` | `--json` envelopes |
| Subagents | Multi-pane status/session + Bo subagent surface |

Honest parity language only — hobo-code is HoBo app-building, not a Grok Build reimplementation.

**Coming from Claude Code (app builder, not a traditional developer)?**

```bash
hobo-code guide          # plain-English feature map
hobo-code guide --json   # structured map + residual gaps
```

Maps workflows, remote connect, channels, routines, reviews, Chrome browser, deep-research, fork, btw → hobo-code verbs with honest **supported / partial / residual** status.

**Coming from Cursor (Agent / Composer / Background Agent / BugBot)?**

```bash
hobo-code guide --cursor
hobo-code guide --cursor --json
```

Maps Agent mode, Composer, Background Agent, BugBot, MCP, Rules, Hooks, multi-model, headless CLI → isolate/promote/tasks/models with honest residual (Tab UI, BugBot SaaS, Slack Automations).

**Cost-conscious / $0 open-source path:**

```bash
export HOBO_CODE_MONETIZATION=0
export HOBO_CODE_MODEL=ollama/qwen2.5-coder:7b   # or OPENAI_BASE_URL=http://127.0.0.1:…
export HOBO_CODE_BUDGET_USD=0                    # hard cap
export HOBO_CODE_ROUTING=cheapest-capable
hobo-code cost                                   # spend · savings · free/local recipes
hobo-code models                                 # active model + free-local hints
```

Stack that multiplies savings (repo agent tooling): **RTK** (shell noise) · **headroom** (context-in) · **caveman** (agent-out) · **Serena** (semantic retrieval) · **ponytail** (less churn).

**Pi / Flue harness engineers (self-improving agents, skills, brains):**

```bash
hobo-code harness              # dual surface inventory
hobo-code harness --json       # skills · subagents · self-improve · brain
# Interactive Pi loads project skills, including Impeccable for web-app debugging.
# Interactive Pi path shares instructions with:
#   flue run hobo-code --input '{"message":"…"}'
```

**CLI-native / vim·neovim (managed pane):**

```bash
hobo-code edit src/cli.ts                    # prefer nvim; tmux split when available
hobo-code edit --bridge tmux-send --print-cmd path | sh
hobo-code edit --json path                   # bridge contract for plugins
# Neovim extension: packages/code/editor/hobo-code.nvim
#   :HoboOpen  :HoboStatus  :HoboIsolation
```

**Setup / configuration inventory (persona stacks):**

```bash
hobo-code config                         # multi-stack ●/○ inventory + setup tips
hobo-code config --stack cost-budget     # mon=0, budget, free-local models
hobo-code config --stack editor-vim      # $EDITOR, nvim/tmux, hobo-code.nvim
hobo-code config --stack hermetic-nix    # optional devenv/flake markers
hobo-code config --stack harness-pi-flue # MCP, AGENTS.md, skills
hobo-code config --stack agent-native    # agent auth + no-elicitation knobs
hobo-code config --json                  # full knobs (API keys = presence only)
```

**Protocol-native coding agents (unattended / MCP / ACP):**

```bash
export HOBO_CODE_AGENT=1
hobo-code auth login --agent             # human-free local Station (no device-code)
hobo-code agent --json                   # MCP tools · ACP status · unattended contract
hobo-code isolate --json                 # safe iterate
# hobo-code promote --run <id> --json    # gated merge
```

Keyboard-first navigation stays CLI: `status` · `tasks` · `isolate` · `edit` · `config` · `agent` · `promote` · `attach`.

Control-plane style verbs (`platform`, hive join/rooms) are **not** part of this surface. Token **cost** is app-building FinOps visibility, not platform budget admin.

## Auth model

| Mode | How |
|---|---|
| **Local** | `hobo-code auth login` — finds/init `station:local` (or sole local Station). No browser. |
| **Remote** | `--tenant` + `--domain` — device-code flow (copy code, open URL, `--complete <code>`). |

Session stored under `$HOBO_HOME/durable/code/auth/session.json`. Later `session` / `dispatch` prefer the logged-in Station.

## Hermetic / durable (optional Nix · devenv)

Optional hermetic shells for the coding agent only — never monorepo-wide Nix IaC. See `hobo-code env --help`.

## Multi-node compute (internal)

Dispatch may use capacity-aware multi-node scheduling under the hood (`code.distributed`). That is **worker scheduling**, not a buzz/hive chat product and not exposed as management verbs.

## Progressive flags (all **ON** by default)

| Flag | Role |
|---|---|
| `code.harness.enabled` | Master switch |
| `code.evidence.visual` | Evidence triple |
| `code.monetization.surface` | Privacy-first sponsored wait |
| `code.isolation.rift` | Prefer CoW rift when available |
| `code.distributed` | Multi-node compute dispatch |

## Virtualized panes

A tmux pane can hand an agent a **virtual terminal over a virtual filesystem**
instead of a real shell in a real directory.

`rift` separates each agent's tree so agents cannot collide. It does nothing
about what a command *is*: inside its own workspace an agent can still
`curl | sh`, read `~/.aws/credentials` by absolute path, or `rm -rf` its way
out. Two layers close that:

- **Commands** — the pane runs a bash *interpreter*
  ([just-bash](https://github.com/vercel-labs/just-bash)), not `/bin/bash`.
  There is no `execve`: commands are TypeScript implementations dispatched from
  a registry, so anything off the allow-list simply **does not exist** (`rm`
  answers `command not found`). Network commands are absent entirely. Reads
  come from the real tree and cannot resolve outside the mounted root; writes
  stay in memory until promotion, so nothing an agent does reaches the
  checkout. Two limits worth knowing: `find -delete` can remove files even
  though `rm` is absent (in the default overlay that is the in-memory copy
  only), and a path outside the root **writes** succeed into memory rather
  than failing — they simply never reach disk.

  Symlinks are refused, which in a pnpm workspace means every dependency under
  `node_modules` reads as missing — and as a missing *file*, not as a policy
  refusal. Mount the repository root rather than a package if an agent needs to
  read dependency source.
- **Observation** — `tmux capture-pane` returns text tmux has already
  interpreted, which cannot say *when* a prompt appeared or what the screen
  held at a moment. `src/virtual-terminal.ts` provides the replacement: a VT
  parser (`@xterm/headless`) fed by `pipe-pane -O`, yielding a structured
  screen buffer. **It is a library, not yet a wired surface** — nothing in the
  pane path calls it today, so treat this as the mechanism that exists rather
  than a behaviour you get.

Neither is a VM: just-bash runs in-process, so this bounds what an agent can
*name and touch*, not what hostile native code could do.

```sh
hobo-code mux --virtual       # every pane gets one
hobo-code vshell              # one, over the current project
```

The two layers compose rather than compete: `mux --virtual` runs the pane
inside `hobo-rift exec`, so the kernel provides copy-on-write isolation from
other agents and the interpreter provides the command allow-list over that
tree.

## Remote panes

`hobo-code mux --host <machine>` reaches only machines **declared** in
`devenv.machines.json`, beside the devenv files:

```json
{
  "schemaVersion": "hobo.code.dev-machines/v1",
  "machines": [
    { "id": "build-box", "host": "build-box.tail1234.ts.net", "isolationClass": "development" },
    { "id": "gpu", "host": "gpu.tail1234.ts.net", "user": "agent",
      "isolationClass": "ephemeral", "agents": ["ollama"] }
  ]
}
```

Hosts resolve on the tailnet. Sessions are brokered through the Station's
privileged-access gateway, which applies the target's isolation-class policy,
issues a short-lived authorization, and audits every session. A pane that the Station
did not authorise is refused rather than opened, and a machine's `agents` list
is enforced.

The Station authorization gates a lease-bound local SSH-agent socket backed by
`SSH_AUTH_SOCK`. The resident proxy survives tmux
detach, expires with the authorization, and drains redemption/end facts to the
Station's Yard audit feed. Private keys and session tokens are never copied
into pane commands or remote hosts; a missing installed agent fails closed.

## Package layout

`src/`, `test/`, `contracts/`, `data-models/` — konsistent production package.

Vitest clears inherited Git repository selectors before loading tests, so a
pre-commit run cannot redirect temporary repositories, worktrees, or indexes to
the checkout being committed. Tests still set those variables explicitly for
their own temporary repositories. Set `HOBO_TEST_MAX_WORKERS` to bound Vitest
workers on slow or memory-constrained hosts and `HOBO_TEST_TIMEOUT` to adjust
the default per-test and hook budgets. Turbo's strict environment passes both
through and keeps task hashes stable across pre-commit runs.
