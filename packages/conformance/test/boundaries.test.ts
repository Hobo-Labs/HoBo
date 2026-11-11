import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	BOUNDARY_RULES,
	type BoundaryRule,
	canonicalWorkspaceEdges,
	classifyPackage,
	databaseDriverOf,
	detectWorkspaceCycles,
	isDataEnginePackage,
	mergeWorkspaceEdges,
	parseWorkspaceEdge,
	validateBoundaryImports,
	type WorkspaceEdge,
} from "../src/boundaries.js";

describe("validateBoundaryImports", () => {
	it("accepts the canonical production workspace edge set", () => {
		const edges = canonicalWorkspaceEdges.map((edge) =>
			parseWorkspaceEdge(edge),
		);
		const result = validateBoundaryImports(edges);

		expect(result.errors).toEqual([]);
	});

	it("denies cross-adapter imports", () => {
		const edges = canonicalWorkspaceEdges.map((edge) =>
			parseWorkspaceEdge(edge),
		);
		const result = validateBoundaryImports(edges, [
			parseWorkspaceEdge({
				from: "packages/providers/provider-aws",
				to: "packages/providers/provider-azure",
			}),
		]);

		expect(result.errors.join("\n")).toMatch(
			/adapters must not import each other/,
		);
	});
});

describe("detectWorkspaceCycles", () => {
	it("rejects cli/runtime circular dependencies", () => {
		const result = detectWorkspaceCycles([
			parseWorkspaceEdge({ from: "packages/cli", to: "packages/runtime" }),
			parseWorkspaceEdge({ from: "packages/runtime", to: "packages/cli" }),
		]);

		expect(result.errors).toEqual([
			"workspace dependency cycle: packages/cli -> packages/runtime -> packages/cli",
		]);
	});
});

describe("workspace-skeleton-boundary pact", () => {
	const pactPath = join(
		dirname(fileURLToPath(import.meta.url)),
		"../contracts/pacts/workspace-skeleton-boundary.pact.json",
	);
	// SAFETY: assertion to `JSON.parse(readFileSync(pactPath, "utf8")) as { consumer: { name: string }; provider: { name: string }; interactions: Ar` is required at this boundary.
	const pact = JSON.parse(readFileSync(pactPath, "utf8")) as {
		consumer: { name: string };
		provider: { name: string };
		interactions: Array<{
			response: { body: { boundaryViolation: { effect: string } } };
		}>;
		metadata: { pactSpecification: { version: string } };
	};

	it("pins consumer and provider names", () => {
		expect(pact.consumer.name).toBe("FoundationsReferenceApp");
		expect(pact.provider.name).toBe("WorkspaceSkeletonBoundary");
		expect(pact.metadata.pactSpecification.version).toBe("3.0.0");
	});

	it("promises deny effect for boundary violations", () => {
		const interaction = pact.interactions[0];
		expect(interaction?.response.body.boundaryViolation.effect).toBe("deny");
	});

	it("enforces deny behavior for adapter cross-import fixture", () => {
		const result = validateBoundaryImports(
			[],
			[
				parseWorkspaceEdge({
					from: "packages/providers/provider-aws",
					to: "packages/providers/provider-azure",
				}),
			],
		);

		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors.join("\n")).toMatch(
			/adapters must not import each other/,
		);
	});
});

/**
 * Regression cover for a gate that was enforcing nothing.
 *
 * `parseWorkspaceEdge` *throws* on a workspace path it cannot classify. That is
 * a defensible parse-don't-validate contract, but it meant a single stray
 * `package.json` anywhere under `packages/` aborted the whole run — and an
 * aborted gate is indistinguishable from a clean one in a pipeline that only
 * checks the exit code of the surrounding script. On trunk, fifteen real
 * packages plus eight nested non-packages were unclassified, so the boundary
 * gate had never actually enforced a rule.
 */
