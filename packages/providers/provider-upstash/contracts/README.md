# Contracts

Two boundaries cross out of this package, and they are very different animals.

## 1. `start-redis` — the control plane

`provider-upstash-start-redis.pact.json` is the consumer-driven contract for
`POST https://upstash.com/start-redis`. `@hobo/provider-upstash` is the
consumer; Upstash is the provider.

`test/contract.test.ts` replays every interaction in that file through the real
`createUpstashClient`, asserting that the request the client emits still matches
the one the pact declares, and that the client behaves as documented when handed
the pact's recorded response.

**Only the consumer half is verified.** Nobody can verify Upstash's half
offline, and this package's default test lane makes no live calls. The pact
therefore does two jobs: it pins what this client sends, and it records — with a
`metadata.source.checkedAt` date — what a human last observed the provider
sending back. When someone re-checks the surface, the diff against this file is
the review.

### Interactions

| Interaction | What it pins |
|---|---|
| create with a caller-generated UUIDv4 idempotency key | `POST /start-redis`, `Idempotency-Key`, `Accept: text/markdown`, and the markdown response shape |
| re-POST of the same key | Adoption is *the same request*, not a second endpoint — the only reason retrying is safe |
| 429 | Maps to `PROVIDER_RATE_LIMITED`, carrying `Retry-After` |

### The response body is not a schema

The provider returns human-readable markdown with a live credential in it. There
is no version header and no content negotiation that yields JSON. `src/start-redis.ts`
parses it under an explicit contract id, `upstash.start-redis.markdown/v1`, with
every field, charset, and bound named — and fails closed with
`PROVIDER_CONTRACT_CHANGED` on anything it does not recognise, **including a new
labelled field**. The field Upstash is most likely to add is another credential,
and a parser that skips unknown fields would hand back a database whose second
token this driver never deposits and never redacts.

Changing that parser to accept a new shape means bumping the contract id, not
widening the regexes in place.

### Credentials in this directory

The recorded body contains a token-shaped string. It is `FAKE-…-DO-NOT-USE-…`,
and `test/contract.test.ts` asserts that every recorded body in the pact says so.
A real token must never be committed here — see the fixture note in
`test/fixtures/`.

## 2. `KvRedisExecutor` — the data plane

`createUpstashRestExecutor` is a **provider** of the `KvRedisExecutor` contract
owned by `@hobo/kv-redis-compatible` (see that package's `contracts/README.md`
for the expectations). Verification is `test/conformance.test.ts`, which runs the
full `kv.redis-compatible/v1` suite through the real adapter — real JSON command
array, real bearer header, real `{result}` / `{error}` envelope — against the
reference store standing in for the server.

That is an **adapter** conformance claim, not a measurement of Upstash. The
conformance ref says so in its own text
(`…@offline-reference-store@2026-08-08`), and the README says it in words.

The adapter deliberately exposes no `advanceTime`: a real endpoint has a real
clock, and offering one would let the suite "prove" TTL behaviour it never
observed. The offline harness borrows the *reference server's* clock instead,
and a test pins the degradation — without a clock the run reports `incomplete`,
which becomes `unknown` conformance, which selection rejects.
