# Product CLI contracts

`hobo-composition-boundary.pact.json` pins the existing product composition
boundary. `ci-cli.pact.json` adds the account CI consumer: policy read, bound App
installation discovery, and isolated repository connection with bearer headers,
generated protobuf JSON and the current policy revision in `If-Match`.
`test/ci-command.test.ts` executes every interaction through the real CLI and
exported relay client and checks the complete request sequence. These are
hand-authored consumer expectations, not captured or provider-verified traffic.
The corresponding HTTP provider suite remains in
`../../ci-gh-actions/contracts/hosted-control-boundary.pact.json` and its provider
tests. The CLI adds no new server endpoint or response shape.

`ci-github-device.pact.json` pins the GitHub device-code and pending-token HTTP
interactions. `test/ci-github-connect.test.ts` executes these requests and also
exercises disabled flow, backoff, denial, and relay installation polling. The
relay OAuth start remains covered by `@hobo/ci-gh-actions`' OAuth-session tests.
GitHub is an external provider and does not verify this consumer fixture; live
App registration, settings changes, and installation remain release checks.

`test/ci-runs.test.ts` exercises the process contract to GitHub CLI with exact
argument arrays, repository/host selection, bounded JSON parsing, current commit
resolution, retry admission and new-attempt fencing. It uses a process seam;
live GitHub assignment, logs, and reruns remain release checks.

`e2e/ci.test.ts` additionally exercises the built executable over real HTTPS to
the production hosted control plane and native PostgreSQL journal. Restart and
lost-response cases verify idempotent recovery after a durable commit. GitHub App
identity is emulated; provider assignment remains a separate live acceptance.
The account HTTP client bounds responses to 2 MiB and rejects invalid UTF-8;
its consumer contract covers these failures without logging credentials.

TypeScript protects the command integration. `data-models/composition.proto`
owns the generated persisted CI link; `composition.cue` constrains its HTTPS
origin, account and repository. Checked-in valid/invalid fixtures run through the
package schema gate and reject insecure origins, malformed identities and embedded
credentials. Credentials stay outside the link. Relay writes
continue through the existing durable account/setup commands and projections;
the CLI does not introduce a parallel event journal or read model.

`vercel-git-deploy.pact.json` pins the Vercel REST requests of a git-source
deployment and of non-secret project configuration: the environment-variable
read, a `plain` create for one environment, a value edit, and Create Deployment
with a `gitSource` for preview (no `target`), for production pinned to a commit,
in the token's own scope, and refused with "Project not found".
`test/vercel-git-deploy.test.ts` replays it through `pactBackedTransport`
(`@hobo/testing`) with a lifecycle over the three recorded listings (the setting
absent, as asked, and under an older value), compares each request the client
sent with the recorded one, and requires zero fidelity violations and zero
unmatched calls. It is a hand-authored consumer expectation checked against
Vercel's REST reference: not captured traffic, and not verified by Vercel. The
project-create, conflict, refusal and redaction cases use a scripted transport
in the same file.

`hobo ci deploy` adds no endpoint to that pact: `test/ci-relay-deploy.test.ts`
drives the real CLI against the real relay declaration
(`../../ci-vercel/src/bindle.ts`) and the same pact-backed transport, and
checks the request sequence, the outputs, and that a second run writes nothing.
Its dry-run record is `data-models/vercel_git_deployment.proto`
(`VercelGitDeploymentPlan`), constrained by `vercel_git_deployment.cue` with
valid fixtures that are the command's own output and invalid ones for a
secret-named setting, a credentialed value, an implied or unknown target, a
slug scope, another git host, a short sha, no requests and a path off the API.