describe("every workspace package is classifiable", () => {
	it("classifies each pnpm workspace package under packages/", async () => {
		const { readFileSync, readdirSync, statSync } = await import("node:fs");
		const { join } = await import("node:path");
		const root = new URL("../../..", import.meta.url).pathname;

		const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
		const globs = yaml
			.split("\n")
			.slice(yaml.split("\n").findIndex((l) => l.startsWith("packages:")) + 1)
			.reduce<string[]>((acc, line) => {
				if (/^\S/u.test(line)) return acc;
				const m = /^\s+-\s+"?([^"\s]+)"?\s*$/u.exec(line);
				if (m?.[1]?.startsWith("packages/")) acc.push(m[1]);
				return acc;
			}, []);

		const unclassified: string[] = [];
		for (const glob of globs) {
			const base = join(root, glob.replace(/\/\*$/u, ""));
			let names: string[] = [];
			try {
				names = glob.endsWith("/*") ? readdirSync(base) : [""];
			} catch {
				continue;
			}
			for (const name of names) {
				const dir = name ? join(base, name) : base;
				try {
					if (!statSync(join(dir, "package.json")).isFile()) continue;
				} catch {
					continue;
				}
				const rel = dir.slice(root.length).replace(/^\/+/u, "");
				if (classifyPackage(rel).kind === "unknown") unclassified.push(rel);
			}
		}

		// Naming them is the point: a bare count tells whoever added a package
		// nothing about which one, and this failing is the moment they find out.
		expect(unclassified).toEqual([]);
	});

	it("still refuses a path it genuinely cannot place", () => {
		// The throw is load-bearing — it must not be softened into a default
		// layer, or an unplaced package would silently get whatever layer the
		// default happened to be and import anything below it.
		expect(() =>
			parseWorkspaceEdge({
				from: "packages/not-a-real-package",
				to: "packages/core",
			}),
		).toThrow(/unknown import source/u);
	});
});

/**
 * C1 — the tripwire the banked-list reduction was accused of removing.
 *
 * `ACCEPTED_ADAPTER_PACKAGE_EDGES` went from 31 entries to 14. The seventeen
 * that went all named a target `CONTRACT_PACKAGE_PATHS` classifies as
 * `contract`, which the adapter rule exempts outright, so no verdict changed.
 *
 * The adversarial reading was that they were also documentation and a second
 * line of defence: reclassify one package and seventeen provider edges become
 * violations at once, with nothing on record saying they were ever considered
 * fine.
 *
 * Half of that is right and half of it is backwards, and the half that is
 * backwards decides what to do about it. Measured, by removing
 * `packages/bindings` from `CONTRACT_PACKAGE_PATHS` and running the real
 * workspace graph through `validateBoundaryImports` twice:
 *
 *   with the seventeen deleted (today):  18 bindings violations
 *   with the seventeen restored:          6 bindings violations
 *
 * The allowlist does not warn about a reclassification, it *absorbs* one. Each
 * restored entry names an exact edge and exempts it from both the adapter rule
 * and the outward rule, so twelve of the eighteen go quiet — the six that
 * survive are the `packages/packs/*` reaches, which were never on the list.
 * Restoring the entries would buy a partial silence, not a second line of
 * defence.
 *
 * Two inherited claims also need correcting. "Seventeen provider edges become
 * violations at once" describes no single edit: the seventeen span four
 * targets, and reclassifying any one of them surfaces only its own share (six
 * edges for `bindings`). And the surviving concern is not safety but
 * diagnosability — loud violations with no written record of why the edges were
 * ever acceptable.
 *
 * So this pins the *reason* rather than restoring the list. Each edge below is
 * asserted permitted, and asserted permitted *because its target is contract
 * vocabulary*. Reclassify a package and this fails by name, naming the edge and
 * carrying the explanation, before anyone reaches the anonymous rule violations
 * elsewhere.
 */
