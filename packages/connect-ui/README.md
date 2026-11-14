# `@hobo/connect-ui`

The page a lifecycle opens when a provider must be connected before anything
can converge: `hobo ci up` connects GitHub (a GitHub App from a reviewed
manifest), `hobo cd up` connects Vercel. Each step of the flow is rendered as
the exact component it needs, generated with
[json-render](https://json-render.dev) on its shadcn/ui preset, and every
action on the page is a transition the flow on the server decides.

## Secretless by construction

A provider hands its credentials over once. The flow writes them straight from
the provider's response into a third-party secret store (Infisical Cloud with
OIDC Auth by default; 1Password when the owner asks) and keeps only the store's
references. No step, spec or response carries a secret value; the page shows
references like `infisical://hobo-ci/HOBO_CI_GITHUB_APP_ID`. Workloads read the
values back with their own identity (OIDC), so no secret lives in a repository,
a CI variable or this page.

## How a step becomes a page

| Piece | Entry point |
|---|---|
| The flow's steps (data) | `ConnectStep`, `DEFAULT_SECRET_STORES` (`src/steps.ts`) |
| The component vocabulary | `connectCatalog`: shadcn Card, Stack, Heading, Text, Button, Alert, Badge, Link, Progress, Separator, Radio; actions `connect.chooseStore`, `connect.start`, `connect.cancel` |
| What a step may show | `connectCandidates(step)`: configured, already valid component instances |
| Compose | `composeConnectSpec(step, { evaluate })` |
| Serve | `startConnectPage({ flow })` |

**Generative, but bounded.** With an evaluator, json-render's composer
(`experimental_composeSpec`) has a model choose and arrange the step's
candidates. It cannot invent props or actions, only candidate descriptions and
the prompt reach the model, and the descriptions name no owner, repository or
value. The result must pass `validateSpec` *and* contain every required
candidate (`missingRequiredCandidates`). Otherwise, as when no evaluator is
configured or the gateway fails, the deterministic page built from the same
candidates is served. A model's mistake degrades to the plain page, never to
a broken or stranded one.

**Evaluator, secretless first.** `evaluatorFromEnv` uses `VERCEL_OIDC_TOKEN`
(short-lived, on Vercel or after `vercel env pull`), then `AI_GATEWAY_API_KEY`.
`HOBO_CONNECT_UI_COMPOSE=off` disables the model. `HOBO_CONNECT_UI_MODEL`
picks it (default `typesafe-ai/jev`). The composer API is experimental, so
`@json-render/*` is pinned to an exact version.

## The loopback server

`startConnectPage` binds `127.0.0.1` on an ephemeral port under an unguessable
per-session path (`/s/<token>/`); anything else is a 404.

- `GET view` returns the step's composed spec.
- `POST action` accepts only `{ action: one of the three, params: string map }` and asks the flow.
- `GET callback` is where a provider sends the browser back (GitHub's manifest code, Vercel's authorization). The flow handles it.

Transitions run one at a time, so a double click cannot call a provider twice.
A flow error becomes a `failed` step, never a crash. `done` settles with the
terminal step.

Responses carry a strict CSP. Scripts and connections are `'self'` only and
form posts may go only to `https://github.com`. Inline *styles* are allowed
because Radix positions some shadcn parts with style attributes.

## Architecture rules (AGENTS.md)

- **PACT at the boundary.** The browser client and the loopback server meet
  at `contracts/pacts/connect-page.pact.json`, which
  `test/connect-page.pact.test.ts` verifies against a real server.
- **Protobuf plus CUE.** The wire records (`ConnectActionRequest`,
  `ConnectViewRecord`, `BrowserDirectiveRecord`, `ConnectedReferences`) are in
  `data-models/connect_ui.proto`, constrained by `data-models/connect_ui.cue`.
  Closed action, step and store names; a reference must be a reference.
- **Parse, don't validate.** A request body becomes the derived type
  `ActionBody` (a Zod parse of the closed action set and string params)
  before the flow sees it, or it is a `400`. The browser parses renderer
  params into `ActionParams` the same way. `ConnectStep` is the parsed
  domain type the flow returns, and a spec reaches a browser only after
  `isRenderableConnectSpec` and `missingRequiredCandidates`.
- **Event architecture, and what this package deliberately is not.** Each page
  action is a command. The flow is the single actor that turns it into the
  next step, one transition at a time. The view is a projection of that step
  (a materialized view rebuilt per request), and the composed spec is its
  snapshot. The page keeps no event store and no read store of its own: a
  connection is a one-time ceremony whose durable outcome is the
  secret store's write and, upstream, the lifecycle's own facts on the
  deployment's event store. The flow's step is in memory and dies with the
  page.

## Build

`pnpm build` compiles the server (`tsc`), bundles the browser client
(`src/client/main.tsx`, React + json-render + the shadcn preset) with esbuild,
and compiles its Tailwind stylesheet with the HoBo Rubberhose tokens
(`DESIGN.md`) mapped onto shadcn's variables. Nothing loads from a CDN.

## Tests

`test/connect-ui.test.ts` checks:
- every candidate's props parse against the catalog;
- every step renders a valid spec;
- the model path is used when complete and rejected when it omits the action;
- a failing evaluator falls back;
- the server's 404, CSP, action parsing, callback and failure handling;
- no secret value in any response.

The flow was also driven end to end in Chromium through real clicks, with no
console errors.
