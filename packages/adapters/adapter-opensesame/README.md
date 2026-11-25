# `@hobo/adapter-opensesame`

**Optional.** Run HoBo under [OpenSesame](https://github.com/Tyler-R-Kendrick/OpenSesame)'s
proxied invocation (`opensesame dev --agent run`, like `op run`) with secret
**references** in place of credentials, so the command holds an `osr_` surrogate
in place of the real token. OpenSesame's `surrogate-proxy` plugin swaps the
surrogate for the token, once, at the provider's own host (`api.vercel.com`),
inside the scope the binding declared.

That guarantee is conditional, and narrower than "never holds the real token". It
holds for the environment this adapter builds for the command: an allowlist chosen
by variable **name**, plus the names you list in `passEnv`, with a refusal when a
bound variable or the provider's conventional ones (`VERCEL_TOKEN`,
`VERCEL_API_TOKEN`) already hold a real token. It cannot see a token under a name
the allowlist lets through (`HOBO_PAT`, `HOBO_DEPLOY_KEY`), in `passEnv` (passed as
given), or in files the command can read as you (`HOME` and `XDG_*` point at them).
[ADR-0170](../../../docs/design/adr/02-identity-security.md#adr-0170) lists what is not
proven.

It is a `SecretsPort` of kind `opensesame` (ADR-0113 residual port, ADR-0027
rank `provider-federation`): `access()` returns the run's surrogate and nothing
else. See [ADR-0170](../../../docs/design/adr/02-identity-security.md#adr-0170).

## Scope, honestly

| | |
|---|---|
| **Vercel** | Brokered. Verified against the real `opensesame` and the plugin's test build (`test:real`), with global `fetch`. |
| **AWS** | **Not brokered.** A binding with `provider: "aws"` fails with `provider_not_brokered`. AWS requests are signed with SigV4 in process from a live secret key, which header substitution cannot serve, and OpenSesame's AWS helper fails closed until its STS mint exists. |
| Other providers | `provider_not_brokered`. |
| Platforms | Linux. The real lane reads `/proc`. |
| Node | `^22.21 \|\| >=24` (the adapter's `engines`; Node 23 has no `NODE_USE_ENV_PROXY`): it is what sends `fetch` through `HTTPS_PROXY`. Without it `fetch` ignores `HTTPS_PROXY` and dials the provider directly, with a surrogate only the proxy can redeem, so the launch refuses (`node_proxy_unsupported`). |

## The bindings file

`hobo.credentials.json` holds **references only**: where a credential lives and how far a
surrogate for it may reach. It is a `CredentialBindings` document
([`data-models/adapter_opensesame.proto`](./data-models/adapter_opensesame.proto), constraints in the
[`.cue`](./data-models/adapter_opensesame.cue)).

```json
{
  "bindings": [
    {
      "locator": "hobo-token://vercel/deploy",
      "connection": "conn://acme/vercel",
      "provider": "vercel",
      "env_name": "VERCEL_TOKEN",
      "paths": ["/v9/projects", "/v13/deployments"],
      "methods": ["GET", "POST"],
      "projection": "legacy-token"
    }
  ]
}
```

- `locator` is the `hobo-token://` reference the resolvers already ask for (`packages/hobo/src/compose.ts`): no new scheme.
- `connection` is the OpenSesame connection; its last segment names the provider.
  The token is the sealed entry `connections/acme/vercel`, put there by a person with
  `opensesame pass insert connections/acme/vercel` (HoBo never writes it).
- `paths` and `methods` are required and non-empty: an unbounded scope cannot be written. Bounded is not narrow: a
  one-segment prefix such as `/v9` with all five methods is bounded by path alone, and that is the operator's choice;
  nothing here narrows it.
- The bindings file is a repository file, so a hostile checkout can name any sealed `connections/*` entry in the person's
  store. Show the person the connection and the scope before the run; nothing in this package does.
- `env_name` may not be a variable the run depends on (`reserved_env_name`): the proxy and CA variables, `PATH`, `HOME`,
  `SHELL`, `IFS`, and the `NODE_*`, `OPENSESAME_*`, `LD_*`, `DYLD_*` and `HOBO_OPENSESAME_CHILD` names. The parser and the
  CUE share one list.

## Use

```ts
import {
  createOpenSesameCredentialResolver,
  createOpenSesameSecretsPort,
  exitCodeOf,
  outcomeError,
  parseCredentialBindings,
  runProxied,
} from "@hobo/adapter-opensesame";

const bindings = parseCredentialBindings(JSON.parse(readFileSync("hobo.credentials.json", "utf8")));

// Parent: relaunch under OpenSesame. The schema is written 0600 and removed after.
// OpenSesame is started with an allowlist of this environment plus what passEnv names, never all of it.
const outcome = await runProxied({
  bin: "opensesame",
  bindings,
  argv: [process.execPath, "hobo", "up"],
  passEnv: ["OPENSESAME_STORE_PASSWORD"], // unlocks the store; OpenSesame strips it from the command
});
const failure = outcomeError(outcome);   // typed refusal, or undefined for a clean child
process.exitCode = exitCodeOf(outcome);  // never 0 for a run that left placeholders

// Child (HOBO_OPENSESAME_CHILD=1): serve the surrogate to resolvers that ask by locator.
const port = createOpenSesameSecretsPort({ bindings, env: process.env });
const resolveCredential = createOpenSesameCredentialResolver(port);
```

What `runProxied` does before and around the run:

- **The environment is built, not inherited.** OpenSesame hands its command everything it was started with except the
  store passphrase and the names a binding overwrites, so the caller's AWS keys, `GITHUB_TOKEN` or a real `VERCEL_TOKEN`
  would reach it. The run starts from an allowlist (`HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `TERM`, `TMPDIR`,
  `TZ`, `CI`, `LC_*`, `NODE_*`, `XDG_*`, `HOBO_*` minus credential-shaped names, the Windows trio on win32, the
  checked `OPENSESAME_ENV_PARSE`, and `VERCEL_TEAM_ID` and `VERCEL_ORG_ID`), plus the names you list in `passEnv`, plus
  the run's own two variables, which win. `VERCEL_TEAM_ID` and `VERCEL_ORG_ID` (the Vercel CLI's name, which can hold a
  personal account's id) name the Vercel team or account a deploy is in: configuration, named nothing like a
  credential, and allowlisted by those exact names, so the rest of `VERCEL_*` stays behind.
  The allowlist is a heuristic by name: a variable that matches a prefix and does not look credential-shaped reaches the
  command whatever it holds.
  `OPENSESAME_STORE_PASSWORD`, `OPENSESAME_STORE_DIR` and the like are `passEnv` names. **Who supplies `passEnv`:** the code
  that calls `runProxied`, which is operator code and nothing else. Never read it from `hobo.credentials.json`, from a file in
  the repository being run, from the environment or from a model: a list a repository controls can name what the allowlist
  keeps back (the store passphrase, `OPENSESAME_NODE`, a real token under another name) and have it passed on as given.
  `CredentialBindings` has no such field and must not get one. A process that already holds a
  value that is not a surrogate in a bound variable or in the provider's conventional ones (`VERCEL_TOKEN`,
  `VERCEL_API_TOKEN`) is refused with `real_credential_in_env` before anything is written.
- **The env-spec bridge is a program path, so it is checked.** `OPENSESAME_ENV_PARSE` is the one OpenSesame variable on the
  allowlist, because Node runs the script it names (an OpenSesame before `c403ba90a` runs it with the whole environment). It
  must be an absolute path to a file in a trusted place (below), or the run is refused with `bridge_missing` before anything
  is started: a relative path is the working directory's, where a checkout puts files. Unset, OpenSesame uses its own.
- **`PATH` is reduced, not inherited.** An OpenSesame built before its commit `c403ba90a` runs a bare `node` (the
  env-spec bridge) as its first act, with the store passphrase in its environment, so an empty or relative `PATH` entry
  would let a `./node` in a checkout take it. A current one looks `node` up only in `PATH` directories that group and
  others cannot write and starts it with a minimal environment. **The adapter does not rely on that**; this holds with
  either. `PATH` is always your entries that are absolute, exist, are trusted places (below) and that only their owner can
  add a file to (a sticky `/tmp` is fine above a file, not as a directory a program is looked up in by name: sticky stops
  others removing a name, not adding one), each written as it resolves; if none remain, the system directories `/usr/local/bin`, `/usr/bin`
  and `/bin` that pass the same rule (on Windows, SystemRoot's `System32` and SystemRoot); if not even those pass
  (`/usr/local/bin` is the directory hosted CI images and Intel Homebrew leave open to all), the run is refused
  with `bridge_missing` before anything is started or any passphrase is passed, because an empty `PATH` makes the
  lookup search the working directory. Listing `PATH` in `passEnv` does not change that. A command that
  lives only in a dropped directory has to be named by absolute path in `argv`.
- **`node` for the schema comes from that `PATH`, or from `OPENSESAME_NODE` if you list it.** OpenSesame searches the
  `PATH` the adapter built, so `node` must sit in one of those directories. When none holds one (for example where Node is
  installed in a world-writable directory), OpenSesame refuses the run before the command starts and the outcome is
  `bridge_missing`, from either version's words (`os error 2`, or ``no usable `node` ``), with advice that names the
  override. OpenSesame's #1461 (merged to its main as `6d4cdc795`) reads `OPENSESAME_NODE`: an absolute path to the `node`
  to run, final (never a reason to search `PATH` instead) and exempt from the directory and file checks. **The adapter does
  not resolve, check or allowlist that variable.** It is not on the allowlist, so it reaches OpenSesame only when you list it
  in `passEnv`, where it is passed as given: your explicit choice, like an explicit `bin` path. A value OpenSesame cannot use
  (not absolute, missing, not a regular file, not executable, empty) is `bridge_missing`, in its #1461 words or the older
  ones.
- **A trusted place** resolves through every symlink; it and every directory above it belong to you or root and are not
  writable by group or others (a sticky directory you or root own, like `/tmp`, is allowed above it); it is not under a
  `node_modules/.bin` directory and not inside the working directory's tree (the filesystem root and your home directory
  are not projects). Not checked: file contents, ACLs, extended attributes, Windows ownership, a mount that lies about
  modes, or that a trusted place stays trusted between the check and the use (a swap there needs write access to a directory
  the rule refuses). Edge cases: on a umask-002 system (Debian and Ubuntu private groups) a download made executable is 0775
  and is refused until you fix its mode; on WSL `/mnt/c` and on FAT every file looks 0777 and is refused; in a rootless user namespace (a rootless container) files root owns on the host
  appear to belong to `nobody`, so `/usr/bin` and the rest look owned by another user: a bare `opensesame` would be
  `opensesame_bin_untrusted`, every system `PATH` entry is dropped, and with none left the run is `bridge_missing`, until
  `opensesame` and `node` sit in directories the container's user owns (reasoned from the rule, not run); on Windows a bare
  `opensesame` is not resolved (no `PATHEXT`) and no owner or mode is checked, so give the path. All of these fail closed with a message
  that names the file and what to change.
- **The executable is found and identified first.** A bare `opensesame` is looked up on the absolute entries of `PATH`
  only; the first executable file found must be in a trusted place, or the run is refused (`opensesame_bin_untrusted`)
  rather than moving on to a later one. A path with a separator is your explicit choice: resolved once through its links,
  and not held to the rule. The resolved path is what is probed and what is started. It is asked `--version` with the
  reduced `PATH` alone in its environment and must answer `opensesame X.Y.Z` before the real launch, which is the first
  place the passphrase can appear. That is a shape check, not authentication.
- **Signals.** From before the first await to the schema's removal, `SIGTERM` and `SIGHUP` are passed on to OpenSesame
  as they are (it revokes the run and stops the command; you get the `signalled` outcome). `SIGINT` and `SIGQUIT` are
  passed on as `SIGTERM`, because OpenSesame does not stop the command on an interrupt, and are re-raised on this process
  once the schema is gone, so Ctrl-C still ends it by the signal. A signal before OpenSesame is started starts nothing
  (`signalled`), and a `SIGTERM` or `SIGHUP` that finds nothing running (before the start, or after the command ended) is
  re-raised the same way, so a supervisor's "stop" is not swallowed. From the `exit` event, OpenSesame is sent `SIGTERM`
  and the schema directory is removed, neither able to throw. The read of OpenSesame's stderr ends a second after it exits
  even when a descendant (a daemon the command started) holds the pipe open.
- **Documented, not changed.** An ignored signal (`nohup`, `trap '' HUP`) is not respected: the listeners replace the ignore,
  where OpenSesame itself keeps it. A second Ctrl-C is passed on as `SIGTERM` again and never escalates, so a wedged
  OpenSesame needs `SIGKILL`, and the re-raised interrupt also reaches your own `SIGINT` handlers.
- **What no handler can reach.** `SIGKILL` and a crash. The `hobo-opensesame-*` directory stays in the temp directory
  with its 0600 `.env.schema` (connection names, paths and methods, never a token), and OpenSesame and its command keep
  running with their surrogate until the command ends or the surrogate's lifetime runs out. If OpenSesame itself is
  ended by a signal, the outcome is `signalled` with `128+n` (`exitCodeOf` returns it) and a notice that the command may
  still be running.
- **`buildLaunch` returns a `Launch` that keeps its environment and the command's arguments out of sight.** `launch.env` (the
  passphrase, when you list it in `passEnv`) and `launch.args` (your command, which may carry a token as an argument) are what
  `spawn` is given, and they are accessors over private fields: they are not own properties, so `Object.keys` and
  `Object.entries`, a spread, `Object.assign`, `structuredClone`, `util.inspect` with `customInspect: false` or `showHidden`
  (which is what `console.dir` and `node:assert` messages do) find only `command`. `console.log`, `util.inspect`, `JSON.stringify`
  and a template string print the names in the environment and the adapter's own arguments, never a value. Reading `launch.env`
  yourself is deliberate and gives the real environment: do not log that.
- It never reads or sets the store passphrase itself: OpenSesame takes it from the terminal, or from
  `OPENSESAME_STORE_PASSWORD` when you list that name in `passEnv`, and strips it from the command.

What the port proves: it serves a value shaped `osr_` + 32 hex from the process's own environment, and only when that
environment also carries a run's markers (`HOBO_OPENSESAME_CHILD=1`, `NODE_USE_ENV_PROXY=1`, `HTTPS_PROXY` an `http` URL
on loopback with a port; else `placeholders_only` with `no_run_provenance`). That is shape plus run markers, not
cryptographic provenance: the port cannot ask OpenSesame whether a surrogate is live.

## Failures

Every refusal is an `OpenSesameAdapterError` with one `code`, and no message carries a
rejected value: `binding_invalid`, `launch_invalid`, `opensesame_bin_missing`,
`opensesame_bin_untrusted`, `bridge_missing`, `scope_unbounded`, `reserved_env_name`,
`provider_not_brokered`, `placeholders_only`, `store_unreadable`, `plugin_pin_mismatch`,
`tripwire_misdirected`, `signalled`, `child_exit`, `node_proxy_unsupported`, `recursion_guard`,
`real_credential_in_env`, `schema_injection`, `read_only`.

The one that matters most is `placeholders_only`. With the plugin missing or off, `opensesame dev run --agent`
**still starts the child and exits 0**, handing it an `ostest_…` placeholder. Against an emulator that
accepts any token that is a false green, so the adapter treats it as a failure: the port denies anything
that is not `osr_` + 32 hex, and a run that printed OpenSesame's placeholder line is `placeholders_only`
unless a more specific kind applies: a tripwire (77), a signal (143, 129) or a recognised refusal beside its own line wins.

## What the binary really does (checked against `apps/cli` at OpenSesame `efe9c5adb`; the `OPENSESAME_NODE` words from its `6d4cdc795`)

Where the docs and the code are not the same thing, or the status alone is not enough:

- A **tripwire** exits `77`, **SIGTERM/SIGHUP** exit `143`/`129`. A child can exit with any of them, so the adapter reads a
  status as one of these only beside OpenSesame's own line (`opensesame: surrogate.misdirected: …`,
  `opensesame: SIGTERM: the run is ended …`).
- A child **killed by a signal** makes OpenSesame exit `1`, not `128+n`.
- An interrupt (`SIGINT`) sent to OpenSesame does not stop the command (OpenSesame's own docs), which is why the adapter
  passes it on as `SIGTERM`.
- Every refusal before the child starts (pin mismatch, unreadable entry, no bounded scope, a schema
  that does not parse) is `Error: <message>` on stderr and status `1`.
- `--schema` is a global flag of `dev`: `opensesame dev --agent --schema <file> run -- <cmd>`.
- The classification reads stderr, which the child shares, so it is advisory. OpenSesame prints its end-of-run line with no
  newline before it, so a child's unterminated last write (or a spinner ending on `\r`) leaves it glued to the child's own
  text: the `opensesame: ` sentences and the pin-mismatch sentence are therefore matched anywhere in the output, and the
  other `Error:` classes, printed before the child exists, at the start of a line. A child can **forge or hide**. It can print
  one of them (and exit 77, 143 or 129 itself); what that gains it is a fail-closed kind with a fixed sentence, never a pass,
  and none of its text reaches the outcome or an error message. The one thing of the child's that does is the exit status it
  chose (eight bits: `exitCode`, "status N"). A descendant that outlives OpenSesame's stop and keeps writing could push
  OpenSesame's line out of the 64 KiB start and end the adapter retains, so the `opensesame: ` sentences are kept by a scan
  of every chunk as it arrives (one of each shape, at most six, each within 512 characters) and not read from the retained
  text alone: no write after the line can evict it. What cannot be prevented from here: OpenSesame writes its tripwire
  sentence in several `write(2)` calls, so a writer that gets in between them breaks the sentence, and the typed
  `tripwire_misdirected` is then a `child_exit` with the same failing status (nothing passes). The gate that a surrogate was
  really delivered is the port.

## Tests

```bash
pnpm --filter @hobo/adapter-opensesame test                    # default lane: no binary needed
pnpm --filter @hobo/adapter-opensesame test:contract:consumer
pnpm --filter @hobo/adapter-opensesame test:contract:provider  # the pact, against a stand-in binary
HOBO_OPENSESAME_KIT=<absolute dir, see below> pnpm --filter @hobo/adapter-opensesame test:real
```

The default lane runs a stand-in `opensesame` (`test/fixtures/fake-opensesame.mts`) that takes exactly the
real argv and prints the real lines. It is a model; the **real lane** is what says it is right. The pact's
`tokenLeaked: false` is true by construction against the stand-in, which never reads the dummy that stands for the sealed
token; only the real lane, which seals it, redeems it at a recording upstream and sweeps for it, is evidence.

### The real lane, and how to build its kit

`test:real` runs against the real `opensesame`, the surrogate-proxy plugin's **test build**
(`--features upstream-override`, the only build that can be aimed at a loopback server; it prints
`TEST BUILD` and must never see a real token), a sealed store, the real `@env-spec/parser`, and a
recording TLS server for `api.vercel.com` with a certificate minted by `openssl`. It needs
`openssl` and `node` on `PATH`, and **fails, never skips**, without a kit.

No release publishes a test-build plugin, so build the kit yourself. From an OpenSesame checkout (Rust 1.88.0;
one heavy build at a time; point `CARGO_TARGET_DIR` at a shared target and keep `CARGO_INCREMENTAL=0
CARGO_BUILD_JOBS=2` on a busy machine; check `df -h /` first, the debug build needs a few GB):

```bash
# $KIT: an absolute path OUTSIDE this package and the repository checkout, made under umask 022 (see the rule below).
umask 022                                  # for this shell: cp keeps a source file's group-write bit unless the umask clears it
export KIT=$HOME/.cache/hobo-opensesame-kit
mkdir -p "$KIT/bridge"
cd OpenSesame
export CARGO_TARGET_DIR=$HOME/.cache/packages/cargo-target CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=2
cargo +1.88.0 build --locked -p opensesame-surrogate-proxy --features upstream-override --bin opensesame-surrogate-proxy
cp "$CARGO_TARGET_DIR/debug/opensesame-surrogate-proxy" "$KIT/"      # copy now: the next build of the other flavour overwrites it
cargo +1.88.0 build --locked -p opensesame-cli --bin opensesame
cp "$CARGO_TARGET_DIR/debug/opensesame" "$KIT/"
cp packages/env-spec-bridge/bin/opensesame-env-parse.mjs "$KIT/bridge/"
# @env-spec/parser@0.4.1 in $KIT/bridge/node_modules, from any package manager
export HOBO_OPENSESAME_KIT=$KIT
```

**The kit is held to the adapter's own trust rule.** Every real run starts OpenSesame with
`OPENSESAME_ENV_PARSE=$KIT/bridge/opensesame-env-parse.mjs`, and the adapter refuses a bridge that is not an absolute path in a trusted
place (a trusted place, above): the script and every directory above it owned by you or root and **not writable by group or others**,
not inside the working directory's tree (so not inside this package or the checkout), not under a `node_modules/.bin`. A kit
that fails this makes every real run `bridge_missing`, which is why the recipe makes `$KIT` under `umask 022` (Debian and Ubuntu
default to `umask 002`, which makes 0775 directories and 0664 files; if that happened, `chmod -R go-w "$KIT"`). The lane checks
the bridge once, before any test, and stops with `KIT_UNTRUSTED` and the reason.

Build the plugin and the CLI as **two** commands: `opensesame-cli` must never link the plugin (a gate in OpenSesame
fails if it does), and `--features upstream-override` on the CLI build would not reach it. If the disk is short,
`CARGO_PROFILE_DEV_DEBUG=0` with a `CARGO_TARGET_DIR` on a RAM-backed `/dev/shm` builds the CLI in about nine minutes
and `~1.7 GB` of memory without touching the disk.

`HOBO_REAL_EVIDENCE=<file>` appends one JSON line per case (upstream requests, what the child held, exit status)
so a run can be saved and attached.
