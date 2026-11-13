import {
	isJsonBoolean,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "./json.js";

export type WorkspaceEdge = {
	readonly from: string;
	readonly to: string;
	/**
	 * True when the edge exists only through `devDependencies` — a test-time
	 * import, not something the shipped package pulls in.
	 *
	 * The layering rules are about what a package *depends on to run*. A pack
	 * importing `describeConcern` in its own test suite is not reaching across
	 * a boundary at runtime, and treating it as though it were produced a
	 * standing allowlist of individually-blessed test edges. Absent or false
	 * means "assume runtime", so an edge whose provenance is unknown is still
	 * judged by the strict rule.
	 */
	readonly dev?: boolean;
};

/**
 * The rule a refusal is filed under in the gate's machine-readable event.
 *
 * Closed, and the same list as `rule` in `data-models/conformance.cue`. A
 * refusal cannot be raised without one of these names (`refuse` below takes
 * it), so every line the gate prints on stderr is also a record in the event's
 * `violations`. It was not always so: the three engine-neutrality rules had no
 * name, the script that built the event matched on message text, and a
 * refusal it did not recognise was printed and then left out of the JSON.
 */
export const BOUNDARY_RULES = [
	"core-imports-hobo",
	"adapter-imports-adapter",
	"adapter-imports-non-core",
	"outward-dependency",
	"workspace-cycle",
	"unknown-package",
	"orchestrator-imports-engine",
	"orchestrator-imports-engine-storage",
	"engine-imports-engine",
] as const;
export type BoundaryRule = (typeof BOUNDARY_RULES)[number];

/** One refusal, as `BoundaryViolationRecord` in `data-models/conformance.proto` carries it. */
export type BoundaryViolation = {
	readonly rule: BoundaryRule;
	readonly from_path: string;
	readonly to_path: string;
	readonly effect: "deny";
};

export type PackageKind =
	| "core"
	| "contract"
	| "adapter"
	| "package"
	| "external"
	| "unknown";

export type PackageClassification = {
	kind: PackageKind;
	layer: number;
};

// Layer-1 contract packages: provider-neutral vocabulary that adapters
// legitimately implement against, the same way they implement WIT worlds.
// ADR-0151 makes this explicit — capability profiles are "the missing semantic
// layer" between a Bindle primitive and a hosted product, and bindings are
// "independent of provisioners" — so a provider declaring the profiles it
// implements and emitting a portable binding is the designed direction of
// dependency, not a layering breach. Registering them as contracts is what
// makes that legal by construction instead of by a growing exception list.
// ADR-0156 records the longer-term move of these contracts into `@hobo/core`.
const CONTRACT_PACKAGE_PATHS = new Set([
	// `@hobo/provider-redaction`: the one redactor for provider text, which
	// every provider and pack redacts its errors through, and the linear-time
	// test harness that holds it. A leaf (it imports no HoBo package) that the
	// adapters depend on, like the vocabulary packages below; it lives outside
	// `@hobo/core` so a change to it does not run every core dependent's suite.
	"packages/provider-redaction",
	"packages/wit",
	"packages/capability-profiles",
	"packages/bindings",
	"packages/claims",
	"packages/trust",
	"packages/backend-fleet",
	"packages/data-postgres",
	"packages/kv-redis-compatible",
	// The data engine family (ADR-0177). `data-core` is the engine-neutral
	// contract and imports only `@hobo/core`; each `data-<engine>` package
	// implements that contract for one storage engine and meets the other
	// engines only through it — `validateBoundaryImports` refuses a runtime
	// engine -> engine edge, which the layering rules alone never did, since
	// every engine sits on the same layer.
	// They are contracts for the same reason `data-postgres` already was: an
	// engine binding is implementable vocabulary a provider declares against.
	"packages/data-core",
	"packages/data-sqlite",
	"packages/data-mongodb",
	// The four manifest packages (decomposition of `CapabilityRequirement` /
	// `SelectionCandidate` out of `@hobo/capability-profiles` and of
	// `ResourceIntent` / `ResourcePlan` out of `@hobo/cloud`).
	//
	// DECIDED, not assumed. Contract is the *permissive* classification here —
	// it lets any adapter import them with no allowlist entry — so the question
	// is whether that is what we want, and it is, for two reasons that were
	// measured rather than argued:
	//
	// 1. The alternative is unworkable. Registered only in
	//    `KNOWN_PACKAGE_PATHS`, each lands at layer 3, and the re-export wiring
	//    the decomposition requires — `@hobo/capability-profiles` re-exporting
	//    the capability and request shapes so no consumer changes — becomes a
	//    layer-1 package importing a layer-3 one. Measured:
	//    `dependency points outward: packages/capability-profiles -> <layer-3>`.
	//    Classifying them any other way would force a fresh allowlist entry for
	//    a package whose entire purpose is to be depended upon.
	// 2. It is the same case the set already exists for. These are
	//    provider-neutral record shapes with no behaviour, mechanically
	//    constrained to `@hobo/core` as their only workspace dependency, which
	//    the outward rule keeps honest: a manifest package that grows a
	//    dependency on an adapter or an app package fails this gate at layer 1
	//    before anyone can lean on it.
	//
	// The widening this *does* buy is deliberate: a provider that needs
	// `ResourcePlan` today has to import `@hobo/cloud`, a layer-3 app package —
	// which is why `pack-framework->packages/cloud` sits in the banked list
	// below. Making the plan shape a contract is the retirement path for that
	// entry, not an unrelated concession.
	"packages/manifest-capability",
	"packages/manifest-request",
	"packages/manifest-declaration",
	"packages/manifest-plan",
	// The cross-manifest round-trip proof. Known but deliberately NOT a
	// contract: it is a verification package that reads all four manifests and
	// the packages they were decomposed out of, so it sits at layer 3 and
	// nothing should ever depend on it. Classifying it as a contract would put
	// it at layer 1 and invite exactly the inward edge it exists to check —
	// and it did, for one commit: registered in the contract set by mistake, it
	// refused its own `-> packages/cloud` edge as `outward-dependency`, a
	// refusal that looked like a real layering finding and was an artifact of
	// the misregistration. Swarm I measured both placements and caught it.
	"packages/manifest-round-trip",
]);

const KNOWN_PACKAGE_PATHS = new Set([
	// HoBo.CI application SDKs compose the existing Dispatcher at layer 3.
	"packages/ci",
	"packages/ci-gh-actions",
	// The optional relay agent composes the relay; nothing depends on it.
	"packages/ci-agent",
	"packages/ci-ado",
	"packages/ci-dagger",
	"packages/ci-cf",
	"packages/ci-vercel",
	// The secret store a deploy chooses and hands over by claim (ADR-0179
	// amendment): a layer-3 package that composes the Infisical adapter, the
	// Cloudflare provider and the auth.md and claim planes; `hobo` uses it.
	"packages/secret-store-claim",
	"packages/core",
	"packages/contract-harness",
	// Test-only harness for code that reads hostile text, reached only from
	// tests, the way contract-harness is (`isDevOnlyTestHarnessEdge`).
	"packages/redaction-test-harness",
	"packages/wit",
	// `@hobo/bindings` shipped without an entry here, which is worse than it
	// sounds: an unclassified workspace path makes `parseWorkspaceEdge` *throw*
	// rather than report, so the whole boundary gate aborted instead of failing
	// one edge — trunk had no boundary enforcement at all, silently.
	"packages/bindings",
	"packages/auth-md",
	"packages/capability-matrix",
	"packages/capability-profiles",
	"packages/claims",
	"packages/convex",
	"packages/backend-fleet",
	"packages/data-postgres",
	"packages/kv-redis-compatible",
	"packages/packs/pack-framework",
	"packages/packs/pack-postgres-oci",
	"packages/packs/pack-valkey-oci",
	"packages/recipes",
	"packages/status-page",
	"packages/trust",
	"packages/wasp",
	"packages/bindles",
	"packages/camps",
	"packages/yards",
	"packages/cloud-providers",
	"packages/junctions",
	"packages/runtime",
	"packages/componentize",
	"packages/conformance",
	"packages/cli",
	"packages/hobo",
	"packages/stage-gate",
	"packages/policy",
	"packages/pricing",
	"packages/provider-manifest",
	"packages/data",
	"packages/events",
	"packages/identity",
	"packages/cloud",
	"packages/connectivity",
	"packages/contracts",
	"packages/broker",
	"packages/mcp",
	"packages/training-pipeline",
	"packages/code",
	"packages/ci-guard",
	"packages/control-api",
	"packages/control-yard",
	"packages/management",
	"packages/replay",
	"packages/schema-tools",
	"packages/stations",
	"packages/storage-sqlite",
	"packages/trails",
	"packages/agent-skills",
	"packages/evals",
	"packages/fuzz",
	"packages/patterns",
	"packages/pixel-village",
	"packages/registry",
	"packages/dispatcher",
	"packages/rift",
	"packages/sdk",
	"packages/training",
	"packages/yard-world",
	// ADR-0151 plane packages: present in the workspace since the capability
	// profile/binding/claim tranche landed, but never registered here, so the
	// boundary gate threw "unknown import source" on a clean tree.
	"packages/auth-md",
	"packages/bindings",
	"packages/capability-matrix",
	"packages/capability-profiles",
	"packages/claims",
	"packages/data-postgres",
	"packages/kv-redis-compatible",
	"packages/recipes",
	"packages/trust",
	"packages/wasp",
	"packages/convex",
	// ADR-0159 out-of-box application test harness.
	"packages/testing",
	// Default status-page sidecar (#1113). An ordinary layer-3 package: it
	// projects station/project/bindle state into a page and reaches nothing
	// below core.
	"packages/status-page",
	// Example Bindles vendored under the hobo-code harness. They consume
	// adapters and bindles like any application would, so they classify as
	// ordinary workspace packages rather than a new tier.
	"packages/code/examples/barebones",
	"packages/code/examples/hello-world",
	// Pre-registered before the directories exist. This set is never asserted
	// against the filesystem, and registering ahead of creation is the point:
	// an unclassified workspace path makes `parseWorkspaceEdge` *throw*, which
	// aborts the gate before it evaluates a single rule, so the run that
	// introduces a package is exactly the run with no boundary enforcement.
	// `@hobo/bindings` already shipped that state once (see the note above).
	// Their kind is decided in `CONTRACT_PACKAGE_PATHS`, which is checked
	// first; these entries only keep the classifier total.
	"packages/manifest-capability",
	"packages/manifest-request",
	"packages/manifest-declaration",
	"packages/manifest-plan",
	// Data engine family (ADR-0177); kind decided in `CONTRACT_PACKAGE_PATHS`.
	"packages/data-core",
	"packages/data-sqlite",
	"packages/data-mongodb",
]);

// Directories whose packages are adapters. One list, because two rules read
// it: the classifier, and the data engine name rule below.
const ADAPTER_TIER_PREFIXES = [
	"packages/providers/",
	"packages/iac/",
	"packages/build/",
	"packages/runtimes/",
	"packages/connectors/",
	"packages/adapters/",
	// ADR-0151 implementation packs are signed deployables that satisfy a
	// capability profile on generic compute. They sit at the adapter tier
	// for the same reason providers do: they implement a core contract and
	// must not reach sideways into layer-3 packages.
	"packages/packs/",
] as const;

/**
 * The directory name of a data engine package: `data-<engine>`, where
 * `<engine>` is one or more lowercase words and the first is not `core`.
 *
 * `data-core` is the engine-neutral contract, and `data-core-<anything>` is a
 * companion of the contract (a testing kit, say), not an engine named
 * "core-<anything>". The earlier pattern excluded only the exact name
 * `data-core`, so `data-core-testing` was an engine by accident. `data`, the
 * app-authoring kernel, has no `-<engine>` and never matched.
 */
const DATA_ENGINE_DIRECTORY = /^data-(?!core(?:-|$))[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * A data engine package, decided by where it is and what it is called:
 *
 * - `packages/data-<engine>` — the family as ADR-0177 lays it out; or
 * - `packages/<adapter tier>/data-<engine>` — the same name directly under an
 *   adapter tier directory (`packages/adapters/data-mysql`). An engine filed
 *   there is still an engine, and it must not be the way an orchestrator
 *   reaches a driver the top-level rule would have refused.
 *
 * Nothing else is: not a deeper path, not a `data-models/` folder inside some
 * package, not an example that happens to be called `data-<something>`. The
 * rule keys on a name, so it is kept to the two places where the name is a
 * statement about the package. A new engine is covered the day its directory
 * exists; nothing has to be registered for the rule to see it.
 */
export function isDataEnginePackage(path: string): boolean {
	const tier = ["packages/", ...ADAPTER_TIER_PREFIXES].find(
		(prefix) =>
			path.startsWith(prefix) && !path.slice(prefix.length).includes("/"),
	);
	return (
		tier !== undefined && DATA_ENGINE_DIRECTORY.test(path.slice(tier.length))
	);
}

/**
 * Packages that orchestrate migrations and must stay engine-neutral
 * (ADR-0177 decision 3). The runbook engine once held `node:sqlite` bindings
 * directly, which made it the place every engine's driver would accumulate;
 * this is the rule that keeps that from recurring. A test may still import an
 * engine to exercise a live lane — the rule is about runtime edges.
 */
const ENGINE_NEUTRAL_ORCHESTRATORS = new Set(["packages/trails"]);

/**
 * Modules that speak one database's protocol or open one database's files.
 *
 * The orchestrator rule above only knew `@hobo/*` engine packages, and the
 * defect it was written for was `import { DatabaseSync } from "node:sqlite"`:
 * a builtin, so never a workspace edge, so the original import would have
 * passed the gate again. A driver is named here as the specifier a source file
 * writes, and the scanner turns a sighting into an edge whose `to` is that
 * name.
 *
 * This is a list, so a driver that is not on it passes. It carries the drivers
 * of the engines the family has (SQLite, PostgreSQL, MongoDB) and the ones the
 * workspace lockfile already resolves; a new engine adds its driver here in
 * the change that adds the engine.
 */
const DATABASE_DRIVER_MODULES = new Set([
	"node:sqlite",
	"better-sqlite3",
	"sqlite3",
	"pg",
	"pg-native",
	"pg-pool",
	"postgres",
	"@electric-sql/pglite",
	"mongodb",
	"mysql2",
]);

/**
 * The database driver a module specifier loads, or `undefined` when it loads
 * none. A subpath belongs to its package: `pg/lib/native` is `pg`. A
 * neighbouring name does not: `pgvector` and `pg-connection-string` are not
 * `pg`.
 */
export function databaseDriverOf(specifier: string): string | undefined {
	for (const driver of DATABASE_DRIVER_MODULES) {
		if (specifier === driver || specifier.startsWith(`${driver}/`)) {
			return driver;
		}
	}
	return undefined;
}

/**
 * Workspace packages that are one engine's storage without being part of the
 * `data-<engine>` family. `@hobo/storage-sqlite` is the durable EventStore's
 * SQLite binding (ADR-0135): reaching it from an orchestrator is reaching
 * SQLite, whichever package the import names.
 */
const ENGINE_SPECIFIC_STORAGE_PACKAGES = new Set(["packages/storage-sqlite"]);

function isEngineSpecificStorage(target: string): boolean {
	return (
		DATABASE_DRIVER_MODULES.has(target) ||
		ENGINE_SPECIFIC_STORAGE_PACKAGES.has(target)
	);
}

// Documented, narrowly-scoped exceptions. The AI training/eval providers
// (provider-agentv, provider-ax) legitimately COMPOSE the SDK training/runtime
// packages instead of reaching them through a core port; these edges landed in
// #824/#825 and are tracked for a future ADR that classifies training/eval
// providers as a distinct tier. Scoped to these EXACT edges so genuine
// adapter->adapter and other outward imports still fail closed.
const ACCEPTED_ADAPTER_PACKAGE_EDGES = new Set([
	// ── Banked pre-existing edges (unenforced until the gate was repaired) ────
	// These are NOT blessed architecture. They are layer-2 → layer-3 imports
	// that already existed on trunk while the boundary gate was aborting on an
	// unclassified path and therefore checking nothing at all. Banking them is
	// what lets the gate enforce *no new* violations today instead of waiting
	// on a restructure — the same ratchet shape `lint:budget` uses for biome.
	//
	// The list shrank from 31 distinct entries to 14, over 18 deleted lines:
	// seventeen named a target that `CONTRACT_PACKAGE_PATHS` already
	// classifies as `contract`, which the adapter rule exempts a few lines
	// down, and the eighteenth was a duplicate line of an entry already
	// present. A provider importing
	// `@hobo/capability-profiles` or `@hobo/bindings` is declaring the
	// vocabulary it implements, which is the case the rule's own comment
	// describes as legitimate — those were never debt, they just read as debt.
	// Removing them was verified against the gate, not assumed: the violation
	// set is empty both before and after.
	//
	// What is left is the real remainder. Each is a package reaching another
	// implementation rather than a port or a contract. The fix is per-package
	// and belongs in its own PR; this list should only ever shrink, and every
	// entry needs a written reason. Do not add to it.
	"packages/providers/provider-convex->packages/sdk",
	"packages/providers/provider-agentv->packages/training-pipeline",
	"packages/providers/provider-ax->packages/runtime",
	// The runner tier (#891/#892) composes @hobo/runner-github's shared
	// execution-host vocabulary (SKU catalog, host registry, dispatch
	// tracking) rather than reaching it through a core port; runner-github is
	// functioning as the runner-tier base library. Same future-ADR tiering as
	// the training/eval providers above; scoped to these EXACT edges.
	"packages/providers/runner-blacksmith->packages/providers/runner-github",
	"packages/providers/runner-depot->packages/providers/runner-github",
	"packages/providers/runner-depot->packages/providers/runner-blacksmith",
	// Pre-existing layer-3 reaches, surfaced when the boundary gate stopped
	// throwing on unregistered packages (it previously crashed before reaching
	// rule evaluation, so these were never reported). Both are genuine breaches
	// awaiting the ADR-0156 lift of the selectable-definition and operator-SDK
	// types into @hobo/core; recorded here rather than left invisible, and
	// scoped to these EXACT edges so no new one is admitted.
	"packages/packs/pack-framework->packages/cloud",
	// The policy-engine gate-plane adapters (docs/plans/0017 F30) lower engine
	// verdicts onto @hobo/contracts' shared vocabulary (GatekeeperEffect,
	// PolicyDecisionRequest). The dependency deliberately points
	// provider->contracts so @hobo/broker can depend on the adapters without a
	// cycle; contracts is the shared contract layer, not an app package.
	"packages/providers/provider-opa->packages/contracts",
	"packages/providers/provider-cedar->packages/contracts",
	// provider-convex's @hobo/bindles edge is a devDependency only: the
	// golden-bindle test asserts no provider selection leaks into bindle
	// authoring (assertNoBindleProviderSelection). No runtime import exists.
	"packages/providers/provider-convex->packages/bindles",
	// The OpenBao adapter (#1003) implements @hobo/identity's secrets-manager
	// port; that port vocabulary lives in identity rather than core, same
	// future-ADR tiering as the training/eval and runner exceptions above.
	"packages/adapters/adapter-openbao->packages/identity",
	// The OpenSesame adapter (ADR-0170) is the second implementer of the same
	// port, for the same reason: SecretsPort, SecretsAccessResult and the
	// plaintext-conformance oracle live in identity rather than core. The edge
	// is one exact, named line; it admits no other adapter, runtime or provider,
	// and boundaries.test.ts pins the neighbours that stay refused.
	"packages/adapters/adapter-opensesame->packages/identity",
	// The Infisical adapter (ADR-0179) is the third implementer of the same
	// port, for the same reason; one exact, named line, pinned beside the others
	// in boundaries.test.ts.
	"packages/adapters/adapter-infisical->packages/identity",
	// The 1Password and Bitwarden Secrets Manager adapters (ADR-0179 amendment
	// "Secrets manager, not Infisical") are the fourth and fifth implementers
	// of the same port, for the same reason; one exact, named line each,
	// pinned beside the others in boundaries.test.ts.
	"packages/adapters/adapter-1password->packages/identity",
	"packages/adapters/adapter-bitwarden->packages/identity",
	// Connector packages (#1052) are AUTHORING-side declarations, not runtime
	// adapters: they export an opaque symbol built with @hobo/bindles'
	// defineConnector so b.connector() can resolve it. The edge points at the
	// authoring surface by design; future connector packages extend this list
	// until the same future ADR classifies the connector tier.
	"packages/connectors/connector-firecrawl->packages/bindles",
	// ADR-0135: the local/browser runtimes compose @hobo/storage-sqlite as the
	// durable engine behind HoBo-owned ports (schema v2, SqliteJournal). This is
	// the sanctioned runtime->storage composition, not a port bypass.
	"packages/runtimes/runtime-local->packages/storage-sqlite",
	"packages/runtimes/runtime-browser->packages/storage-sqlite",
]);

// The SWE agent connectors (swe-claude, swe-codex, swe-copilot, swe-cursor,
// swe-gemini, swe-grok, ...) all speak ACP through @hobo/connector-acp, the
// connector-tier base library (#893-#899), and share the SWE connector
// vocabulary through @hobo/swe-shared. A tier rule instead of exact edges
// because every new SWE connector adds the same edge; any other
// connector->connector import still fails closed.
function isConnectorTierBaseEdge(from: string, to: string): boolean {
	return (
		from.startsWith("packages/connectors/") &&
		(to === "packages/connectors/connector-acp" ||
			to === "packages/connectors/swe-shared")
	);
}

// The implementation-pack tier has the same shape as the connector tier:
// `pack-framework` is the tier's base library (pack descriptor, digest pinning,
// lifecycle) that concrete packs compose. Scoped to that exact target so
// pack->pack imports between concrete packs still fail closed.
function isPackTierBaseEdge(from: string, to: string): boolean {
	return (
		from.startsWith("packages/packs/") && to === "packages/packs/pack-framework"
	);
}

/**
 * The repo's PACT/concern test harness, reached only from tests.
 *
 * `@hobo/contract-harness` is layer 0 and exists to be imported by test suites;
 * `core` was already exempted inline and `runtime-oci` by name, both with the
 * note that the edge is dev-only. Saying that once, as a property of the edge,
 * beats blessing each package as it grows a test — the allowlist was accruing
 * entries that all had the same reason.
 *
 * Still deliberately narrow: only the test harnesses, and only when the edge is
 * dev-only. A runtime dependency on the harness is a real layering break and
 * keeps failing.
 */
function isDevOnlyTestHarnessEdge(edge: WorkspaceEdge): boolean {
	return edge.dev === true && TEST_HARNESS_PATHS.has(edge.to);
}

/**
 * The test harnesses: `@hobo/contract-harness`, and
 * `@hobo/redaction-test-harness` (the linear-time measure, sweep and
 * differential), kept apart so that a change to it plans only the suites that
 * redact rather than every package that tests a pact.
 */
const TEST_HARNESS_PATHS: ReadonlySet<string> = new Set([
	"packages/contract-harness",
	"packages/redaction-test-harness",
]);

function isAcceptedAdapterPackageEdge(from: string, to: string): boolean {
	return (
		ACCEPTED_ADAPTER_PACKAGE_EDGES.has(`${from}->${to}`) ||
		isConnectorTierBaseEdge(from, to) ||
		isPackTierBaseEdge(from, to)
	);
}

function isWorkspacePath(path: string): boolean {
	return path.startsWith("packages/") || path.startsWith("examples/");
}

export function parseWorkspaceEdge(input: JsonValue): WorkspaceEdge {
	if (!isJsonObject(input) || input === null) {
		throw new Error("workspace edge must be an object");
	}

	const record = input;
	// SAFETY: assertion to `d.from; const to =` is required at this boundary.
	const from = record.from;
	const to = record.to;

	if (!isJsonString(from) || from.length === 0) {
		throw new Error("workspace edge from must be a non-empty string");
	}

	if (!isJsonString(to) || to.length === 0) {
		throw new Error("workspace edge to must be a non-empty string");
	}

	const fromClass = classifyPackage(from);
	const toClass = classifyPackage(to);

	if (fromClass.kind === "unknown" && isWorkspacePath(from)) {
		throw new Error(`unknown import source ${from}`);
	}

	if (toClass.kind === "unknown" && isWorkspacePath(to)) {
		throw new Error(`unknown import target ${to}`);
	}

	const dev = record.dev;
	if (dev !== undefined && !isJsonBoolean(dev)) {
		throw new Error("workspace edge dev must be a boolean when present");
	}

	return dev === undefined ? { from, to } : { from, to, dev };
}

/**
 * Collapse the edges discovered for one workspace pair into the single edge the
 * rules should judge, taking the *strictest* provenance of the inputs.
 *
 * The `dev` marker exempts an edge from the layering rules, so whether a
 * package can reach the test harness turns entirely on which of two discoveries
 * of the same pair survives deduplication. That was previously decided by
 * position: `check-package-boundaries.mts` built a `Map` keyed on
 * `from->to` and let the later write win, and the declared-dependency scan
 * happened to run before the source scan.
 *
 * Measured, on the exact case the exemption was written for — a package that
 * declares `@hobo/contract-harness` under `devDependencies` *and* imports it
 * from `src/`:
 *
 *   declared-then-source: edge {from,to}          -> "adapters may import only core ports"
 *   source-then-declared: edge {from,to,dev:true} -> []
 *
 * Both orders are one line apart in the same array literal. The rule that
 * matters is not "the source scan runs second", it is "a runtime import is a
 * runtime edge no matter what else also declares it", and stating it here means
 * reordering the collection cannot quietly re-open the hole.
 */
export function mergeWorkspaceEdges(
	edges: readonly WorkspaceEdge[],
): WorkspaceEdge[] {
	const merged = new Map<string, WorkspaceEdge>();

	for (const edge of edges) {
		const key = `${edge.from}->${edge.to}`;
		const existing = merged.get(key);
		// Dev-only is a claim about *every* discovery of the pair. One runtime
		// sighting is enough to withdraw it, in either order.
		const dev =
			existing === undefined
				? (edge.dev ?? false)
				: (existing.dev ?? false) && (edge.dev ?? false);
		merged.set(
			key,
			dev
				? { from: edge.from, to: edge.to, dev: true }
				: { from: edge.from, to: edge.to },
		);
	}

	return [...merged.values()];
}

export function classifyPackage(path: string): PackageClassification {
	if (!path.startsWith("packages/") && !path.startsWith("examples/")) {
		return { kind: "external", layer: 0 };
	}

	if (path === "packages/core") {
		return { kind: "core", layer: 0 };
	}

	if (TEST_HARNESS_PATHS.has(path)) {
		return { kind: "package", layer: 0 };
	}

	if (CONTRACT_PACKAGE_PATHS.has(path)) {
		return { kind: "contract", layer: 1 };
	}

	if (ADAPTER_TIER_PREFIXES.some((prefix) => path.startsWith(prefix))) {
		return { kind: "adapter", layer: 2 };
	}

	if (KNOWN_PACKAGE_PATHS.has(path)) {
		return { kind: "package", layer: path.startsWith("examples/") ? 4 : 3 };
	}

	if (path.startsWith("examples/")) {
		return { kind: "package", layer: 4 };
	}

	return { kind: "unknown", layer: Number.POSITIVE_INFINITY };
}

/**
 * Record one refusal: the line for stderr and the record for the event, made
 * together so neither can exist without the other.
 */
function refuse(
	issues: WorkspaceIssues,
	rule: BoundaryRule,
	message: string,
	from_path: string,
	to_path: string,
): void {
	issues.errors.push(message);
	issues.violations.push({ rule, from_path, to_path, effect: "deny" });
}

/** Refuse an edge: `<sentence>: <from> -> <to>`. */
function refuseEdge(
	issues: WorkspaceIssues,
	rule: BoundaryRule,
	sentence: string,
	edge: WorkspaceEdge,
): void {
	refuse(
		issues,
		rule,
		`${sentence}: ${edge.from} -> ${edge.to}`,
		edge.from,
		edge.to,
	);
}

export function validateBoundaryImports(
	edges: readonly WorkspaceEdge[],
	extra: readonly WorkspaceEdge[] = [],
): WorkspaceIssues {
	const issues: WorkspaceIssues = { errors: [], violations: [] };
	const imports = [...edges, ...extra];

	for (const edge of imports) {
		const from = classifyPackage(edge.from);
		const to = classifyPackage(edge.to);

		if (from.kind === "unknown") {
			refuse(
				issues,
				"unknown-package",
				`unknown import source ${edge.from}`,
				edge.from,
				edge.from,
			);
			continue;
		}

		if (to.kind === "unknown") {
			refuse(
				issues,
				"unknown-package",
				`unknown import target ${edge.to}`,
				edge.to,
				edge.to,
			);
			continue;
		}

		// The engine rules judge runtime edges only: a test may import a real
		// engine or driver to exercise a live lane. "Runtime" is anything not
		// marked `dev`, and `mergeWorkspaceEdges` withdraws that marker on the
		// first sighting under `src/`, so listing the dependency under
		// `devDependencies` does not make a source import test-only.
		const runtime = edge.dev !== true;

		if (runtime && ENGINE_NEUTRAL_ORCHESTRATORS.has(edge.from)) {
			if (isDataEnginePackage(edge.to)) {
				refuseEdge(
					issues,
					"orchestrator-imports-engine",
					"orchestrators must not import a data engine at runtime",
					edge,
				);
			}
			if (isEngineSpecificStorage(edge.to)) {
				refuseEdge(
					issues,
					"orchestrator-imports-engine-storage",
					"orchestrators must not import a database driver or engine-specific storage at runtime",
					edge,
				);
			}
		}

		// Engines meet only through `@hobo/data-core`. They all sit on layer 1,
		// so no layering rule ever stood between two of them.
		if (
			runtime &&
			edge.from !== edge.to &&
			isDataEnginePackage(edge.from) &&
			isDataEnginePackage(edge.to)
		) {
			refuseEdge(
				issues,
				"engine-imports-engine",
				"data engines must not import each other at runtime",
				edge,
			);
		}

		if (from.kind === "core" && to.kind !== "external") {
			if (isDevOnlyTestHarnessEdge(edge)) {
				continue;
			}
			refuseEdge(
				issues,
				"core-imports-hobo",
				"core must not import HoBo packages",
				edge,
			);
		}

		if (
			from.kind === "adapter" &&
			to.kind === "adapter" &&
			edge.from !== edge.to &&
			!isAcceptedAdapterPackageEdge(edge.from, edge.to)
		) {
			refuseEdge(
				issues,
				"adapter-imports-adapter",
				"adapters must not import each other",
				edge,
			);
		}

		if (
			from.kind === "adapter" &&
			to.kind !== "core" &&
			// Layer-1 contract packages are implementable vocabulary, like WIT
			// worlds: an adapter declaring the capability profiles it implements
			// or emitting a portable binding is depending on a contract, not on
			// another implementation.
			to.kind !== "contract" &&
			// A module outside the workspace is not a HoBo layering edge. None
			// reached this rule until the scanner began reporting database
			// drivers as edges; an adapter importing the driver it adapts is
			// the adapter's job, and only the engine rules above read it.
			to.kind !== "external" &&
			edge.from !== edge.to &&
			edge.to !== "packages/conformance" &&
			!isDevOnlyTestHarnessEdge(edge) &&
			!isAcceptedAdapterPackageEdge(edge.from, edge.to)
		) {
			refuseEdge(
				issues,
				"adapter-imports-non-core",
				"adapters may import only core ports",
				edge,
			);
		}

		if (
			to.layer > from.layer &&
			edge.to !== "packages/conformance" &&
			!isAcceptedAdapterPackageEdge(edge.from, edge.to)
		) {
			refuseEdge(
				issues,
				"outward-dependency",
				"dependency points outward",
				edge,
			);
		}
	}

	return issues;
}

export interface WorkspaceIssues {
	/** One line per refusal, as the gate prints it on stderr. */
	errors: string[];
	/**
	 * The same refusals as records, one per line of `errors` and in the same
	 * order, each under the rule that refused it.
	 */
	violations: BoundaryViolation[];
}

export function detectWorkspaceCycles(
	edges: readonly WorkspaceEdge[],
): WorkspaceIssues {
	const graph = new Map<string, string[]>();
	const issues: WorkspaceIssues = { errors: [], violations: [] };

	for (const { from, to } of edges) {
		const next = graph.get(from) ?? [];
		next.push(to);
		graph.set(from, next);
	}

	const visiting = new Set<string>();
	const visited = new Set<string>();

	const visit = (node: string, trail: string[]): void => {
		if (visiting.has(node)) {
			const cycle = trail.slice(trail.indexOf(node));
			// The record names the edge that closes the cycle: the last package
			// on the trail, importing the one the trail started from.
			refuse(
				issues,
				"workspace-cycle",
				`workspace dependency cycle: ${cycle.join(" -> ")}`,
				cycle[cycle.length - 2] ?? node,
				node,
			);
			return;
		}

		if (visited.has(node)) {
			return;
		}

		visiting.add(node);
		for (const next of graph.get(node) ?? []) {
			visit(next, [...trail, next]);
		}
		visiting.delete(node);
		visited.add(node);
	};

	for (const node of graph.keys()) {
		visit(node, [node]);
	}

	return issues;
}

export const canonicalWorkspaceEdges: readonly WorkspaceEdge[] = [
	// Dev-only: core declares the harness under devDependencies for its own
	// PACT suites. The marker is what the layering rule keys on.
	{ from: "packages/core", to: "packages/contract-harness", dev: true },
	{ from: "packages/bindles", to: "packages/core" },
	{ from: "packages/bindles", to: "packages/wit" },
	{ from: "packages/camps", to: "packages/bindles" },
	{ from: "packages/camps", to: "packages/core" },
	{ from: "packages/yards", to: "packages/camps" },
	{ from: "packages/junctions", to: "packages/yards" },
	{ from: "packages/runtime", to: "packages/core" },
	{ from: "packages/cli", to: "packages/core" },
	{ from: "packages/cli", to: "packages/runtime" },
	{ from: "packages/componentize", to: "packages/core" },
	{ from: "packages/conformance", to: "packages/core" },
	{ from: "packages/stage-gate", to: "packages/componentize" },
	{ from: "packages/runtimes/runtime-local", to: "packages/conformance" },
	{ from: "packages/data", to: "packages/core" },
	{ from: "packages/events", to: "packages/core" },
	{ from: "packages/events", to: "packages/data" },
	{ from: "packages/identity", to: "packages/core" },
	{ from: "packages/cloud", to: "packages/core" },
	{ from: "packages/cloud", to: "packages/bindles" },
	{ from: "packages/cloud", to: "packages/data" },
	{ from: "packages/cloud", to: "packages/events" },
	{ from: "packages/contracts", to: "packages/core" },
	{ from: "packages/contracts", to: "packages/policy" },
	{ from: "packages/mcp", to: "packages/core" },
	{ from: "packages/mcp", to: "packages/cli" },
	{ from: "packages/mcp", to: "packages/identity" },
	{ from: "packages/conformance", to: "packages/runtime" },
	{ from: "packages/training-pipeline", to: "packages/core" },
	{ from: "packages/iac/iac-pulumi", to: "packages/core" },
	{ from: "packages/providers/provider-cloudflare", to: "packages/core" },
	// @hobo/hobo — the composition root (apps, L3). It composes the L3 sdk/runtime
	// packages and the L2 adapters; every edge is inward or same-layer, so no
	// exception is required.
	{ from: "packages/hobo", to: "packages/cli" },
	{ from: "packages/hobo", to: "packages/cloud" },
	{ from: "packages/hobo", to: "packages/contracts" },
	{ from: "packages/hobo", to: "packages/bindles" },
	{ from: "packages/hobo", to: "packages/core" },
	{ from: "packages/hobo", to: "packages/data" },
	{ from: "packages/hobo", to: "packages/runtimes/runtime-local" },
	{ from: "packages/hobo", to: "packages/providers/provider-cloudflare" },
	{ from: "packages/hobo", to: "packages/iac/iac-pulumi" },
	{ from: "packages/providers/provider-agentv", to: "packages/core" },
	{ from: "packages/providers/provider-ax", to: "packages/core" },
	// Accepted training/eval-provider composition edges (see ACCEPTED_ADAPTER_PACKAGE_EDGES).
	{
		from: "packages/providers/provider-agentv",
		to: "packages/training-pipeline",
	},
	{ from: "packages/providers/provider-ax", to: "packages/runtime" },
];
