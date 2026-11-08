# durable-agent

A HoBo example of a **durable, tool-invoking agent** authored on
`@hobo/runtime`'s real authoring surface (`agent()` + `createWorkflowEngine()`),
promoted from the draft proof
`src/draft/technical-proofs/durable-agent-primitive-contract/examples/durable-agent/`.

## The pieces

| File | What it is |
|---|---|
| `src/agent.ts` | The `ops` agent: parse boundary, one declared tool, one granted broker-token capability. |
| `test/agent.test.ts` | Proves the run, the journal, crash/resume, replay == live, capability denial, and the pact pin. |

```ts
export const opsAgent = agent<OrderCommand, OrderReceipt>({
	name: "ops",
	tools: [{ name: "writeOrder", run: ... }],           // -> capability tool:writeOrder
	capabilities: [tokenCapability("acme-cloud")],       // -> capability token:acme-cloud
	async run(ctx, command) {
		const token = await ctx.step("mint-broker-token", () =>
			ctx.token({ provider: "acme-cloud", scope: "database:write" }),
		);
		const written = await ctx.tool("writeOrder", { ... }); // journaled step
		await ctx.emit("order.Written", written);              // domain event
		return create(OrderReceiptSchema, { ... });
	},
});
```

## What genuinely runs

Everything the tests assert runs on production packages, offline:

- **Durability** — every `ctx.tool(...)` call and the explicit
  `mint-broker-token` step are journaled as `run.StepScheduled` /
  `run.StepCompleted` events; after a simulated host crash a fresh engine over
  the same store resumes the run and completed steps are read back from the
  journal, never re-run.
- **Replay == live** — the journal replays through `@hobo/runtime/replay`'s
  `replayRun` and reproduces the live result exactly.
- **Deny-by-default capabilities** — an agent that never declared
  `token:acme-cloud` is refused with a typed `CapabilityDeniedError`; declared
  tools become `tool:<name>` capabilities.
- **Broker-token seam** — `ctx.token(...)` goes through the engine's
  `TokenBroker` port; the agent→broker exchange is pinned by the PACT in
  `contracts/pacts/agent-to-token-broker.pact.json`.

## Honest narrowing (vs. the draft proof)

The draft proof additionally modeled **signed `auth.json` manifests**, an
identity registry, SVID-scoped delegation, and a `token.Granted`/`token.Used`/
`token.Denied` audit log via draft-local modules (`createAgentRuntime`, the
`hobo-auth-json-contract` proof). Those runtime pieces do not exist in
production packages yet, so this example scopes down to what genuinely runs:
the production `TokenBroker` here is the engine's default **stub** (it returns
`stub://<provider>/<scope>` refs and emits no token audit events), and no
identity envelope is verified. When the identity/broker slices land in
`@hobo/runtime` / `@hobo/identity`, this example should widen back to the draft
proof's full flow.

## Run it

**Tests only.** This package has no `src/bindle.ts`, so `hobo up` / `hobo plan` are the wrong verbs — they look for a Bindle.

```bash
pnpm --filter @hobo/example-durable-agent test
```

## How this maps to HoBo's architecture

The agent's input/output shapes are protobuf-first: `data-models/agent_run.proto`
with matching CUE constraints in `data-models/agent_run.cue`, and `src/agent.ts`
imports the **generated** `OrderCommand`/`OrderReceipt` types from
`src/_generated/agent_run_pb.ts` (run
`buf generate data-models --template ../../buf.gen.yaml -o src/_generated` to
regenerate). Following **parse, don't validate**, untrusted input crosses a
single parse boundary (`parseOrderCommand`) that returns the **derived domain
type** (`OrderCommand`) — the agent body never re-checks raw fields.

In event-architecture terms the parsed `OrderCommand` is the **command** and the
agent is a durable **actor**: its run journal (`run.Started`, step **events**,
`order.Written`, `run.Completed`) is appended to an in-memory **event store**,
and resuming after a crash is a **projection** of that journal — the engine
folds `run.StepCompleted` events so each journaled step result serves as the
**snapshot** it reads instead of re-executing. Honest scope: no separate
**materialized view** or **read store** is built here — `engine.journal(runId)`
is the only read surface this example exposes.

## Maintenance

Tool input and output cross explicit JSON parse boundaries, keeping journal events typed without assertions.
