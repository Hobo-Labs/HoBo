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
  bounded failure report, and that a
  refusal or an HTTP failure produces an error with no response text in it.
- `resolution-engine.pact.json`: the engine port as a synchronous message.
  The request is the one JSON document an engine receives for a file; the
  response is its structured answer. `resolution-engine.consumer.test.ts`
  checks that the prompt is exactly the contract's message and runs the
  answers through the resolver, including an answer that omits a region.

Both are hand-authored consumer contracts. The GitHub one is written from
GitHub's published GraphQL schema, not from captured traffic, and no provider
verification has been run against GitHub. The engine one is verified against
the AI SDK's mock language model only; no live model is called.
