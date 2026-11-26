import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	prepareRuntimeGroundingManifest,
	vendorRuntimeGrounding,
} from "../ci/vendor-runtime-grounding.mts";

const grounding = {
	name: "ts-autocode-grounding",
	version: "0.1.0",
	license: "MIT",
	dependencies: { typescript: "^5.9.3" },
};
const runtime = {
	name: "@hobo/runtime",
	dependencies: {
		"@hobo/core": "workspace:*",
		"ts-autocode-grounding": "workspace:*",
	},
};

test("replaces the unpublished grounding dependency while retaining TypeScript", () => {
	const manifest = prepareRuntimeGroundingManifest(runtime, grounding);
	assert.deepEqual(manifest.dependencies, {
		"@hobo/core": "workspace:*",
		typescript: "^5.9.3",
	});
	assert.equal(runtime.dependencies["ts-autocode-grounding"], "workspace:*");
	assert.throws(
		() =>
			prepareRuntimeGroundingManifest(runtime, {
				...grounding,
				dependencies: { typescript: "^5.9.3", unexpected: "^1" },
			}),
		/Unexpected grounding package metadata/,
	);
	assert.throws(
		() =>
			prepareRuntimeGroundingManifest(
				{
					...runtime,
					dependencies: { ...runtime.dependencies, typescript: "^4" },
				},
				grounding,
			),
		/TypeScript ranges disagree/,
	);
});

test("vendors one shared implementation, declarations, and license while preserving other imports and strings", async () => {
	const root = await mkdtemp(join(tmpdir(), "runtime-vendor-"));
	const stage = join(root, "stage");
	const privatePackage = join(root, "grounding");
	await mkdir(join(stage, "dist", "training"), { recursive: true });
	await mkdir(join(privatePackage, "dist"), { recursive: true });
	await writeFile(
		join(privatePackage, "dist", "index.js"),
		'export { make } from "./make.js";\n',
	);
	await writeFile(
		join(privatePackage, "dist", "index.d.ts"),
		'export { make } from "./make.js";\n',
	);
	await writeFile(
		join(privatePackage, "dist", "make.js"),
		"export const make = () => 1;\n",
	);
	const license = join(root, "LICENSE");
	await writeFile(license, "MIT fixture");
	await writeFile(
		join(stage, "dist", "training", "a.js"),
		'import { make } from "ts-autocode-grounding";\nexport const label = "ts-autocode-grounding";\nexport { X } from "@hobo/core";\n',
	);
	await writeFile(
		join(stage, "dist", "training", "a.d.ts"),
		'export type T = import("ts-autocode-grounding").T;\n',
	);
	await vendorRuntimeGrounding({
		runtimeDir: stage,
		groundingDir: privatePackage,
		licenseFile: license,
	});
	assert.match(
		await readFile(join(stage, "dist", "training", "a.js"), "utf8"),
		/from "\.\.\/_vendor\/ts-autocode-grounding\/index\.js"/,
	);
	assert.match(
		await readFile(join(stage, "dist", "training", "a.js"), "utf8"),
		/label = "ts-autocode-grounding"/,
	);
	assert.match(
		await readFile(join(stage, "dist", "training", "a.js"), "utf8"),
		/from "@hobo\/core"/,
	);
	assert.match(
		await readFile(join(stage, "dist", "training", "a.d.ts"), "utf8"),
		/import\("\.\.\/_vendor\/ts-autocode-grounding\/index\.js"\)/,
	);
	assert.equal(
		await readFile(
			join(stage, "dist", "_vendor", "ts-autocode-grounding", "LICENSE"),
			"utf8",
		),
		"MIT fixture",
	);
});

test("rejects an unexpected bare dependency before copying", async () => {
	const root = await mkdtemp(join(tmpdir(), "runtime-vendor-"));
	const stage = join(root, "stage");
	const privatePackage = join(root, "grounding");
	await mkdir(join(stage, "dist"), { recursive: true });
	await mkdir(join(privatePackage, "dist"), { recursive: true });
	await writeFile(
		join(privatePackage, "dist", "index.js"),
		'export { x } from "untracked-private";\n',
	);
	await writeFile(
		join(privatePackage, "dist", "index.d.ts"),
		"export declare const x: number;\n",
	);
	assert.throws(
		() =>
			vendorRuntimeGrounding({
				runtimeDir: stage,
				groundingDir: privatePackage,
				licenseFile: join(root, "LICENSE"),
			}),
		/Unexpected grounding import: untracked-private/,
	);
});
