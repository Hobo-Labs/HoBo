export interface Verb {
	readonly name: string;
	readonly role: string;
	readonly summary: string;
}

export const CANONICAL_VERBS: readonly Verb[] = [
	{
		name: "up",
		role: "lifecycle",
		summary: "Realize the current object graph",
	},
	{ name: "down", role: "lifecycle", summary: "Tear down what up realized" },
	{ name: "dev", role: "local loop", summary: "Run against runtime-local" },
	{
		name: "new",
		role: "local loop",
		summary: "Scaffold a runnable SDK program",
	},
	{
		name: "login",
		role: "identity",
		summary: "Obtain a dev SVID through OIDC",
	},
	{
		name: "connection",
		role: "identity",
		summary:
			"Manage durable Connections (create/authorize/list/get/revoke/rotate)",
	},
	{
		name: "identity",
		role: "identity",
		summary:
			"Inspect migration identity (status/inspect) or manage auth.md agents (agent discover/register/status/claim/poll/token/rotate/revoke)",
	},
	{
		name: "trails",
		role: "migration",
		summary:
			"Observe Trails status/plan/inspect (continuous migration; identity hands-off)",
	},
	{
		name: "access",
		role: "identity",
		summary:
			"Request elevated/cross-env access or break-glass (short-lived capability; audited)",
	},
	{
		name: "feature",
		role: "delivery",
		summary:
			"OpenFeature flags / canary / experiment status (list|eval|set|kill)",
	},
	{
		name: "deploy",
		role: "delivery",
		summary: "Attested continuous delivery status/logs/rollback (secret-free)",
	},
	{
		name: "ci",
		role: "delivery",
		summary: "Connect a repository and inspect CI runs (connect/list/inspect)",
	},
	{
		name: "incident",
		role: "delivery",
		summary: "CD failure disposition: A2H handoff or sandboxed self-heal",
	},
	{
		name: "claim",
		role: "identity",
		summary: "Bind an anonymous deployment to an account",
	},
	{
		name: "recipes",
		role: "read-only",
		summary: "List and inspect deployment recipes and their claim terms",
	},
	{
		name: "offer",
		role: "read-only",
		summary: "Compile a deployment offer and its consent requirements",
	},
	{ name: "plan", role: "read-only", summary: "Dry-run the up decision" },
	{
		name: "verify",
		role: "read-only",
		summary: "Run the unified Gatekeeper preflight",
	},
	{
		name: "can-deploy",
		role: "read-only",
		summary: "Diagnose producer/consumer compatibility",
	},
	{
		name: "inspect",
		role: "read-only",
		summary: "Render projections and time-travel views",
	},
	{
		name: "logs",
		role: "read-only",
		summary: "Live-tail Camp runtime streams",
	},
	{
		name: "doctor",
		role: "diagnostics",
		summary: "Report environment and portability hazards",
	},
	{
		name: "messaging",
		role: "diagnostics",
		summary: "Inspect messaging capability and delivery-guarantee readiness",
	},
	{
		name: "codegen",
		role: "authoring",
		summary: "Regenerate checked-in generated clients",
	},
	{
		name: "build",
		role: "authoring",
		summary: "Compile services to wasm components",
	},
	{
		name: "collect",
		role: "authoring",
		summary: "Run resource collection and print manifest IR",
	},
	{
		name: "stub",
		role: "authoring",
		summary: "Run with a contract-backed stub",
	},
	{
		name: "drift",
		role: "diagnostics",
		summary: "Report drift and governed remediation paths",
	},
	{
		name: "add",
		role: "distribution",
		summary: "Install a provider or listing",
	},
	{
		name: "registry",
		role: "distribution",
		summary: "Administer registry artifacts",
	},
	{
		name: "import",
		role: "migration",
		summary: "Adopt existing estate in place",
	},
	{
		name: "generate",
		role: "generation",
		summary: "Request provider generation",
	},
	{
		name: "sandbox",
		role: "test loop",
		summary: "Run a contract-backed isolated lane",
	},
	{
		name: "test",
		role: "test loop",
		summary: "Alias for the sandbox test lane",
	},
	{
		name: "attest",
		role: "governance",
		summary: "Produce signed external evidence exports",
	},
	{
		name: "erase",
		role: "governance",
		summary: "Request crypto-shred erasure",
	},
	{
		name: "broker",
		role: "governance",
		summary: "Resolve placements through the broker (the Conductor)",
	},
	{
		name: "yard",
		role: "control plane",
		summary: "Install and inspect the default bare-metal Yard",
	},
	{
		name: "station",
		role: "control plane",
		summary:
			"Station occupancy setup/ops (init/up/status/rails); not a lifecycle verb",
	},
	{
		name: "serve",
		role: "control plane",
		summary: "Local control-plane HTTP+SSE for the Yard game UI",
	},
	{
		name: "replay",
		role: "observability",
		summary:
			"Session Replay list/get/open/summarize/retention/doctor (privacy-first; distinct from event-log replay)",
	},
	{
		name: "derivative",
		role: "extensibility",
		summary: "Manage derived HoBo implementations",
	},
	{
		name: "runbook",
		role: "SRE",
		summary: "Execute or replay incident runbooks",
	},
] as const;