describe("banked edges retired into the contract-kind exemption", () => {
	// Recovered from ed1061ca (the 18 deleted lines, one of which duplicated an
	// entry that survives in the list today).
	const RETIRED_BANKED_EDGES = [
		["packages/providers/provider-cloudflare", "packages/bindings"],
		["packages/providers/provider-cloudflare", "packages/capability-profiles"],
		["packages/providers/provider-neon", "packages/bindings"],
		["packages/providers/provider-neon", "packages/capability-profiles"],
		["packages/providers/provider-netlify", "packages/bindings"],
		["packages/providers/provider-netlify", "packages/capability-profiles"],
		["packages/providers/provider-netlify", "packages/claims"],
		["packages/providers/provider-prisma-postgres", "packages/bindings"],
		[
			"packages/providers/provider-prisma-postgres",
			"packages/capability-profiles",
		],
		["packages/providers/provider-ttl-sh", "packages/capability-profiles"],
		["packages/providers/provider-ttl-sh", "packages/claims"],
		["packages/providers/provider-upstash", "packages/bindings"],
		["packages/providers/provider-upstash", "packages/capability-profiles"],
		["packages/providers/provider-upstash", "packages/kv-redis-compatible"],
		["packages/providers/provider-vercel", "packages/bindings"],
		["packages/providers/provider-vercel", "packages/capability-profiles"],
		["packages/providers/provider-vercel", "packages/claims"],
	] as const;

	it("covers every entry the reduction deleted", () => {
		expect(RETIRED_BANKED_EDGES).toHaveLength(17);
	});

	it.each(
		RETIRED_BANKED_EDGES,
	)("%s -> %s is permitted because the target is contract vocabulary", (from, to) => {
		// The load-bearing half. If this flips, the edge is still "permitted"
		// only until someone notices — say why it is permitted, here.
		expect(
			`${to} classified as ${classifyPackage(to).kind}`,
			`${to} left CONTRACT_PACKAGE_PATHS. ${from} imports it, and that import was banked as acceptable pre-existing debt until the contract-kind exemption superseded the allowlist entry. Restore the classification, or restore "${from}->${to}" to ACCEPTED_ADAPTER_PACKAGE_EDGES with a written reason.`,
		).toBe(`${to} classified as contract`);

		expect(
			validateBoundaryImports([parseWorkspaceEdge({ from, to })]).errors,
		).toEqual([]);
	});
});

/**
 * The secrets-port implementers.
 *
 * `SecretsPort` is a residual port whose vocabulary lives in `@hobo/identity`
 * rather than in core (ADR-0113), so an adapter that implements it must import
 * identity. Each such adapter is allowed that one edge by name, for that reason,
 * and nothing else: not another adapter, not a runtime, not identity's
 * neighbours. A third implementer adds its own line and its own case here.
 */
describe("secrets-port implementers may import the port vocabulary and nothing else", () => {
	const IDENTITY = "packages/identity";

	it.each([
		"packages/adapters/adapter-openbao",
		"packages/adapters/adapter-opensesame",
		"packages/adapters/adapter-infisical",
	])("%s -> @hobo/identity is permitted", (from) => {
		expect(
			validateBoundaryImports([parseWorkspaceEdge({ from, to: IDENTITY })])
				.errors,
		).toEqual([]);
	});

	it("the OpenSesame adapter may use the contract vocabulary it parses secret references with", () => {
		expect(
			validateBoundaryImports([
				parseWorkspaceEdge({
					from: "packages/adapters/adapter-opensesame",
					to: "packages/bindings",
				}),
			]).errors,
		).toEqual([]);
	});

	it("the OpenSesame adapter may reach the test harness only as a dev dependency", () => {
		const from = "packages/adapters/adapter-opensesame";
		const to = "packages/contract-harness";
		expect(
			validateBoundaryImports([parseWorkspaceEdge({ from, to, dev: true })])
				.errors,
		).toEqual([]);
		expect(
			validateBoundaryImports([parseWorkspaceEdge({ from, to })]).errors,
		).not.toEqual([]);
	});

	it.each([
		[
			"packages/adapters/adapter-opensesame",
			"packages/adapters/adapter-openbao",
		],
		["packages/adapters/adapter-opensesame", "packages/runtimes/runtime-local"],
		["packages/adapters/adapter-opensesame", "packages/hobo"],
		[
			"packages/adapters/adapter-opensesame",
			"packages/providers/provider-vercel",
		],
		["packages/adapters/adapter-infisical", "packages/ci-vercel"],
		["packages/adapters/adapter-infisical", "packages/hobo"],
		[
			"packages/adapters/adapter-infisical",
			"packages/adapters/adapter-openbao",
		],
	])("%s -> %s is still refused", (from, to) => {
		expect(
			validateBoundaryImports([parseWorkspaceEdge({ from, to })]).errors,
		).not.toEqual([]);
	});
});

