# `@hobo/connect-ui`

The ceremony page a lifecycle opens when something must be connected or
configured before it can converge: `hobo ci up` connects GitHub, `hobo cd up`
connects Vercel, and `hobo up` connects the providers a resource needs. Each
step is generated as exactly the component it needs and rendered with
[vercel-labs/ui](https://github.com/vercel-labs/ui) (UI SDK: `@ui-sdk/core`,
`@ui-sdk/react`). Every action is a transition the flow on the server decides.

## The generated component

A flow's step (`ConnectStep`, data) becomes a view (`stepView`, `view.ts`): only
the fields that need an answer or correction, the one choice it asks for, and
the actions that move it. A `configure` step lists missing or invalid settings
and secrets, and a finished step lists store references. The browser
renders the view from UI SDK parts:

| The step needs | UI SDK |
|---|---|
| A setting | `Field` + `FieldLabel` + `Input` (+ `FieldDescription`, `FieldError`) |
| A secret | `Field` + `PasswordInput` (`PasswordInputControl`, `PasswordInputToggle`) |
| One of a few options | `Field` + `RadioGroup` + `Radio` |
| An action | `Button` |
| Progress | `Progress` |

**Agent-ready.** Every control is named by its Field label, and state flows
through `onValueChange`, so a person and an agent drive the same page.
`createAgent` and `registerTools` (WebMCP) publish `snapshot`, `query` and
`act`.
- A provider hand-off ("Continue on GitHub", "Continue on Vercel") and giving
  a secret carry `data-agent-confirm`: an agent's press asks the person first.
- Password fields are secret to the bridge. An agent may fill them, never
  read them.
- Actions read the latest values even when an agent sets and presses in one
  batch.

**Styling.** `@ui-sdk/core/web.css`, themed through its `--ui-*` tokens with
HoBo Rubberhose (`DESIGN.md`): ink on paper, thick outlines, hard sticker
shadows. Parts are restyled from their `data-slot` attributes.

## Ceremonies

`configureThen` turns missing settings into a `configure` step, then hands the
answers to `proceed`, which builds the provider's own flow (or returns field
errors to show on the same page). `resolveSettings` reads each setting from the
environment, then from earlier answers, then from its fallback, and lists what
is still missing. `familySettingsStore(family)` keeps answers in
`$HOBO_HOME/ceremonies/<family>.json`; fields of kind `secret` are used for the
run and never saved.

## Secretless by construction

A provider's credentials are written to the owner's secret store (Infisical or
1Password). A `configure` step submits secrets to its flow; some, such as a
session token, are used only for that run. Views blank secret field values,
and finished steps show references (`infisical://…`, `op://…`).

## The loopback server

`startConnectPage` binds `127.0.0.1` on an ephemeral port under an unguessable
per-session path (`/s/<token>/`), plus an optional fixed `callbackPath` for a
provider whose redirect URL is registered.
- `GET view` returns the generated view.
- `POST action` accepts only `{ action, params: string map }` for the four
  actions (`connect.submit`, `connect.chooseStore`, `connect.start`,
  `connect.cancel`), Zod-parsed.
- `GET callback` is where a provider sends the browser back.

Transitions run one at a time. Actions not offered by the current step, and
in-flight actions whose step has advanced, are ignored. Repeated starts reuse
the pending provider handoff until its callback or another transition. A flow
error becomes a `failed` step, and `close({ graceMs })` waits until the browser
has seen the finished step.

CSP: scripts and connections are `'self'` only and forms post only to
`https://github.com`. Images may be `data:` because `web.css` draws its icons
as inline SVG masks, and inline styles are allowed for component positioning.

## Architecture rules (AGENTS.md)

- **PACT**: `contracts/pacts/connect-page.pact.json` (browser client and page
  server), verified against a real server by `test/connect-page.pact.test.ts`.
- **Protobuf plus CUE**: `data-models/connect_ui.proto` / `.cue`
  (`ConnectActionRequest`, `ConnectViewRecord` carrying the view,
  `BrowserDirectiveRecord`, `ConnectedReferences`).
- **Parse, don't validate**: request bodies parse into `ActionBody` and
  renderer params into `ActionParams`. `ConnectStep` is the parsed domain type
  the flow returns.
- **Event architecture**: each action is a command and the flow is the single
  actor that decides it. The view is a projection (a materialized view) of the
  step, rebuilt per request. There is no event store or read store here: the
  durable outcome is the secret store's write, and convergence is recorded on
  the deployment's event store by `hobo up`.

## Build and tests

`pnpm build` compiles the server and bundles the client and its stylesheet with
esbuild. Nothing loads from a CDN.
The package's Biome configuration checks the client, server, scripts, and
tests, and supports Tailwind directives if they are introduced.

Tests:
- `test/connect-ui.test.ts`: views, server, CSP and secrets.
- `test/connect-page.pact.test.ts`: the PACT.
- `test/agent.test.tsx`: an agent finds every control by name, completes the
  store choice and a `configure` step, and a GitHub hand-off is refused until
  a person approves. Run in jsdom with Testing Library, as UI SDK's agent-ready
  checklist asks.

The flow was also driven in Chromium through real clicks with no console
errors.