export const GLOBAL_FLAGS = [
	"--json",
	"--camp <camp>",
	"--cwd <path>",
	"--verbose",
	"-q",
	"--help",
] as const;

export const verbNames = new Set(CANONICAL_VERBS.map((verb) => verb.name));

export const projectScopedVerbs = new Set(
	CANONICAL_VERBS.map((verb) => verb.name).filter(
		(verb) =>
			![
				"new",
				"doctor",
				"login",
				"ci",
				"claim",
				"identity",
				"trails",
				"access",
				"feature",
				"add",
				"registry",
				"generate",
				"derivative",
				"broker",
				"yard",
				"station",
				"replay",
			].includes(verb),
	),
);

export function helpText(): string {
	const verbRows = CANONICAL_VERBS.map(
		(verb) => `  ${verb.name.padEnd(12)}${verb.role.padEnd(14)}${verb.summary}`,
	).join("\n");

	return `HoBo CLI

Usage:
  hobo [global flags] <verb> [args]
  hobo --help
  hobo <verb> --help

Start here:
  hobo doctor             Check local readiness and next steps
  hobo new my-app -t api  Scaffold an offline app
  cd my-app && hobo dev --once

Global flags:
  --json          Emit a machine-readable JSON envelope on stdout
  --camp <camp>   Select the target Camp
  --cwd <path>    Resolve the HoBo project from this directory
  --verbose       Print detailed diagnostics on stderr
  -q              Suppress non-error human output
  --help          Show help

Canonical verbs:
${verbRows}
`;
}

export interface VerbHelpOptions {
	// Whether the current composition wires a real handler for this verb
	// (registry.isImplemented). Omitted: the status line is left out — help
	// rendered without registry knowledge must not claim either way.
	readonly implemented?: boolean;
}