/**
 * C2 — the dev-marker hole, and why it was only closed by accident.
 *
 * `isDevOnlyTestHarnessEdge` exempts an edge from the layering rules on the
 * strength of `edge.dev`. The case nobody had tested: a package that declares
 * `@hobo/contract-harness` under `devDependencies` *and* imports it from
 * `src/`. The declared-dependency collector marks that edge dev; the source
 * scanner, which walks `src/` only and knows nothing about manifests, reports
 * the same pair unmarked.
 *
 * Measured before changing anything: the guard did refuse it — but only because
 * `check-package-boundaries.mts` deduplicated with a bare `Map.set` keyed on
 * `from->to` and the source scan happened to be spread in second. Reversing two
 * lines in one array literal produced `[]`. That is not a property, it is a
 * coincidence, and nothing tested it.
 */
describe("dev-only marker survives only a genuinely dev-only edge", () => {
	const from = "packages/runtimes/runtime-oci";
	const to = "packages/contract-harness";
	const declared = parseWorkspaceEdge({ from, to, dev: true });
	const imported = parseWorkspaceEdge({ from, to });

	it("keeps the marker when every sighting is dev-only", () => {
		expect(mergeWorkspaceEdges([declared, declared])).toEqual([
			{ from, to, dev: true },
		]);
		expect(validateBoundaryImports(mergeWorkspaceEdges([declared]))).toEqual({
			errors: [],
			violations: [],
		});
	});

	it.each([
		["declared-then-source", [declared, imported]],
		["source-then-declared", [imported, declared]],
	] as const)("withdraws the marker when src/ imports it too (%s)", (_order, edges) => {
		expect(mergeWorkspaceEdges(edges)).toEqual([{ from, to }]);
		expect(
			validateBoundaryImports(mergeWorkspaceEdges(edges)).errors,
		).toContain(
			"adapters may import only core ports: packages/runtimes/runtime-oci -> packages/contract-harness",
		);
	});
});

/**
 * C3 — the four manifest packages, pre-registered before they exist.
 *
 * Registering ahead of creation is deliberate: an unclassified workspace path
 * makes `parseWorkspaceEdge` throw, which aborts the gate before it evaluates a
 * rule, so the run that adds a package is the run with no enforcement.
 */
describe("manifest packages are pre-registered as contract vocabulary", () => {
	const MANIFEST_PACKAGES = [
		"packages/manifest-capability",
		"packages/manifest-request",
		"packages/manifest-declaration",
		"packages/manifest-plan",
	] as const;

	it.each(MANIFEST_PACKAGES)("%s classifies as a layer-1 contract", (path) => {
		expect(classifyPackage(path)).toEqual({ kind: "contract", layer: 1 });
	});

	it.each(
		MANIFEST_PACKAGES,
	)("%s is importable by the package that re-exports it and by adapters", (path) => {
		expect(
			validateBoundaryImports([
				parseWorkspaceEdge({ from: "packages/capability-profiles", to: path }),
				parseWorkspaceEdge({ from: "packages/cloud", to: path }),
				parseWorkspaceEdge({
					from: "packages/providers/provider-vercel",
					to: path,
				}),
			]).errors,
		).toEqual([]);
	});

	it.each(
		MANIFEST_PACKAGES,
	)("%s still fails closed if it grows a dependency past core", (path) => {
		expect(
			validateBoundaryImports([
				parseWorkspaceEdge({ from: path, to: "packages/cloud" }),
			]).errors,
		).toEqual([`dependency points outward: ${path} -> packages/cloud`]);
	});
});

/**
 * ADR-0177 — the data engine family. `data-core` is the engine-neutral
 * contract; each `data-<engine>` package implements it; and the runbook engine
 * must never import an engine at runtime.
 */
