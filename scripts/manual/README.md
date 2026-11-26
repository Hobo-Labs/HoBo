# Anonymous hosting acceptance

This explicit live lane exercises the shipped SDKs for Cloudflare temporary
accounts, Neon claimable Postgres, Upstash temporary Redis, Prisma temporary
Postgres, Netlify Drop and Lakebed anonymous capsules. It creates provider
resources. It is separate from default PR and agent checks.

```sh
node --import tsx scripts/manual/hosting-anonymous-acceptance.mts \
  --provider=neon --state-dir=/absolute/private/path/hosting-acceptance
```

Select one of `cloudflare`, `neon`, `upstash`, `prisma-postgres`, `netlify` or
`lakebed`. Reuse the same state directory for the run. The directory must be
outside the checkout. If the host requires an outbound proxy, set
`NODE_USE_ENV_PROXY=1`; TLS verification stays enabled.

The lane creates one stable UUID and claims each provider's allocation in the
actual SQLite mutation journal before sending. Competing processes and reopened
runs cannot repeat an acknowledged or uncertain allocation. A crash before or
after a network write keeps its outcome uncertain. There is no automatic reset
or fresh-key retry. Do not replace the state directory to resolve a lost reply.
The private, versioned 256-bit host key is persisted beside the run identity.
Native bearer keys are HMAC-derived from that private key and deployment scope;
the public run UUID cannot reproduce them. Preserve the host key with the private
response custody when resuming or investigating a run.

Provider replies, claim URLs, database credentials and subprocess output are
saved immediately in the private directory with mode 0600 under directories
with mode 0700. Only hashed resource identities and bounded status facts reach
stdout. Private evidence remains available when an output parser changes.
SQLite contains mutation metadata, not HTTP bodies or credentials. CLI children
use pinned packages and isolated login/configuration directories.

| Provider | Acceptance performed | Cleanup evidence |
|---|---|---|
| Cloudflare | Native temporary account; generic Worker resolver creates a custom artifact; independent native artifact hash/readiness and HTTP body marker | Generic Worker DELETE followed by independent provider absence read; temporary account retirement remains separate |
| Neon | Native create and independent GET; SQL-over-HTTP `SELECT 1 AS hobo_validation` with exact result validation | Native expiry recorded; expiry does not prove retirement |
| Upstash | Native create through the actual driver and custody; REST `PING`; read-only GET metrics | Native expiry recorded; anonymous API has no delete operation |
| Prisma | Actual pinned `create-db@1.2.1` CLI with requested 30-minute TTL | CLI expiry uses its local clock; no provider retirement or SQL acceptance is inferred |
| Netlify | Actual pinned anonymous CLI; password form and origin-scoped cookie; served body marker | Claim window is documented separately; no deletion or final usage is inferred |
| Lakebed | Actual pinned `lakebed@0.0.41` CLI; native expiry; served `/health` body marker | Native expiry recorded; no deletion or final usage is inferred |

A completed allocation is distinct from a validated data plane. The command
exits nonzero for an uncertain outcome or unvalidated serving probe. Prisma's
provision-only result remains explicitly unvalidated. Neither an elapsed TTL,
a rejected credential nor a missing endpoint releases financial exposure.
Providers without an anonymous temporary API require authenticated live
acceptance in their own isolated account; this lane does not exercise them.

Offline validation makes no provider allocation:

```sh
node node_modules/vitest/vitest.mjs run scripts/test/hosting-anonymous-acceptance.test.ts
```

Those tests use actual SQLite connections, reopen, competing claims, private
file permissions, a real local HTTP allocation and secret-bearing lost replies.
