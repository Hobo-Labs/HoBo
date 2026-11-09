# Architecture — `@hobo/adapter-opensesame`

Optional residual `SecretsPort` adapter. **Not** a default dependency of `@hobo/identity` or the composed `hobo`
binary. It lets HoBo run under OpenSesame's proxied invocation and hold a surrogate instead of a token.

## Schema and constraints

- Protobuf: [`data-models/adapter_opensesame.proto`](./data-models/adapter_opensesame.proto) (generated into `src/_generated/`)
- CUE: [`data-models/adapter_opensesame.cue`](./data-models/adapter_opensesame.cue)
- PACT: [`contracts/pacts/opensesame-proxied-run-boundary.pact.json`](./contracts/pacts/opensesame-proxied-run-boundary.pact.json)

## Parse, don't validate

Parse, don't validate: the bindings file crosses one boundary, `parseCredentialBindings`, and becomes frozen
`ParsedCredentialBinding` derived types (a narrowing of the generated `CredentialBinding`, held in a class with a private
`#brand`, exported as a type only). The type is nominal: a spread copy, an object literal or an `Object.assign` has the right
fields and is not one (`test/binding.test-d.ts`, `typecheck:types`), and `isParsedCredentialBinding` tells a forged value at run
time; the renderer, the port and the evidence maker refuse one (`schema_injection`, `binding_invalid`). Nothing downstream
re-checks a string. The regular expressions are the CUE's; `test/binding.test.ts` reads them out of the `.cue`.
A run's end crosses another boundary, `parseOutcome`, and becomes a `ProxiedRunOutcome` whose `kind` is a closed set.

## Residual ranking (unchanged)

bound-resource -> **provider-federation** (this adapter) -> camp-value -> static-escape. Prefer secretless
federation (ADR-0027 / ADR-0113); this adapter is the way to hold even less than a residual store does.

## Event architecture

This adapter owns no aggregate. It implements the residual `SecretsPort` for a process started under OpenSesame.

- **Command** - `runProxied` (launch a command under OpenSesame) and the port's `put` / `access` / `accessVersion` /
  `listVersions`. `put` is rejected: secrets enter by a person's `opensesame pass insert`.
- **Event** - upstream `@hobo/identity` emits refs-only `secret.Accessed` / `config.Resolved` (never-compact
  CredentialAudit). The adapter's own record of a run is a `ProxiedRunOutcome` (a closed `kind`, an exit status and one
  fixed sentence chosen by the kind: no line of output, OpenSesame's or the child's, is ever copied into it) and a `SurrogateEvidence` (digests of the connection and the scope); neither carries a surrogate or a token.
- **Actor** - none owned here; OpenSesame's plugin is the actor that issues, redeems and revokes a surrogate for the
  life of one run, and the Camp / Station / config-resolver actors in identity and runtime packages invoke the port.
- **Event store** - the credential-audit stream on the platform EventStore (identity package), not an OpenSesame journal.
- **Materialized view / projection** - the credential-audit projection folds `secret.Accessed` by correlation; the
  surrogate is never projected, only the `opensesame://<connection>#surrogate` reference.
- **Snapshot** - none. A surrogate lives for one run (OpenSesame revokes it when the child exits, at most 12 hours; a parent killed by SIGKILL leaves the run going until then).
- **Read store** - the plugin's notices (`opensesame plugins notices surrogate-proxy`) are OpenSesame's read store of
  tripwires and refusals; agents see references and outcome kinds only.

## Boundaries

| Surface | Direction |
|---|---|
| `@hobo/identity` `SecretsPort` | this adapter implements the residual port |
| `@hobo/bindings` `parseSecretRef` | locators are `hobo-token://` references |
| `opensesame dev --agent --schema <file> run -- <cmd>` | process boundary; the pact |
| OpenSesame surrogate-proxy plugin | OpenSesame's, never linked here |

## Launch, and what surrounds it