export function verbHelpText(
	verbName: string,
	options: VerbHelpOptions = {},
): string {
	const verb = CANONICAL_VERBS.find((candidate) => candidate.name === verbName);
	if (!verb) {
		throw new Error(`verbHelpText called with unknown verb: ${verbName}`);
	}

	const statusLine =
		options.implemented === undefined
			? ""
			: options.implemented
				? "Status: implemented in this composition\n"
				: "Status: not yet implemented in this composition\n";

	if (verb.name === "ci") {
		return `HoBo CI

Usage:
  hobo ci [global flags]
  hobo ci enable [--remote <name>] [--relay <https-origin>]
  hobo ci connect                  Alias of enable
  hobo ci list|ls                  List GitHub Actions runs
  hobo ci inspect [run]            Inspect a run
  hobo ci logs [run]               Read run logs
  hobo ci grep <text>              Search recent run logs
  hobo ci rerun [run]              Retry a completed run
  hobo ci status                  Inspect the relay connection
  hobo ci serve                   Host the CI relay locally (see serve options)

Role: ${verb.role}
${statusLine}
Running hobo ci without a subcommand shows help. connect and enable share the
repository setup flow. A sole Git remote supplies the repository automatically;
use --remote when the repository has several remotes.

Connection options:
  --remote <name>              Select the Git remote
  --repo <owner/repository>    Select a GitHub repository explicitly
  --relay <https-origin>      Select the HoBo CI relay
  --token-file <path>         Read the account credential from a file
  --installation-id <id>      Select an installed GitHub App
  --accept-all-matching-jobs  Allow isolated runners for matching repository jobs
  -y, --yes                   Skip the connection confirmation
  --non-interactive           Never prompt (enable also requires --yes)

Serve options (hobo ci serve):
  --environment <name>        CI profile from .hobo/ci.json (default + overrides)
  --config <path>             Alternate ci.json path
  --host <address>            Bind address (default 127.0.0.1; use 0.0.0.0 for containers)
  --port <number>             Listen port (independent of public origin behind a proxy)
  --origin, --base-url, --url, --endpoint <origin>
                              Public HTTPS origin for webhooks and runner callbacks
  --trust-proxy               Honor X-Forwarded-Proto from a TLS-terminating reverse proxy
  --admission push|pull       Webhook push vs GitHub poll admission
  --installation-id <id>      Required for pull admission polling
  --allow-insecure            Allow non-loopback HTTP without TLS
  --with-worker               Start isolated-container worker (needs DATABASE_URL)
  --print-config              Print resolved config (secrets redacted) and exit
  --db <path>                 SQLite relay store path
  --engine <name>             Serve only this engine (repeatable; default: profile + repo inventory)
  --home <path>               HOBO_HOME for serve state (credentials, db)

Run options:
  --git-branch, --branch <name>  Filter list/grep by branch
  --all-branches                Search list/grep across branches
  --commit <sha>                Filter list by commit
  --status <status>             Filter list/grep: queued, running, succeeded,
                                failed or skipped
  --limit <count>               List runs (1-100) or log tasks (1-25)
  --attempt <number>            Select an inspect/logs run attempt
  --wait                        Wait for inspect/rerun completion
  --failed                      Read failed job logs only
  --task <name>                 Select an exact job name for logs (repeatable)
  --grep <text>                 Filter log lines by text
  --runs <count>                Search this many recent runs with grep (1-50)

--follow, --level and --next are unsupported. GitHub Actions logs are
unstructured; use --grep for text filtering.

Use runs-on: hobo in a GitHub Actions workflow, then push a commit.
Authentication: HOBO_CI_ACCOUNT_TOKEN, HOBO_CI_ACCOUNT_TOKEN_FILE or --token-file.
Relay selection: --relay or HOBO_CI_RELAY_URL on first connection. Run commands
use the authenticated GitHub CLI (gh). Credentials are never written to the
repository. Use --json, --format json or -F json for machine-readable output.
HoBo runs existing Actions workflows; Vercel's Turbo task tags and invocation
IDs do not apply.
`;
	}

	if (verb.name === "identity") {
		return `HoBo identity

Usage:
  hobo identity status
  hobo identity inspect <migration-id>
  hobo identity agent discover <https-resource>
  hobo identity agent register <agent.json>
  hobo identity agent status|claim|poll|token|rotate|revoke <https-resource> <registration-ref>

Role: ${verb.role}
${statusLine}
Agent registration config (agent.json):
  {"resource":"https://broker.example/","binding":{"sessionId":"session-1","tenantId":"tenant-1","projectId":"my-app","audience":"broker-api","service":"https://broker.example/"},"requestedScopes":["deploy:write"]}

Metadata controls registration and scopes. The selected broker advertises
resourceMetadataUrl; placement uses a server-issued token obtained through
private_key_jwt. Keys and claim-poll credentials remain in owner-only HOBO_HOME
files. token verifies exchange and prints references and expiry only.

Agent claim returns a human approval URL; poll completes that principal claim.
Human login and infrastructure ownership remain independent. After hobo claim
binds infrastructure, required rotation gates further agent management.
rotate uses the advertised endpoint and verifies replacement key proof.
revoke refuses further agent token exchange and placement.
`;
	}

	if (verb.name === "new") {
		return `HoBo new

Usage:
  hobo new <name> [global flags] [-t todo|api|agent|fullstack] [--force]

Role: ${verb.role}
${statusLine}
Scaffold an offline SDK program with checked-in generated bindings.

Example:
  hobo new my-app -t api
`;
	}

	if (verb.name === "stub") {
		return `HoBo stub

Usage:
  hobo stub [global flags] [--check]

Role: ${verb.role}
${statusLine}
Materialize the contract-backed trainable stubs codegen emits for the
project's bindle steps (src/_generated/trainables.ts) — one training.define()
per step, served from its contract example until a training artifact is
promoted. Pass --check to validate the generated tree without writing.

Example:
  hobo stub --check
`;
	}

	if (verb.name === "codegen") {
		return `HoBo codegen

Usage:
  hobo codegen [global flags] [--check]

Role: ${verb.role}
${statusLine}
Regenerate the project's checked-in src/_generated/ tree from its
WIT/Zod/allow/bindle sources. Pass --check to report drift without writing
(exits non-zero when the tree is stale) — the same generator hobo build
asserts freshness against.

Example:
  hobo codegen --check
`;
	}

	if (verb.name === "build") {
		return `HoBo build

Usage:
  hobo build [global flags]

Role: ${verb.role}
${statusLine}
Compile the project's services to wasm components, asserting the checked-in
generated tree is fresh first (same generator as hobo codegen --check).

Example:
  hobo build
`;
	}

	if (verb.name === "collect") {
		return `HoBo collect

Usage:
  hobo collect [global flags] [--check]

Role: ${verb.role}
${statusLine}
Run resource collection over the project Bindle and print the manifest IR.
Pass --check to enforce the golden manifest instead of printing.

Example:
  hobo collect --json
`;
	}

	if (verb.name === "dev") {
		return `HoBo dev

Usage:
  hobo dev [global flags] [--once] [--serve] [--port <port>] [--host <host>] [--home <path>]

Role: ${verb.role}
${statusLine}
Serve the project on the local Yard (bare-metal runtime-local). Long-lived
on an interactive terminal; --once (or a non-TTY / --json run) probes and
exits for tests and CI. Pass --serve to force the long-lived server from a
non-TTY caller (agent, supervisor, container); --once and --json win over --serve.

Example:
  hobo dev --once
  hobo dev --serve --port 4000
`;
	}

	if (verb.name === "login") {
		return `HoBo login

Usage:
  hobo login [global flags] [--home <path>] [--broker <uri>]

Role: ${verb.role}
${statusLine}
Obtain a dev session/identity context and persist it to .hobo/session.json
so hobo up / hobo down run under it. --broker targets a remote Conductor
endpoint (--broker-uri is an accepted alias).

Example:
  hobo login
`;
	}

	if (verb.name === "plan") {
		return `HoBo plan

Usage:
  hobo plan [global flags]

Role: ${verb.role}
${statusLine}
Dry-run the up decision (read-only): parse the project Bindle, run the
Planner against the provider registry, and render the content-addressed
DeploymentPlan. An unsatisfiable manifest exits non-zero with remediation.

Example:
  hobo plan --json
`;
	}

	if (verb.name === "up") {
		return `HoBo up

Usage:
  hobo up [global flags] [--to <revision> | --rollback] [--anonymous]
          [--broker <uri>] [--home <path>] [--hold]

Role: ${verb.role}
${statusLine}
Realize the current object graph: plan, then drive provisioning through the
Conductor with progress on stderr. --to pins a revision, --rollback selects
the previous one (mutually exclusive), --anonymous (alias --temporary)
deploys without an account, --broker targets a remote Conductor
(--broker-uri alias), --hold stages without applying.

Example:
  hobo up --anonymous
`;
	}

	if (verb.name === "down") {
		return `HoBo down

Usage:
  hobo down [global flags] [--force]

Role: ${verb.role}
${statusLine}
Tear down what up realized: reverse-dependency destroy of every provisioned
resource, with progress on stderr.

Example:
  hobo down
`;
	}

	const body =
		options.implemented === true
			? `This shell dispatches ${verb.name} to the handler wired by the composition root.`
			: `${verb.name} is not yet implemented: this shell dispatches through the shared command registry, and un-wired compositions serve the intentional stub envelope (exit non-zero) until the owning slice injects a handler.`;

	return `HoBo ${verb.name}

Usage:
  hobo ${verb.name} [global flags] [args]

Role: ${verb.role}
${statusLine}
${body}
`;
}