describe("data engine packages and the engine-neutral orchestrator rule", () => {
	const DATA_PACKAGES = [
		"packages/data-core",
		"packages/data-sqlite",
		"packages/data-postgres",
		"packages/data-mongodb",
	] as const;

	it.each(DATA_PACKAGES)("%s classifies as a layer-1 contract", (path) => {
		expect(classifyPackage(path)).toEqual({ kind: "contract", layer: 1 });
	});

	it("only data-<engine> packages are engines: not the contract, not the app kernel", () => {
		expect(isDataEnginePackage("packages/data-sqlite")).toBe(true);
		expect(isDataEnginePackage("packages/data-postgres")).toBe(true);
		expect(isDataEnginePackage("packages/data-mongodb")).toBe(true);
		expect(isDataEnginePackage("packages/data-core")).toBe(false);
		expect(isDataEnginePackage("packages/data")).toBe(false);
		expect(isDataEnginePackage("packages/storage-sqlite")).toBe(false);
	});

	// What the name rule matches is a decision, pinned here so it cannot drift
	// back into an accident. It used to be "anything under packages/data- that
	// is not exactly data-core", which made a companion of the contract an
	// engine and missed an engine filed under an adapter tier.
	it.each([
		// An engine that does not exist yet is covered the day it is created.
		["packages/data-mysql", true],
		["packages/data-cockroach-db", true],
		// Filed under an adapter tier, a data-<engine> package is still one.
		["packages/adapters/data-mysql", true],
		["packages/providers/data-dynamo", true],
		// The contract and every companion of it: `data-core-<anything>`.
		["packages/data-core", false],
		["packages/data-core-testing", false],
		["packages/data-core-kit", false],
		["packages/adapters/data-core-testing", false],
		// `core` has to be the whole word for the exclusion to apply.
		["packages/data-coredb", true],
		// Not package directories of the family at all.
		["packages/data", false],
		["packages/data-", false],
		["packages/data-sqlite/src", false],
		["packages/trails/data-models", false],
		["packages/code/examples/data-grid", false],
		["packages/adapters/nested/data-mysql", false],
		["packages/data-SQLite", false],
		["data-sqlite", false],
		["examples/data-sqlite", false],
		["node:sqlite", false],
	] as const)("isDataEnginePackage(%s) is %s", (path, expected) => {
		expect(isDataEnginePackage(path)).toBe(expected);
	});

	it("an engine imports the contract and core, and the contract imports only core", () => {
		expect(
			validateBoundaryImports([
				parseWorkspaceEdge({ from: "packages/data-core", to: "packages/core" }),
				parseWorkspaceEdge({
					from: "packages/data-sqlite",
					to: "packages/data-core",
				}),
				parseWorkspaceEdge({
					from: "packages/data-postgres",
					to: "packages/data-core",
				}),
				parseWorkspaceEdge({
					from: "packages/data-mongodb",
					to: "packages/data-core",
				}),
			]).errors,
		).toEqual([]);
		expect(
			validateBoundaryImports([
				parseWorkspaceEdge({ from: "packages/data-core", to: "packages/data" }),
			]).errors,
		).toEqual([
			"dependency points outward: packages/data-core -> packages/data",
		]);
	});

	it("the runbook engine may import the contract but never an engine at runtime", () => {
		expect(
			validateBoundaryImports([
				parseWorkspaceEdge({
					from: "packages/trails",
					to: "packages/data-core",
				}),
			]).errors,
		).toEqual([]);
		for (const engine of [
			"packages/data-sqlite",
			"packages/data-postgres",
			"packages/data-mongodb",
		]) {
			expect(
				validateBoundaryImports([
					parseWorkspaceEdge({ from: "packages/trails", to: engine }),
				]).errors,
			).toEqual([
				`orchestrators must not import a data engine at runtime: packages/trails -> ${engine}`,
			]);
		}
	});

	it("a test-only edge to an engine is allowed: live lanes need a real store", () => {
		expect(
			validateBoundaryImports([
				parseWorkspaceEdge({
					from: "packages/trails",
					to: "packages/data-sqlite",
					dev: true,
				}),
				parseWorkspaceEdge({
					from: "packages/data-postgres",
					to: "packages/data-sqlite",
					dev: true,
				}),
			]).errors,
		).toEqual([]);
	});

	it("an engine filed under an adapter tier is still out of the orchestrator's reach", () => {
		expect(
			validateBoundaryImports([
				parseWorkspaceEdge({
					from: "packages/trails",
					to: "packages/adapters/data-mysql",
				}),
			]).errors,
		).toEqual([
			"orchestrators must not import a data engine at runtime: packages/trails -> packages/adapters/data-mysql",
		]);
	});

	// A devDependency says where a package is *allowed* to import the engine
	// from, not where it does. One sighting under `src/` is a runtime edge, and
	// the scanner reports that sighting with no `dev` marker.
	it.each([
		["declared first", 0],
		["source first", 1],
	] as const)("a src/ sighting of a devDependency engine is a runtime edge (%s)", (_name, rotate) => {
		const sightings = [
			parseWorkspaceEdge({
				from: "packages/trails",
				to: "packages/data-sqlite",
				dev: true,
			}),
			parseWorkspaceEdge({
				from: "packages/trails",
				to: "packages/data-sqlite",
			}),
		];
		const ordered = [...sightings.slice(rotate), ...sightings.slice(0, rotate)];
		expect(
			validateBoundaryImports(mergeWorkspaceEdges(ordered)).errors,
		).toEqual([
			"orchestrators must not import a data engine at runtime: packages/trails -> packages/data-sqlite",
		]);
	});
});

