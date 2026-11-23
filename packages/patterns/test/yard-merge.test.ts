import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyPatternPlan,
	buildHoboVocabulary,
	composePatterns,
	loadPatternCatalog,
	ReceiptStatus,
	renderPattern,
} from "../src/index.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const catalog = loadPatternCatalog();
const roots: string[] = [];

function setup() {
	const root = mkdtempSync(join(tmpdir(), "hobo-yard-pattern-"));
	roots.push(root);
	return root;
}

function apply(
	root: string,
	patternId: string,
	params: Record<string, string>,
) {
	return applyPatternPlan({
		catalog,
		patternId,
		isolationRoot: root,
		targetPath: "yard.ts",
		isolationRunId: "yard-test",
		params,
	});
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("yard pattern application", () => {
	it("adds a second camp without duplicating the network and is idempotent", () => {
		const root = setup();
		apply(root, "yard.shared-network", { name: "shop" });
		apply(root, "camp.colocate", { name: "shop", peerCamp: "api" });
		const result = readFileSync(join(root, "yard.ts"), "utf8");
		expect(result.match(/camp\("web"\)/gu)).toHaveLength(1);
		expect(result.match(/camp\("api"\)/gu)).toHaveLength(1);
		expect(result.match(/"shared"/gu)).toHaveLength(1);
		expect(result).toContain('provider: "local"');
		expect(result).not.toContain("@hobo.");
		const modules = join(root, "node_modules", "@hobo");
		mkdirSync(modules, { recursive: true });
		for (const name of ["camps", "yards"]) {
			symlinkSync(
				realpathSync(resolve(packageRoot, "node_modules", "@hobo", name)),
				join(modules, name),
				"dir",
			);
		}
		writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
		const campPattern = catalog.patterns.find(
			(pattern) => pattern.id === "camp.colocate",
		);
		if (!campPattern) throw new Error("camp pattern missing");
		const rendered = renderPattern({
			catalog,
			pattern: campPattern,
			params: { name: "shop" },
		}).files[0];
		if (!rendered) throw new Error("camp fragment missing");
		const fragmentPath = join(root, "fragment.ts");
		writeFileSync(fragmentPath, rendered.contents);
		execFileSync(resolve(packageRoot, "../../node_modules/.bin/tsc"), [
			"--noEmit",
			"--ignoreConfig",
			"--skipLibCheck",
			"--module",
			"NodeNext",
			"--moduleResolution",
			"NodeNext",
			"--target",
			"ES2022",
			fragmentPath,
		]);
		const fragmentOutput = execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--input-type=module",
				"-e",
				'import { pathToFileURL } from "node:url"; const { placement } = await import(pathToFileURL(process.argv[1])); process.stdout.write(JSON.stringify({ yardName: placement.yardName, camps: placement.camps.map(camp => camp.name) }));',
				fragmentPath,
			],
			{ encoding: "utf8" },
		);
		expect(JSON.parse(fragmentOutput)).toEqual({
			yardName: "shop-yard",
			camps: ["api"],
		});
		const output = execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--input-type=module",
				"-e",
				'import { pathToFileURL } from "node:url"; const { topology } = await import(pathToFileURL(process.argv[1])); process.stdout.write(JSON.stringify({ provider: topology.providerId, network: topology.network, camps: topology.camps.map(camp => camp.name) }));',
				join(root, "yard.ts"),
			],
			{ encoding: "utf8" },
		);
		expect(JSON.parse(output)).toEqual({
			provider: "local",
			network: ["shared"],
			camps: ["shop-yard/web", "shop-yard/api"],
		});
		const diagnostics =
			ts.transpileModule(result, { reportDiagnostics: true }).diagnostics ?? [];
		expect(
			diagnostics.filter(
				(diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
			),
		).toHaveLength(0);
		const retry = apply(root, "camp.colocate", {
			name: "shop",
			peerCamp: "api",
		});
		expect(retry.idempotent).toBe(true);
		expect(readFileSync(join(root, "yard.ts"), "utf8")).toBe(result);
	});

	it("keeps an existing Yard network when colocating a Camp", () => {
		const root = setup();
		apply(root, "yard.azure", { name: "shop" });
		apply(root, "camp.colocate", { name: "shop", peerCamp: "api" });
		const result = readFileSync(join(root, "yard.ts"), "utf8");
		expect(result).toContain('provider: "azure"');
		expect(result).toContain('"private"');
		expect(result).not.toContain('"shared"');
		expect(result).toContain('camp("prod")');
		expect(result).toContain('camp("api")');
	});

	it("rejects conflicting providers and different yards without changing the file", () => {
		const root = setup();
		apply(root, "yard.shared-network", { name: "shop" });
		const before = readFileSync(join(root, "yard.ts"), "utf8");
		expect(() => apply(root, "yard.azure", { name: "shop" })).toThrow(
			/provider conflicts/u,
		);
		expect(() => apply(root, "camp.colocate", { name: "other" })).toThrow(
			/yard names differ/u,
		);
		expect(readFileSync(join(root, "yard.ts"), "utf8")).toBe(before);
	});

	it("composes the actual merged Yard and rejects conflicting compositions", () => {
		const shared = catalog.patterns.find(
			(pattern) => pattern.id === "yard.shared-network",
		);
		const colocated = catalog.patterns.find(
			(pattern) => pattern.id === "camp.colocate",
		);
		const azure = catalog.patterns.find(
			(pattern) => pattern.id === "yard.azure",
		);
		expect(shared).toBeDefined();
		expect(colocated).toBeDefined();
		expect(azure).toBeDefined();
		if (!shared || !colocated || !azure)
			throw new Error("yard patterns missing");
		const select = (patterns: typeof catalog.patterns) =>
			composePatterns({
				catalog: {
					...catalog,
					patterns: patterns.map((pattern) => ({
						...pattern,
						aliases: ["yard-composition-test"],
					})),
				},
				vocabulary: buildHoboVocabulary(),
				query: "yard-composition-test",
				params: { name: "shop" },
			});
		const root = setup();
		apply(root, "yard.shared-network", { name: "shop" });
		apply(root, "camp.colocate", { name: "shop" });
		const merged = readFileSync(join(root, "yard.ts"), "utf8");
		const accepted = select([colocated, shared]);
		expect(accepted.status).toBe(ReceiptStatus.ACCEPTED);
		expect(accepted.outputDigest).toBe(
			createHash("sha256").update(merged).digest("hex"),
		);
		const rejected = select([shared, azure]);
		expect(rejected.status).toBe(ReceiptStatus.REJECTED);
		expect(rejected.reasonCode).toBe("conflict");
		expect(rejected.conflicts).toContain("src/yard.ts");
	});

	it("requires an existing yard for a colocated camp", () => {
		const root = setup();
		expect(() => apply(root, "camp.colocate", { name: "shop" })).toThrow(
			/yard topology is required/u,
		);
	});

	it("rejects dynamic topology without changing the source", () => {
		const root = setup();
		const source =
			'import { yard } from "@hobo/yards";\nexport const topology = yard("shop-yard", { network: getNetworks(), camps: [] });\n';
		writeFileSync(join(root, "yard.ts"), source);
		expect(() => apply(root, "camp.colocate", { name: "shop" })).toThrow(
			/literal array/u,
		);
		expect(readFileSync(join(root, "yard.ts"), "utf8")).toBe(source);
	});

	it("preserves unrelated existing Yard options", () => {
		const root = setup();
		writeFileSync(
			join(root, "yard.ts"),
			'import { yard } from "@hobo/yards";\nexport const topology = yard("shop-yard", { provider: "local", regions: ["west"], labels: { team: "core" }, camps: [] });\n',
		);
		apply(root, "camp.colocate", { name: "shop", peerCamp: "api" });
		const result = readFileSync(join(root, "yard.ts"), "utf8");
		expect(result).toContain('regions: ["west"]');
		expect(result).toMatch(/labels:\s*\{\s*team:\s*["']core["']/u);
		expect(result).toContain('camp("api")');
	});

	it("rejects conflicting bindings and imports without changing the source", () => {
		const root = setup();
		const source =
			'import { yard } from "@hobo/yards";\nconst camp = () => null;\nexport const topology = yard("shop-yard", { provider: "local", network: [], camps: [] });\n';
		writeFileSync(join(root, "yard.ts"), source);
		expect(() => apply(root, "camp.colocate", { name: "shop" })).toThrow(
			/import camp conflicts/u,
		);
		expect(readFileSync(join(root, "yard.ts"), "utf8")).toBe(source);
		const renamed =
			'import { yard } from "@hobo/yards";\nexport const other = yard("shop-yard", { provider: "local", network: [], camps: [] });\n';
		writeFileSync(join(root, "yard.ts"), renamed);
		expect(() => apply(root, "yard.azure", { name: "shop" })).toThrow(
			/bindings differ/u,
		);
		expect(readFileSync(join(root, "yard.ts"), "utf8")).toBe(renamed);
	});

	it("rejects a dynamic provider even when the added pattern has no provider", () => {
		const root = setup();
		const source =
			'import { yard } from "@hobo/yards";\nexport const topology = yard("shop-yard", { provider: getProvider(), network: [], camps: [] });\n';
		writeFileSync(join(root, "yard.ts"), source);
		expect(() => apply(root, "camp.colocate", { name: "shop" })).toThrow(
			/provider must be a literal/u,
		);
		expect(readFileSync(join(root, "yard.ts"), "utf8")).toBe(source);
	});

	it("adds a missing camp import when extending a simple yard", () => {
		const root = setup();
		writeFileSync(
			join(root, "yard.ts"),
			'import { yard } from "@hobo/yards";\nexport const topology = yard("shop-yard", { provider: "local", network: [], camps: [] });\n',
		);
		apply(root, "camp.colocate", { name: "shop", peerCamp: "api" });
		const result = readFileSync(join(root, "yard.ts"), "utf8");
		expect(result).toMatch(
			/import\s*\{\s*camp\s*\}\s*from\s*["']@hobo\/camps["']/u,
		);
		expect(result).toContain('camp("api")');
	});
});
