# Cloudflare CI contract inventory

| Boundary | Consumer | Provider | Protocol | Pact | Verification | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Readiness query/parser | SDK caller | HoBo CI Cf | In-process synchronous message | `readiness.pact.json` | `readiness.consumer.test.ts` invokes exported SDK | consumer tested |
| Native pipeline execution | HoBo adapter | `@cloudflare/ci` CiContext / CiRunnerResult | Snapshot-chained native SDK calls | `native-context.pact.json` | `native-context.consumer.test.ts` drives shipped adapter against the native SDK contract and real local POSIX commands | consumer tested against simulated provider |
| Local checkout and backup selection | Local Worker | SDK source adapter and Sandbox options | Upstream typed method calls | `local-source.pact.json` | `local-source.consumer.test.ts` checks image archive checkout, no credentials/reporting, and forced local backup mode | hand-authored consumer expectations |

The native provider expectation pins deterministic runner names, exactly one root
context call, snapshot-chain calls, private workspace, native root working directory, per-command environment, zero retries,
bounded timeouts, exit status, output and artifact integrity. Backend tests also
cover stream output, failure, shell quoting, cancellation acknowledgement and
unconfirmed shutdown. Native SDK types are imported only as types in Node code;
the Worker example compiles against the actual Cloudflare package.

No remote Cloudflare API call, account or repository is used by these tests.

The native-context fixture can overlay original tracked source before each SDK
runner call, matching the pinned SDK restore behavior. Workspace regressions prove
HoBo preserves edits/deletions and artifacts in its private source copy despite
that overlay. The runner-options gate executes the actual pinned upstream timeout
configuration resolver extracted through the TypeScript compiler AST.