/**
 * The defect ADR-0177 decision 3 removed was `node:sqlite` bindings living in
 * the runbook engine. The rule written to keep it out only knew `@hobo/*`
 * engine packages, so the original import — a builtin, not a workspace package
 * — was never an edge, and neither was the driver of any other engine or the
 * SQLite storage package.
 */
describe("orchestrators import no database driver and no engine-specific storage", () => {
	const FORBIDDEN = [
		"node:sqlite",
		"pg",
		"mongodb",
		"packages/storage-sqlite",
	] as const;

	it.each(FORBIDDEN)("packages/trails -> %s is refused at runtime", (to) => {
		expect(
			validateBoundaryImports([
				parseWorkspaceEdge({ from: "packages/trails", to }),
			]).errors,
		).toEqual([
			`orchestrators must not import a database driver or engine-specific storage at runtime: packages/trails -> ${to}`,
		]);
	});

	it.each(
		FORBIDDEN,
	)("packages/trails -> %s is allowed from tests only", (to) => {
		expect(
			validateBoundaryImports([
				parseWorkspaceEdge({ from: "packages/trails", to, dev: true }),
			]).errors,
		).toEqual([]);
	});

	it("a src/ sighting of a devDependency driver is a runtime edge", () => {
		expect(
			validateBoundaryImports(
				mergeWorkspaceEdges([
					parseWorkspaceEdge({ from: "packages/trails", to: "pg", dev: true }),
					parseWorkspaceEdge({ from: "packages/trails", to: "pg" }),
				]),
			).errors,
		).toEqual([
			"orchestrators must not import a database driver or engine-specific storage at runtime: packages/trails -> pg",
		]);
	});

	it("the packages whose job is a driver keep theirs", () => {
		expect(
			validateBoundaryImports([
				parseWorkspaceEdge({
					from: "packages/storage-sqlite",
					to: "node:sqlite",
				}),
				parseWorkspaceEdge({ from: "packages/data-sqlite", to: "node:sqlite" }),
				parseWorkspaceEdge({ from: "packages/data-postgres", to: "pg" }),
				parseWorkspaceEdge({ from: "packages/data-mongodb", to: "mongodb" }),
				parseWorkspaceEdge({ from: "packages/hobo", to: "node:sqlite" }),
				parseWorkspaceEdge({
					from: "packages/runtimes/runtime-local",
					to: "packages/storage-sqlite",
				}),
			]).errors,
		).toEqual([]);
	});

	it("a driver edge is judged by the engine rules only, not as a layering edge", () => {
		expect(
			validateBoundaryImports([
				parseWorkspaceEdge({
					from: "packages/runtimes/runtime-rivet",
					to: "node:sqlite",
				}),
				parseWorkspaceEdge({
					from: "packages/providers/provider-neon",
					to: "pg",
				}),
				parseWorkspaceEdge({ from: "packages/core", to: "node:sqlite" }),
			]).errors,
		).toEqual([]);
	});

	it("names the driver a module specifier belongs to, subpaths included", () => {
		expect(databaseDriverOf("node:sqlite")).toBe("node:sqlite");
		expect(databaseDriverOf("pg")).toBe("pg");
		expect(databaseDriverOf("pg/lib/native")).toBe("pg");
		expect(databaseDriverOf("mongodb")).toBe("mongodb");
		expect(databaseDriverOf("mongodb/lib/bson")).toBe("mongodb");
		expect(databaseDriverOf("better-sqlite3")).toBe("better-sqlite3");
	});

	it("does not mistake a neighbouring name for a driver", () => {
		for (const specifier of [
			"pgvector",
			"pg-connection-string",
			"mongodb-connection-string-url",
			"node:sqlite3",
			"node:fs",
			"sqlite",
			"@hobo/storage-sqlite",
			"@hobo/data-core",
			"./pg",
			"",
		]) {
			expect(databaseDriverOf(specifier)).toBeUndefined();
		}
	});
});

