# Unity CLI Reference (Manage + Automation)

Authoritative for a given install: `unity --help` and `unity <command> --help`.  
Official docs: https://docs.unity.com/en-us/unity-cli/unity-cli-reference

CLI status: **experimental**.

## Install the CLI

```bash
# macOS / Linux
curl -fsSL https://public-cdn.cloud.unity3d.com/hub/prod/cli/install.sh | UNITY_CLI_CHANNEL=beta bash

# Windows PowerShell
$env:UNITY_CLI_CHANNEL='beta'; irm https://public-cdn.cloud.unity3d.com/hub/prod/cli/install.ps1 | iex
```

- Binary (typical): `~/.unity/bin/unity`
- Env snippet: `~/.unity/env` (adds bin to `PATH`)
- Update: `unity upgrade`
- Uninstall CLI: `unity self-uninstall`

Verify:

```bash
unity --version
unity doctor --format json
```

## Global options

| Flag / env | Purpose |
|------------|---------|
| `-V, --version` | CLI version |
| `--format human\|json\|tsv\|ndjson` / `UNITY_FORMAT` | Output format |
| `--no-banner` / `UNITY_NO_BANNER` | Suppress banner |
| `--non-interactive` / `UNITY_NON_INTERACTIVE` | No prompts (CI) |
| `--quiet` / `UNITY_QUIET` | Less chatter |
| `--verbose` / `UNITY_VERBOSE` | Stack traces on failure |
| `--proxy` / `UNITY_PROXY` | Proxy URL |
| `--proxy-disable` | Ignore proxy sources |
| `--log-proxy` / `UNITY_LOG_PROXY` | Debug proxy traffic |

### Output contract

| Context | Default format |
|---------|----------------|
| Interactive TTY | `human` (color, progress) |
| Pipe / redirect | `tsv` |
| Explicit | `--format json` etc. |

- **stdout**: results  
- **stderr**: errors / diagnostics (JSON errors may be `{"error":"..."}` on stderr)  
- **Do not parse** animated progress bars  

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Error |
| `130` | Cancelled (Ctrl-C / SIGINT) |

### Log locations (Hub/CLI)

| OS | Path |
|----|------|
| Windows | `%UserProfile%\AppData\Roaming\UnityHub\logs` |
| macOS | `~/Library/Application Support/UnityHub/logs` |
| Linux | `~/.config/UnityHub/logs` |

Also: `unity logs`, `unity env`, `unity doctor`.

## Command map (CLI binary)

Surface grows with versions. Common groups:

### Editors & modules

```bash
unity install [version] [options]          # alias: i
unity install-modules [options]            # alias: im
unity uninstall <version>                  # alias: u
unity editors [options] [command]          # alias: e
unity install-path                         # alias: ip
unity modules list <version>
unity releases
unity editor                               # manage a single install
```

**install** highlights:

| Option | Notes |
|--------|-------|
| `version` | Positional; required non-interactive. Aliases: `latest`, `lts`, `default`, `6`, `6.5`, `2022`, … |
| `-c, --changeset` | Archive/changeset installs |
| `-m, --module` | One or more module IDs |
| `--cm` / `--no-cm` | Child modules (e.g. Android SDK) |
| `-a, --architecture` | macOS: `arm64` / `x86_64` |
| `-y, --yes` | First match, no prompt |
| `--accept-eula` | Accept module licenses |
| `--force` | Reinstall |
| `--dry-run` | Show downloads only |
| `--resume` | Resume cached downloads |

Examples:

```bash
unity install 6000.5.4f1
unity install lts -m ios android webgl --cm --accept-eula --yes
unity install-modules -e 6000.5.4f1 -l
unity install-modules -e 6000.5.4f1 -m android --no-cm
```

**editors** highlights:

```bash
unity editors -i                 # installed
unity editors -r                 # releases
unity editors --json             # legacy-style JSON flag also exists
unity editors -i --format json
unity editors add <path...>      # register local install
unity editors default [version]
unity editors -w                 # watch
```

Modules only work on Hub/CLI-managed installs.

### Projects & open

```bash
unity open [project]             # resolves Editor from ProjectVersion.txt
unity ./MyProject                # open shorthand
unity projects                   # alias: p — Hub project registry
unity templates                  # alias: t
```

`open` options (see `--help`): `--editor-version`, `-e/--editor-path`, `--build-target`, `--args`.

### Auth & identity

```bash
unity auth login                 # browser OAuth
unity auth status
unity auth logout
```

Service-account / CI: use environment-based credentials as documented for headless agents (never commit secrets). `doctor` reports session state.

### Build / test / run (spawn Editor)

```bash
unity test [project] --mode EditMode|PlayMode --filter <pat> --output results.xml
unity build [project] --target <BuildTarget> --execute-method Ns.Class.Method -o <path>
unity run [project] --args "..."   # batchmode forwarder
```

Notes:
- `build` **requires** `--target` and `--execute-method` (Unity has no universal built-in build entrypoint).
- `--allow-install` can fetch missing Editor version.
- Android builds expose keystore-related flags — treat secrets carefully (shell history / CI logs).

### Pipeline / live Editor (see pipeline-and-commands.md)

```bash
unity pipeline install|upgrade|list|list-versions
unity command [name] [args...]
unity list
unity status
unity mcp [configure]
```

### Diagnostics & meta

```bash
unity doctor
unity diagnose
unity env
unity logs
unity license
unity cache
unity config
unity shell          # warm CLI REPL for many subcommands
unity completion <shell>
unity changelog
unity upgrade
unity hub
unity cloud
unity analytics
unity bug
```

## Hub CLI migration (`-- --headless`)

| Hub headless | Unity CLI |
|--------------|-----------|
| `"Unity Hub" -- --headless <cmd>` | `unity <cmd>` |
| `install -v/--version <ver>` | `install <ver>` (positional) |
| `install-modules -v <ver>` | `install-modules -e/--editor-version <ver>` |
| `editors --add <path>` | `editors add <path...>` |
| Errors on stdout | Errors on **stderr** |
| Always plain text | TTY human / pipe **tsv** / `--format json` |
| Exit 0/1 | Exit 0/1/**130** |

Removed Hub global flags (no CLI equivalent): `--headless`, `--errors`, `--silent`, `--logLevel`, `--bugReporter`, `--debugMode`, `--inspect`, `--userEmail`, `--theme`, `--editorLicense`, …

**High-risk breakages when migrating scripts**:
1. Drop `-- --headless`
2. Fix version flags (`-v` is **not** Editor version on install; `-V` is CLI version)
3. Fix `editors add` subcommand form
4. Stop parsing progress text; use JSON/TSV + exit codes

## Practical CI snippet

```bash
export PATH="$HOME/.unity/bin:$PATH"
export UNITY_NON_INTERACTIVE=1
export UNITY_NO_BANNER=1
export UNITY_FORMAT=json

unity auth status
unity editors -i
unity test "$PROJECT" --mode EditMode --output "$CI_PROJECT_DIR/test-results.xml"
```

Prefer explicit Editor versions in CI images rather than `latest` for reproducibility.
