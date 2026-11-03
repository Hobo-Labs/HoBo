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
	"packages/wit",
	"packages/capability-profiles",
	"packages/bindings",
	"packages/claims",
	"packages/trust",
	"packages/data-postgres",
	"packages/kv-redis-compatible",
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
	"packages/ci-ado",
	"packages/ci-dagger",
	"packages/ci-cf",
	"packages/ci-vercel",
	"packages/core",
	"packages/contract-harness",
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
]);

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
 * Still deliberately narrow: only this one package, and only when the edge is
 * dev-only. A runtime dependency on the harness is a real layering break and
 * keeps failing.
 */
function isDevOnlyTestHarnessEdge(edge: WorkspaceEdge): boolean {
	return edge.dev === true && edge.to === "packages/contract-harness";
}

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

	if (path === "packages/contract-harness") {
		return { kind: "package", layer: 0 };
	}

	if (CONTRACT_PACKAGE_PATHS.has(path)) {
		return { kind: "contract", layer: 1 };
	}

	if (
		path.startsWith("packages/providers/") ||
		path.startsWith("packages/iac/") ||
		path.startsWith("packages/build/") ||
		path.startsWith("packages/runtimes/") ||
		path.startsWith("packages/connectors/") ||
		path.startsWith("packages/adapters/") ||
		// ADR-0151 implementation packs are signed deployables that satisfy a
		// capability profile on generic compute. They sit at the adapter tier
		// for the same reason providers do: they implement a core contract and
		// must not reach sideways into layer-3 packages.
		path.startsWith("packages/packs/")
	) {
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

export function validateBoundaryImports(
	edges: readonly WorkspaceEdge[],
	extra: readonly WorkspaceEdge[] = [],
): WorkspaceIssues {
	const errors: string[] = [];
	const imports = [...edges, ...extra];

	for (const edge of imports) {
		const from = classifyPackage(edge.from);
		const to = classifyPackage(edge.to);

		if (from.kind === "unknown") {
			errors.push(`unknown import source ${edge.from}`);
			continue;
		}

		if (to.kind === "unknown") {
			errors.push(`unknown import target ${edge.to}`);
			continue;
		}

		if (from.kind === "core" && to.kind !== "external") {
			if (isDevOnlyTestHarnessEdge(edge)) {
				continue;
			}
			errors.push(
				`core must not import HoBo packages: ${edge.from} -> ${edge.to}`,
			);
		}

		if (
			from.kind === "adapter" &&
			to.kind === "adapter" &&
			edge.from !== edge.to &&
			!isAcceptedAdapterPackageEdge(edge.from, edge.to)
		) {
			errors.push(
				`adapters must not import each other: ${edge.from} -> ${edge.to}`,
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
			edge.from !== edge.to &&
			edge.to !== "packages/conformance" &&
			!isDevOnlyTestHarnessEdge(edge) &&
			!isAcceptedAdapterPackageEdge(edge.from, edge.to)
		) {
			errors.push(
				`adapters may import only core ports: ${edge.from} -> ${edge.to}`,
			);
		}

		if (
			to.layer > from.layer &&
			edge.to !== "packages/conformance" &&
			!isAcceptedAdapterPackageEdge(edge.from, edge.to)
		) {
			errors.push(`dependency points outward: ${edge.from} -> ${edge.to}`);
		}
	}

	return { errors };
}

export interface WorkspaceIssues {
	errors: string[];
}

export function detectWorkspaceCycles(
	edges: readonly WorkspaceEdge[],
): WorkspaceIssues {
	const graph = new Map<string, string[]>();
	const errors: string[] = [];

	for (const { from, to } of edges) {
		const next = graph.get(from) ?? [];
		next.push(to);
		graph.set(from, next);
	}

	const visiting = new Set<string>();
	const visited = new Set<string>();

	const visit = (node: string, trail: string[]): void => {
		if (visiting.has(node)) {
			const cycle = trail.slice(trail.indexOf(node)).join(" -> ");
			errors.push(`workspace dependency cycle: ${cycle}`);
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

	return { errors };
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
	{ from: "packages/ci", to: "packages/pricing" },
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