/**
 * Engines are layer-1 contract packages, so the layering rules never stood
 * between two of them: `data-sqlite -> data-postgres` passed. The registration
 * comment said each engine "imports only" the contract; nothing enforced it.
 */
describe("data engines meet only through the contract", () => {
	it("an engine importing another engine at runtime is refused", () => {
		expect(
			validateBoundaryImports([
				parseWorkspaceEdge({
					from: "packages/data-sqlite",
					to: "packages/data-postgres",
				}),
				parseWorkspaceEdge({
					from: "packages/data-mongodb",
					to: "packages/data-sqlite",
				}),
			]).errors,
		).toEqual([
			"data engines must not import each other at runtime: packages/data-sqlite -> packages/data-postgres",
			"data engines must not import each other at runtime: packages/data-mongodb -> packages/data-sqlite",
		]);
	});

	it("a test-only edge between engines stays allowed", () => {
		expect(
			validateBoundaryImports([
				parseWorkspaceEdge({
					from: "packages/data-postgres",
					to: "packages/data-sqlite",
					dev: true,
				}),
			]).errors,
		).toEqual([]);
	});

	it("a src/ sighting withdraws the test-only claim between engines too", () => {
		expect(
			validateBoundaryImports(
				mergeWorkspaceEdges([
					parseWorkspaceEdge({
						from: "packages/data-postgres",
						to: "packages/data-sqlite",
					}),
					parseWorkspaceEdge({
						from: "packages/data-postgres",
						to: "packages/data-sqlite",
						dev: true,
					}),
				]),
			).errors,
		).toEqual([
			"data engines must not import each other at runtime: packages/data-postgres -> packages/data-sqlite",
		]);
	});

	it("the contract, core, and an engine's own name are not another engine", () => {
		expect(
			validateBoundaryImports([
				parseWorkspaceEdge({
					from: "packages/data-sqlite",
					to: "packages/data-core",
				}),
				parseWorkspaceEdge({
					from: "packages/data-sqlite",
					to: "packages/core",
				}),
				parseWorkspaceEdge({
					from: "packages/data-sqlite",
					to: "packages/data-sqlite",
				}),
			]).errors,
		).toEqual([]);
	});
});

/**
 * The gate's machine-readable event lists its refusals under a rule name. The
 * names were matched from the printed text by the script that built the event,
 * and it knew six of them: every engine-neutrality refusal was printed on
 * stderr, failed the gate, and was absent from `violations`. A refusal is now
 * raised with its rule, so the line and the record cannot come apart.
 */
