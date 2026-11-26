# Azure DevOps consumer contracts

`live.pact.json` is the complete HTTP connection contract for Azure DevOps REST
7.1. Its hand-authored interactions cover self-hosted pool discovery, definition
revision, compiled and shortcut YAML previews, one pinned queue request, running
and terminal status, timeline, retained artifacts, cancellation and reconciliation.
Hosted/stale/extra-job previews, malformed responses, authorization failures and
credential redirects are declared provider states.

`live-edge.pact.json` adds malformed/ambiguous identities, admission variants,
non-success lifecycle states, individual timeline failures, artifact mismatches
and encoded names. The [edge-case matrix](../test/edges/README.md) identifies the
tests and transport-framing faults that consume them.

`fixtures/pact-broker.ts` parses the Pact with `@hobo/contract-harness` and serves
responses through its shared mock provider. Scenarios select recorded interactions
in order. The broker independently enforces method, complete query, authorization,
content type and exact request body. An unconsumed interaction or mismatch fails
even when the client intentionally catches a failure. No test branch fabricates
an Azure response body.

`test/live.test.ts` drives the shipped acceptance client through that broker.
`live.consumer.test.ts` additionally routes it through real loopback HTTP for
success, cancellation and redirect refusal. Negative controls prove incorrect
methods, revisions, headers, commits, extra body fields and redirect policy fail.
Only the test transport redirects the destination to loopback; production's
Azure endpoint allowlist is unchanged.

`pipeline.pact.json` pins the self-hosted pool and both native Pipeline Artifact
task inputs. The renderer consumer test consumes both interactions. The generated
Bash/CLI acceptance test also checks them before its filesystem task host publishes
and downloads the execution bundle, then verifies collected bytes and hashes.

After building the package, run `pnpm --filter @hobo/ci-ado test:contracts` for
the connection lane, including command execution and artifact acceptance.
The package `typecheck` command also compiles these tests and broker helpers
under the production TypeScript strictness settings.
No Azure account, agent or credential is needed for this lane. See the inventory
for evidence boundaries. These are consumer tests against simulated providers;
remote Azure provider verification and external Pact Broker publication are not
claimed. The authenticated `live` CLI remains an additional service smoke check.
