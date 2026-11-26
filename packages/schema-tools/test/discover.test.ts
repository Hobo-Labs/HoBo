import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	discoverDataModelPackages,
	hydrateCueSchemas,
} from "../src/discover.js";
import {
	makeTempRepo,
	REPO_ROOT,
	removeTempRepo,
} from "./support/temp-workspace.js";

async function scaffoldPackage(
	packagesRoot: string,
	name: string,
	options: { bufYaml?: boolean; cueFiles?: readonly string[] } = {},
): Promise<string> {
	const dataModels = join(packagesRoot, name, "data-models");
	await mkdir(dataModels, { recursive: true });
	if (options.bufYaml !== false) {
		await writeFile(join(dataModels, "buf.yaml"), "version: v2\n");
	}
	for (const cueFile of options.cueFiles ?? []) {
		await writeFile(join(dataModels, cueFile), "package data_models\n");
	}
	return join(packagesRoot, name);
}

describe("discoverDataModelPackages", () => {
	it("discovers only packages whose data-models carry a buf.yaml marker", async () => {
		const root = await makeTempRepo({
			withBufTemplate: false,
			withCueCache: false,
		});
		try {
			const packagesRoot = join(root, "packages");
			await scaffoldPackage(packagesRoot, "alpha");
			await scaffoldPackage(packagesRoot, "beta", { bufYaml: false });
			const discovered = discoverDataModelPackages(root, { packagesRoot });
			expect(discovered.map((pkg) => pkg.name)).toEqual(["alpha"]);
		} finally {
			await removeTempRepo(root);
		}
	});

	it("descends one level into nested category containers with category-prefixed names", async () => {
		const root = await makeTempRepo({
			withBufTemplate: false,
			withCueCache: false,
		});
		try {
			const packagesRoot = join(root, "packages");
			await scaffoldPackage(packagesRoot, "zeta");
			await scaffoldPackage(packagesRoot, join("providers", "gamma"));
			await scaffoldPackage(packagesRoot, join("runtimes", "delta"));
			const discovered = discoverDataModelPackages(root, { packagesRoot });
			expect(discovered.map((pkg) => pkg.name)).toEqual([
				"providers/gamma",
				"runtimes/delta",
				"zeta",
			]);
		} finally {
			await removeTempRepo(root);
		}
	});

	it("derives dataModelsDir and generatedDir from the package directory", async () => {
		const root = await makeTempRepo({
			withBufTemplate: false,
			withCueCache: false,
		});
		try {
			const packagesRoot = join(root, "packages");
			const packageDir = await scaffoldPackage(packagesRoot, "alpha");
			const [pkg] = discoverDataModelPackages(root, { packagesRoot });
			expect(pkg?.packageDir).toBe(packageDir);
			expect(pkg?.dataModelsDir).toBe(join(packageDir, "data-models"));
			expect(pkg?.generatedDir).toBe(join(packageDir, "src", "_generated"));
			expect(pkg?.cueSchemas).toEqual([]);
			expect(Object.isFrozen(pkg)).toBe(true);
		} finally {
			await removeTempRepo(root);
		}
	});

	it("applies --filter as a package-directory prefix", async () => {
		const root = await makeTempRepo({
			withBufTemplate: false,
			withCueCache: false,
		});
		try {
			const packagesRoot = join(root, "packages");
			await scaffoldPackage(packagesRoot, "alpha");
			const betaDir = await scaffoldPackage(packagesRoot, "beta");
			const filtered = discoverDataModelPackages(root, {
				packagesRoot,
				filter: betaDir,
			});
			expect(filtered.map((pkg) => pkg.name)).toEqual(["beta"]);
			const none = discoverDataModelPackages(root, {
				packagesRoot,
				filter: join(packagesRoot, "does-not-exist"),
			});
			expect(none).toEqual([]);
		} finally {
			await removeTempRepo(root);
		}
	});

	it("returns [] for a missing packages root", () => {
		expect(
			discoverDataModelPackages("/nonexistent-root", {
				packagesRoot: "/nonexistent-root/packages",
			}),
		).toEqual([]);
	});

	it("descends into packages/adapters, where an adapter opts into codegen the same way", async () => {
		const root = await makeTempRepo({
			withBufTemplate: false,
			withCueCache: false,
		});
		try {
			const packagesRoot = join(root, "packages");
			await scaffoldPackage(packagesRoot, join("adapters", "adapter-sample"));
			// An adapter whose data-models carry no buf.yaml stays documentation-only.
			await scaffoldPackage(packagesRoot, join("adapters", "adapter-plain"), {
				bufYaml: false,
			});
			const discovered = discoverDataModelPackages(root, { packagesRoot });
			expect(discovered.map((pkg) => pkg.name)).toEqual([
				"adapters/adapter-sample",
			]);
			expect(discovered[0]?.generatedDir).toBe(
				join(packagesRoot, "adapters", "adapter-sample", "src", "_generated"),
			);
		} finally {
			await removeTempRepo(root);
		}
	});

	it("sees the real repo: core is in the codegen lane, runtime-local is documentation-only", () => {
		const discovered = discoverDataModelPackages(REPO_ROOT);
		const names = discovered.map((pkg) => pkg.name);
		expect(names).toContain("core");
		expect(names).toContain("schema-tools");
		// runtime-local's data-models carry no buf.yaml: its .proto/.cue files
		// are documentation mirrors (see test/envelope-single-source.test.ts).
		expect(names).not.toContain("runtimes/runtime-local");
	});
});

describe("hydrateCueSchemas", () => {
	it("lists only .cue files, sorted, as frozen absolute paths", async () => {
		const root = await makeTempRepo({
			withBufTemplate: false,
			withCueCache: false,
		});
		try {
			const packagesRoot = join(root, "packages");
			await scaffoldPackage(packagesRoot, "alpha", {
				cueFiles: ["zulu.cue", "alpha.cue"],
			});
			await writeFile(
				join(packagesRoot, "alpha", "data-models", "readme.md"),
				"not a schema\n",
			);
			const discovered = discoverDataModelPackages(root, { packagesRoot });
			const [pkg] = await hydrateCueSchemas(discovered);
			expect(pkg?.cueSchemas).toEqual([
				join(packagesRoot, "alpha", "data-models", "alpha.cue"),
				join(packagesRoot, "alpha", "data-models", "zulu.cue"),
			]);
			expect(Object.isFrozen(pkg?.cueSchemas)).toBe(true);
		} finally {
			await removeTempRepo(root);
		}
	});
});