`runProxied` is a small pipeline, each step in a module of its own: `buildLaunch` (pure: the argv, and the environment from
`child-env.ts`, in a `Launch` that prints and serialises without its values, `launch-value.ts`), `opensesame-bin.ts` (find, trust and identify the executable), the schema written 0600 in a directory of its own,
and `supervise.ts` (the signals and the exit event, from before the first await to the schema's removal). `trust.ts` is the one
rule for a place, used by the executable lookup and by `PATH`.

- **The environment is an allowlist, by name.** OpenSesame passes its command everything it was started with except the store
  passphrase and the names a binding overwrites, so the launch builds the environment: `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`,
  `TERM`, `TMPDIR`, `TZ`, `CI`, the `LC_*`, `NODE_*`, `XDG_*` and `HOBO_*` families (credential-shaped names left out), the Windows
  trio on win32, the checked `OPENSESAME_ENV_PARSE` (an absolute path to a file in a trusted place, else `bridge_missing`: Node runs the script it names), `VERCEL_TEAM_ID` and `VERCEL_ORG_ID`, whatever the caller lists in `passEnv`, and the run's two own variables, which
  win. The two Vercel names (hobo's and the Vercel CLI's, which can hold a personal account's id) say which team or account a deploy is in: configuration, named nothing like a
  credential, and allowlisted by those exact names, so the rest of `VERCEL_*` stays behind. A non-surrogate value in a bound variable or a conventional one for the bound provider (`VERCEL_TOKEN`, `VERCEL_API_TOKEN`)
  refuses the run (`real_credential_in_env`). The allowlist cannot see what a name does not say: `HOBO_PAT` reaches the command, and
  `passEnv` is passed as given. Operator code supplies `passEnv` (the `runProxied` caller's argument), never a repository file,
  the environment or a model; `CredentialBindings` has no such field and must not get one.
- **`PATH` is reduced.** An older OpenSesame's first act is a bare `node` lookup with the passphrase in its environment (a current
  one searches only directories group and others cannot write, with a minimal environment), so `PATH` is the caller's absolute,
  existing, trusted directories that only their owner can add a file to (no sticky `/tmp`), as they resolve, once each, else
  the system directories (`/usr/local/bin`, `/usr/bin`, `/bin`) held to the same rule, else a `bridge_missing` refusal before
  anything is started (an empty `PATH` would search the working directory); listing it in `passEnv` changes nothing. The adapter relies on neither OpenSesame. With no `node`
  in those directories OpenSesame refuses before the command starts: `bridge_missing`, from either version's words. So is an
  `OPENSESAME_NODE` it cannot use (its #1461, merged): the adapter neither resolves nor allowlists that variable, and a caller lists it in `passEnv`.
- **A trusted place** resolves through every symlink; it and every directory above it belong to the effective user or root and are
  not writable by group or others (a sticky directory they own is allowed above it); it is not under `node_modules/.bin` and not inside the
  working directory's tree (root and the home directory are not projects). Not checked: contents, ACLs, a mount that lies about
  modes, Windows ownership, or the gap between check and use. A rootless user namespace shows root's files as `nobody`'s and
  is refused until the programs sit in directories the container's user owns (reasoned, not run).
- **The executable is found, trusted and identified before the passphrase can reach it.** Absolute `PATH` entries only; the first
  match must be a trusted place, else `opensesame_bin_untrusted`; an explicit path is the caller's choice. The resolved path is probed
  with `--version` (reduced `PATH` alone) and started: a shape check, not authentication.
- **Interruption.** SIGTERM and SIGHUP pass on as they are; SIGINT and SIGQUIT pass on as SIGTERM (OpenSesame does not stop the
  command on an interrupt) and are re-raised once the schema is gone, as is any signal that found nothing running; a signal before
  the start starts nothing; the exit event sends SIGTERM and removes the directory without being able to throw; the stderr read ends a
  second after OpenSesame does. Not SIGKILL, not a crash: the 0600 schema (references only) stays, and OpenSesame and its command run on
  until the command ends or the surrogate's lifetime runs out. An ignored signal is not respected and a second Ctrl-C never escalates.

## What the port proves

It serves a value shaped `osr_` + 32 hex from the process's own environment, and only beside a run's markers
(`HOBO_OPENSESAME_CHILD=1`, `NODE_USE_ENV_PROXY=1`, `HTTPS_PROXY` an `http` URL on loopback with a port). That is shape plus run
markers, not cryptographic provenance: the port cannot ask OpenSesame whether a surrogate is live, so an `osr_` copied from
another run into an environment that fakes all three markers would pass. It stops the plain mistakes: a surrogate pasted or
left over and sent to the provider with no proxy.

## Why stderr is read, and what it is not

A proxied run that cannot deliver a surrogate still starts the child and exits as the child does. The only signal
is a line on stderr, so `parseOutcome` reads OpenSesame's own lines (`opensesame: ` sentences anywhere in the output, `Error: ` lines at the start
of a line) beside the status. The child shares that stream, so this is a diagnosis, not a gate; the gate is the port, which serves only a
value shaped `osr_` + 32 hex from the child's own environment, under the run's markers.

OpenSesame prints its end-of-run line with no newline before it, so a child's unterminated last write leaves it glued to
the child's text; the `opensesame: ` sentences and the pin-mismatch sentence are matched anywhere in the output, the
other `Error:` classes at the start of a line. A child can **forge or hide**. It can print a line in one of those shapes, and can
exit 77, 143 or 129 itself: what it gains is a fail-closed kind (a tripwire, a refusal, a placeholder) with a fixed sentence; it
never gains a pass, and nothing it wrote reaches the outcome or an error message except the exit status it chose. And a
descendant that outlives OpenSesame's stop keeps writing after its last line, enough to push that line out of the start and end
a capture retains. So the `opensesame: ` sentences are not read from the capture alone: `createOutcomeScan` (`sentences.ts`) sees
every chunk as it arrives, carries a sentence split across chunks, and keeps one sentence of each shape (at most six, each within
512 characters) that no later write can evict. Not preventable here: OpenSesame writes its tripwire sentence in several `write(2)`
calls, so a writer between them breaks it and the typed tripwire is a `child_exit` with the same failing status. An `Error:` line
that is not one of OpenSesame's is the child's own failure (every uncaught Node exception starts that way): `child_exit`, the
status, no words. The status 77, 143 or 129 is advisory beside its line.
