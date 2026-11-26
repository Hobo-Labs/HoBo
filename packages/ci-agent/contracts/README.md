# CI agent contracts

- `github-merge-queue.pact.json`: the GitHub GraphQL boundary. Each
  interaction names an operation (`HoboAgentQueue`, `HoboAgentEnqueue`,
  `HoboAgentComment`, `HoboAgentDefaultBranch`, `HoboAgentBaseProtection`,
  `HoboAgentCommitChecks`) and its variables.
  `github-merge-queue.consumer.test.ts` drives the real adapter and transport
  through every interaction and checks the URL, method, headers, the exact
  query text exported by `src/github-queue.ts`, and the variables. It covers
  queue ordering (queued entries first, then labelled work by label time),
  drafts and duplicates being left out, the missing-merge-queue case,
  mutations addressed by node id only for observed pull requests, which base
  branch answers count as confirmed required checks (a protection rule or a
  ruleset rule that names at least one) and which do not, stacked pull
  requests depending on their parent, a commit's check rollup turned into a
  bounded failure report, a failure only of infrastructure (timed out, not
  started, cancelled, a status error) told apart from a code failure, and
  never when the rollup has more contexts than one page, and that a
  refusal or an HTTP failure produces an error with no response text in it.
- `resolution-engine.pact.json`: the engine port as a synchronous message.
  The request is the one JSON document an engine receives for a file; the
  response is its structured answer. `resolution-engine.consumer.test.ts`
  checks that the prompt is exactly the contract's message and runs the
  answers through the resolver, including an answer that omits a region.

Both are hand-authored consumer contracts. `github-schema.test.ts` validates
every operation in the GitHub one against GitHub's published GraphQL schema,
vendored here as `github-schema.graphql.gz` from
`https://docs.github.com/public/fpt/schema.docs.graphql`;
`pnpm contracts:github-schema` refreshes it. The engine one runs against the
AI SDK's mock language model; `test:live` runs the same engine against a real
model.
