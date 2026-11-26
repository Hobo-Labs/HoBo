# @hobo/events — contract evidence

Executable PACT boundary for the reactive-streams gateway, lifted from the
data-plane epic proof:

- `pacts/subscription-gateway-boundary.pact.json` — the Reactor pushes a
  recomputed materialization to the gateway at a monotonic `seq`.

`consumer/events-boundaries.test.ts` drives the Reactor against the real
`@hobo/runtime-local` event store + streamer and asserts the recorded push
interaction (result count + advancing `seq`).
