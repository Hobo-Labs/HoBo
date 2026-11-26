/**
 * The lines `opensesame dev --agent run` prints for each way a run goes, copied
 * verbatim from its source (apps/cli/src/dev_surrogate.rs, dev_credentials.rs,
 * dev_supervise.rs, dev_run.rs and crates/env-spec) as of OpenSesame b60790eb3,
 * and checked again at efe9c5adb, whose env-spec bridge looks `node` up only in
 * PATH directories group and others cannot write (crates/env-spec/src/node_bridge.rs).
 * `bridge-no-node` is the older binary's line, `bridge-untrusted-node` the newer one's.
 * The `bridge-no-usable-node*` and `bridge-node-override-*` lines are what
 * OpenSesame's #1461 prints (merged to its main as 6d4cdc795; from
 * crates/env-spec/src/node_bridge.rs and node_bridge/operator.rs there, read
 * as source, not run): the PATH search in its new words, and `OPENSESAME_NODE`
 * (an absolute path to the `node` to run) refused with a reason that names the
 * variable. The older `bridge-untrusted-node` words are kept for the kit the
 * real lane was built from (efe9c5adb), which predates it.
 * The fake binary prints them; test/real/ checks that the real binary prints
 * lines the adapter classifies the same way.
 */
export const SAMPLE_LINES = {
	"plugin-absent": [
		"opensesame: surrogate delivery is available as an optional plugin ('opensesame plugins install surrogate-proxy --from <path-or-https-url> --sha256 <hex>'); delivering placeholders",
	],
	"no-sealed-entry": [
		"opensesame: VERCEL_TOKEN has no token to redeem: store one with 'opensesame pass insert connections/acme/vercel' (this provider draws none from a local tool)",
		"opensesame: the surrogate-proxy plugin brokers none of these connections; delivering placeholders",
	],
	misdirected: [
		"opensesame: surrogate.misdirected: a surrogate from this run was sent to a host that is not its provider's; the run's surrogates are revoked (1) and the child is stopped",
	],
	sigterm: [
		"opensesame: SIGTERM: the run is ended and its surrogates are revoked (1); the child is stopped",
	],
	sighup: [
		"opensesame: SIGHUP: the run is ended and its surrogates are revoked (1); the child is stopped",
	],
	"plugin-changed": [
		"Error: the surrogate-proxy plugin no longer matches its install pin; reinstall it or run 'opensesame plugins disable surrogate-proxy'",
	],
	"wrong-passphrase": [
		"Error: the sealed entry connections/acme/vercel (for VERCEL_TOKEN) cannot be read: crypto: crypto failure",
	],
	"empty-entry": [
		"Error: the sealed entry connections/acme/vercel (for VERCEL_TOKEN) is empty",
	],
	"scope-unbounded": [
		'Error: the surrogate-proxy plugin refused the run and issued nothing: VERCEL_TOKEN has no bounded scope. Declare what the child may reach on its env-spec entry, for example paths="/repos/acme,/user" and methods="GET"; the root is not a scope',
	],
	"paths-without-methods": [
		'Error: resolve failed: VERCEL_TOKEN cannot be delivered: paths= needs methods= beside it: name the verbs the surrogate may use, for example methods="GET"',
	],
	"bridge-no-parser": [
		"Error: env-spec parse failed: bridge failed: node:internal/modules/esm/resolve:873",
		"  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);",
		"Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@env-spec/parser' imported from /kit/bridge/opensesame-env-parse.mjs",
	],
	"bridge-no-node": [
		"Error: env-spec parse failed: io: No such file or directory (os error 2)",
	],
	"bridge-untrusted-node": [
		'Error: env-spec parse failed: no usable `node`: only absolute, existing directories that group and others cannot write are searched, and PATH has none (skipped: "/opt/hostedtoolcache/node/22.22.0/x64/bin" writable by group or others; "." relative)',
	],
	"bridge-node-elsewhere": [
		"Error: env-spec parse failed: no usable `node`: only absolute, existing directories that group and others cannot write are searched, and none of /usr/sbin holds a `node`",
	],
	"bridge-no-usable-node": [
		'Error: env-spec parse failed: no usable `node`: PATH entries are searched only when absolute, existing, owned by root or you, not writable by others, and group-writable only by root\'s group or one of yours; PATH has none (skipped: "/opt/hostedtoolcache/node/22.22.0/x64/bin" writable by others; "." relative)',
	],
	"bridge-no-usable-node-elsewhere": [
		"Error: env-spec parse failed: no usable `node`: PATH entries are searched only when absolute, existing, owned by root or you, not writable by others, and group-writable only by root's group or one of yours; none of /usr/sbin holds a `node`",
	],
	"bridge-no-usable-node-rejected": [
		'Error: env-spec parse failed: no usable `node`: PATH entries are searched only when absolute, existing, owned by root or you, not writable by others, and group-writable only by root\'s group or one of yours; none of /usr/local/bin holds a `node` (skipped: node "/usr/local/bin/node" owned by uid 4242)',
	],
	"bridge-node-override-empty": [
		"Error: env-spec parse failed: OPENSESAME_NODE is set but empty; unset it or name a file",
	],
	"bridge-node-override-relative": [
		'Error: env-spec parse failed: OPENSESAME_NODE must be an absolute path, not "./node"',
	],
	"bridge-node-override-missing": [
		'Error: env-spec parse failed: OPENSESAME_NODE does not exist: "/opt/ci/node/bin/node"',
	],
	"bridge-node-override-not-file": [
		'Error: env-spec parse failed: OPENSESAME_NODE is not a regular file: "/opt/ci/node/bin"',
	],
	"bridge-node-override-not-executable": [
		'Error: env-spec parse failed: OPENSESAME_NODE is not executable: "/opt/ci/node/bin/node"',
	],
	"schema-syntax": [
		"Error: env-spec parse failed: bridge failed: SyntaxError: unexpected token at line 3",
	],
} as const;

export type SampleScenario = keyof typeof SAMPLE_LINES;

/** The sample lines for a scenario of the pact, if OpenSesame prints any of its own. */
export function linesFor(scenario: string): string {
	const entry = Object.entries(SAMPLE_LINES).find(
		([known]) => known === scenario,
	);
	return entry === undefined ? "" : `${entry[1].join("\n")}\n`;
}
