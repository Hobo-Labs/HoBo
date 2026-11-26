# Contracts

One boundary crosses out of this package over the network: the OCI distribution
API on `ttl.sh`. The push itself does not cross it directly — it goes through an
injected `OciPushExecutor`, whose default implementation shells out to `crane` —
so the HTTP contract here covers the **read** side, which is what tells HoBo
whether an artifact is still there.

## `provider-ttl-sh-registry.pact.json`

`@hobo/provider-ttl-sh` is the consumer; ttl.sh is the provider.
`test/contract.test.ts` replays every interaction through the real
`createGuardedTransport`, asserting that the request this driver emits is one
the pact describes and that the driver behaves as documented when handed the
pact's recorded response.

**Only the consumer half is verified.** Nobody can verify ttl.sh's half offline,
and this package's test lane makes no live calls. The file therefore does two
jobs: it pins what this driver sends, and it records — with dated
`metadata.sourceRefs` — what a human last observed coming back. When someone
re-checks the surface, the diff against this file is the review.

### Interactions

| Interaction | What it pins |
|---|---|
| anonymous `/v2/` probe | The API surface is reachable with no credential at all |
| manifest read | `GET /v2/<name>/manifests/<ttl>`, the OCI manifest media type, and the `Docker-Content-Digest` the receipt records |
| manifest read after the TTL | A reaped artifact is a 404, which maps to `LEASE_EXPIRED` and is **not** retryable — the fix is a new push, not a retry |
| 429 | Maps to `PROVIDER_RATE_LIMITED`, carrying `Retry-After` |
| 401 with `WWW-Authenticate` | A challenge this registry must never issue; it maps to `PROVIDER_CONTRACT_CHANGED`, never to "go find a credential" |
| 302 off-host | Refused rather than followed, because the redirect target is not on the allowlist |

The last two are the reason the pact is worth having. Both are shapes a
general-purpose registry client would handle helpfully — retry with auth, follow
the redirect — and both are exactly wrong here: this registry is anonymous and
single-origin, so either response means the thing answering is not the thing
this package was written against.

### No credential appears in this directory

Every recorded request is anonymous, and `test/contract.test.ts` asserts that no
interaction carries any header on `FORBIDDEN_REQUEST_HEADERS`. There is no
credential to record, because ttl.sh accepts none — and a pact that documented
one would be documenting a leak as though it were the contract.

Names and digests in the fixtures are obviously fake: a fixed UUID and
repeating-hex digests, shared with `test/fixtures/`.
