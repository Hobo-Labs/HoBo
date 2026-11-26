# @hobo/componentize contracts

`componentize-artifact-boundary.pact.json` pins the artifact boundary consumed by `@hobo/cli`
(build verb) and `@hobo/stage-gate` (fixture health + signing): a deterministic wasm component
with `hobo.componentize/v1` contract metadata, and digest/metadata validation before use.
`test/artifact-boundary.contract.test.ts` verifies the real surface against this pact.
