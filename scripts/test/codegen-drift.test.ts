import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { discoverDataModelPackages } from "../../packages/schema-tools/src/discover.ts";
import { hashCodegenInputs, runAffectedCodegen } from "../ci/codegen-drift.mts";

const directories: string[] = [];
after(() => {
	for (const directory of directories) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function write(root: string, path: string, content: string): void {
	const target = join(root, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, content);
}

function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), "codegen-drift-"));
	directories.push(root);
	for (const name of ["alpha", "beta"]) {
		write(root, `packages/${name}/data-models/buf.yaml`, "version: v2\n");
		write(
			root,
			`packages/${name}/data-models/model.proto`,
			`syntax = "proto3";\npackage ${name};\n`,
		);
		write(root, `packages/${name}/src/_generated/model_pb.ts`, `${name}\n`);
	}
	write(root, "buf.gen.yaml", "version: v2\n");
	write(root, "packages/schema-tools/src/codegen.ts", "export {};\n");
	write(
		root,
		"pnpm-lock.yaml",
		`importers:
  packages/schema-tools:
    dependencies:
      '@bufbuild/buf':
        specifier: 1.71.0
        version: 1.71.0
      '@bufbuild/protoc-gen-es':
        specifier: 2.12.1
        version: 2.12.1(@bufbuild/protobuf@2.12.1)
`,
	);
	write(root, "mise.toml", '[tools]\ncue = "0.14.0"\n');
	write(
		root,
		"mise.lock",
		'[[tools.cue]]\nversion = "0.14.0"\nbackend = "aqua:cue-lang/cue"\n',
	);
	return root;
}

function packages(root: string) {
	const discovered = discoverDataModelPackages(root);
	const alpha = discovered.find((pkg) => pkg.name === "alpha");
	const beta = discovered.find((pkg) => pkg.name === "beta");
	assert.ok(alpha);
	assert.ok(beta);
	return { alpha, beta };
}

describe("codegen drift input hashes", () => {
	it("changes for package and shared generator inputs only", async () => {
		const root = workspace();
		const { alpha, beta } = packages(root);
		const alphaHash = await hashCodegenInputs(root, alpha);
		const betaHash = await hashCodegenInputs(root, beta);

		for (const path of [
			"packages/alpha/data-models/model.proto",
			"packages/alpha/src/_generated/model_pb.ts",
		]) {
			const original = readFileSync(join(root, path), "utf8");
			write(root, path, `${original}// changed\n`);
			assert.notEqual(await hashCodegenInputs(root, alpha), alphaHash, path);
			assert.equal(await hashCodegenInputs(root, beta), betaHash, path);
			write(root, path, original);
		}

		for (const [path, from, to] of [
			["buf.gen.yaml", "version: v2", "version: v2\n# changed"],
			[
				"packages/schema-tools/src/codegen.ts",
				"export {};",
				"export const x = 1;",
			],
			["pnpm-lock.yaml", "version: 1.71.0", "version: 1.71.1"],
			[
				"pnpm-lock.yaml",
				"version: 2.12.1(@bufbuild/protobuf@2.12.1)",
				"version: 2.12.2(@bufbuild/protobuf@2.12.1)",
			],
			["mise.toml", 'cue = "0.14.0"', 'cue = "0.14.1"'],
			["mise.lock", 'version = "0.14.0"', 'version = "0.14.1"'],
		] as const) {
			const original = readFileSync(join(root, path), "utf8");
			write(root, path, original.replace(from, to));
			assert.notEqual(await hashCodegenInputs(root, alpha), alphaHash, path);
			assert.notEqual(await hashCodegenInputs(root, beta), betaHash, path);
			write(root, path, original);
		}
	});
});

describe("affected codegen checks", () => {
	it("skips valid CLEAN stamps and re-runs missing or corrupt stamps", async () => {
		const root = workspace();
		const cacheDir = join(root, "cache");
		const calls: string[] = [];
		const run = () =>
			runAffectedCodegen({
				repoRoot: root,
				cacheDir,
				checkPackage: async (pkg) => {
					calls.push(pkg.name);
					return {
						status: "CLEAN",
						drift: [],
						cueViolations: [],
						durationMs: 1,
					};
				},
				log: () => {},
			});

		assert.deepEqual((await run()).checked, ["alpha", "beta"]);
		assert.deepEqual(calls, ["alpha", "beta"]);
		assert.deepEqual((await run()).checked, []);
		assert.deepEqual(calls, ["alpha", "beta"]);

		const stamps = readdirSync(cacheDir);
		assert.equal(stamps.length, 2);
		for (const stamp of stamps)
			writeFileSync(join(cacheDir, stamp), "corrupt\n");
		assert.deepEqual((await run()).checked, ["alpha", "beta"]);

		rmSync(cacheDir, { recursive: true, force: true });
		assert.deepEqual((await run()).checked, ["alpha", "beta"]);
		assert.equal(calls.length, 6);
	});

	it("reports drift and stamps only packages whose check is CLEAN", async () => {
		const root = workspace();
		const cacheDir = join(root, "cache");
		const output: string[] = [];
		const drifted = await runAffectedCodegen({
			repoRoot: root,
			cacheDir,
			checkPackage: async (pkg) =>
				pkg.name === "alpha"
					? {
							status: "DRIFT",
							drift: [{ path: "alpha/model_pb.ts", kind: "changed" }],
							cueViolations: [],
							durationMs: 1,
						}
					: { status: "CLEAN", drift: [], cueViolations: [], durationMs: 1 },
			log: (line) => output.push(line),
		});
		assert.equal(drifted.status, "DRIFT");
		assert.ok(
			output.some((line) => line.includes("drift: changed alpha/model_pb.ts")),
		);

		const recovered = await runAffectedCodegen({
			repoRoot: root,
			cacheDir,
			checkPackage: async () => ({
				status: "CLEAN",
				drift: [],
				cueViolations: [],
				durationMs: 1,
			}),
			log: () => {},
		});
		assert.deepEqual(recovered.checked, ["alpha"]);
		assert.deepEqual(recovered.skipped, ["beta"]);
	});
});