describe("every refusal is a record under the rule that raised it", () => {
	const deny = (rule: BoundaryRule, from_path: string, to_path: string) => ({
		rule,
		from_path,
		to_path,
		effect: "deny",
	});

	it("an orchestrator importing an engine, a driver or engine-specific storage is recorded under its own rule", () => {
		const result = validateBoundaryImports([
			parseWorkspaceEdge({
				from: "packages/trails",
				to: "packages/data-sqlite",
			}),
			parseWorkspaceEdge({ from: "packages/trails", to: "node:sqlite" }),
			parseWorkspaceEdge({
				from: "packages/trails",
				to: "packages/storage-sqlite",
			}),
		]);

		expect(result.errors).toEqual([
			"orchestrators must not import a data engine at runtime: packages/trails -> packages/data-sqlite",
			"orchestrators must not import a database driver or engine-specific storage at runtime: packages/trails -> node:sqlite",
			"orchestrators must not import a database driver or engine-specific storage at runtime: packages/trails -> packages/storage-sqlite",
		]);
		expect(result.violations).toEqual([
			deny(
				"orchestrator-imports-engine",
				"packages/trails",
				"packages/data-sqlite",
			),
			deny(
				"orchestrator-imports-engine-storage",
				"packages/trails",
				"node:sqlite",
			),
			deny(
				"orchestrator-imports-engine-storage",
				"packages/trails",
				"packages/storage-sqlite",
			),
		]);
	});

	it("an engine importing another engine is recorded under its own rule", () => {
		const result = validateBoundaryImports([
			parseWorkspaceEdge({
				from: "packages/data-postgres",
				to: "packages/data-sqlite",
			}),
		]);

		expect(result.violations).toEqual([
			deny(
				"engine-imports-engine",
				"packages/data-postgres",
				"packages/data-sqlite",
			),
		]);
	});

	it("a test-only edge is allowed: no line and no record", () => {
		const result = validateBoundaryImports([
			parseWorkspaceEdge({
				from: "packages/trails",
				to: "packages/data-sqlite",
				dev: true,
			}),
			parseWorkspaceEdge({ from: "packages/trails", to: "pg", dev: true }),
			parseWorkspaceEdge({
				from: "packages/data-postgres",
				to: "packages/data-sqlite",
				dev: true,
			}),
		]);

		expect(result).toEqual({ errors: [], violations: [] });
	});

	it("a cycle is recorded as the edge that closes it, never with an empty path", () => {
		const result = detectWorkspaceCycles([
			parseWorkspaceEdge({ from: "packages/cli", to: "packages/runtime" }),
			parseWorkspaceEdge({ from: "packages/runtime", to: "packages/mcp" }),
			parseWorkspaceEdge({ from: "packages/mcp", to: "packages/cli" }),
		]);

		expect(result.errors).toEqual([
			"workspace dependency cycle: packages/cli -> packages/runtime -> packages/mcp -> packages/cli",
		]);
		expect(result.violations).toEqual([
			deny("workspace-cycle", "packages/mcp", "packages/cli"),
		]);
	});

	it("every rule can be raised, and each line printed has exactly one record", () => {
		// `parseWorkspaceEdge` refuses a path nobody classified; the rule that
		// reports one is reached by an edge that was never parsed.
		const unclassified: WorkspaceEdge = {
			from: "packages/not-a-package",
			to: "packages/core",
		};
		const edges = [
			unclassified,
			...[
				["packages/core", "packages/cli"],
				[
					"packages/providers/provider-aws",
					"packages/providers/provider-azure",
				],
				["packages/trails", "packages/data-mongodb"],
				["packages/trails", "mongodb"],
				["packages/data-mongodb", "packages/data-postgres"],
				["packages/cli", "packages/runtime"],
				["packages/runtime", "packages/cli"],
			].map(([from, to]) => parseWorkspaceEdge({ from, to })),
		];
		const boundary = validateBoundaryImports(edges);
		const cycles = detectWorkspaceCycles(edges);
		const errors = [...boundary.errors, ...cycles.errors];
		const violations = [...boundary.violations, ...cycles.violations];

		expect(violations).toHaveLength(errors.length);
		expect(new Set(violations.map((violation) => violation.rule))).toEqual(
			new Set(BOUNDARY_RULES),
		);
		for (const [index, violation] of violations.entries()) {
			expect(violation.effect).toBe("deny");
			expect(violation.from_path).not.toBe("");
			expect(violation.to_path).not.toBe("");
			// The record is the edge its line ends with.
			expect(errors[index]).toContain(violation.to_path);
			expect(errors[index]).toContain(violation.from_path);
		}
	});

	it("the CUE constraint and the proto comment list exactly the rules the gate can raise", () => {
		const models = join(
			dirname(fileURLToPath(import.meta.url)),
			"../data-models",
		);
		const cue = readFileSync(join(models, "conformance.cue"), "utf8");
		const definition = /#BoundaryRule:([^#]+)/u.exec(cue)?.[1] ?? "";
		expect(
			[...definition.matchAll(/"([a-z-]+)"/gu)].map((match) => match[1]),
		).toEqual([...BOUNDARY_RULES]);
		expect(cue).toMatch(/rule:\s+#BoundaryRule/u);

		const proto = readFileSync(join(models, "conformance.proto"), "utf8");
		const comment =
			/message BoundaryViolationRecord \{([^}]*?)string rule = 1;/u.exec(
				proto,
			)?.[1] ?? "";
		expect(
			[...comment.matchAll(/([a-z]+(?:-[a-z]+)+)/gu)].map((match) => match[1]),
		).toEqual([...BOUNDARY_RULES]);
	});
});
