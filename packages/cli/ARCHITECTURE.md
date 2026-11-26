# @hobo/cli architecture

## Boundaries

- **Argv parser** (`parseArgv`) — raw argv crosses once; invalid input becomes `UsageError`.
- **Command registry** — canonical verbs only; unknown registration throws.
- **Dispatch seam** (`dispatchCommand`) — transport-free; no `process.argv` in command handlers.
- **Scaffold boundary** (`scaffoldHoboProject`) — offline templates; protobuf/CUE in `data-models/`.

## Evidence

- Protobuf: `data-models/cli_envelope.proto`, `data-models/scaffold.proto`
- CUE: `data-models/cli_envelope.cue`, `data-models/scaffold.cue`
- PACT: `contracts/cli-command-path.pact.json`, `contracts/hobo-new-scaffold.pact.json`

## Parse, don't validate

Untrusted argv, project names, and template ids cross one parser boundary into derived
parsed types (`CliRequest`, `ProjectName`, `TemplateId`). Downstream command handlers
accept parsed types instead of re-checking raw strings.

Parsers live in `src/shell/parse.ts` and `src/types/scaffold.ts`.

## Event architecture

The CLI shell is stateless at dispatch time. Command handlers that mutate HoBo state in
later slices will emit **events** to an **event store**; **actors** append **commands**
that become events. Read-only verbs such as `plan` and `inspect` project **materialized
views** from the **read store** and may return **snapshots** without side effects.
`hobo plan` stays read-only (`sideEffectEvents: []` in the command-registry pact).

No runtime engine is implemented here; this package defines the shell dispatch seam and
offline `hobo new` scaffold boundary other packages compile against.
