import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { bundleCliDeclarations } from "../ci/bundle-cli-declarations.mts";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "hobo-cli-dts-test-"));
	const cliDist = join(root, "cli-dist");
	const externalModules = join(root, "external");
	const core = join(root, "core");
	const internal = join(root, "internal");
	for (const dir of [
		cliDist,
		externalModules,
		join(core, "dist"),
		join(internal, "dist"),
	])
		mkdirSync(dir, { recursive: true });
	symlinkSync(
		join(process.cwd(), "node_modules", "@types"),
		join(externalModules, "@types"),
		"dir",
	);
	writeFileSync(
		join(core, "package.json"),
		JSON.stringify({
			name: "@hobo/core",
			type: "module",
			exports: { ".": { types: "./dist/index.d.ts" } },
		}),
	);
	writeFileSync(
		join(core, "dist", "index.d.ts"),
		"export declare class Ticket { private brand; value: string; }\n",
	);
	writeFileSync(
		join(internal, "package.json"),
		JSON.stringify({
			name: "@hobo/private",
			type: "module",
			exports: { ".": { types: "./dist/index.d.ts" } },
		}),
	);
	writeFileSync(
		join(internal, "dist", "index.d.ts"),
		'import type { Ticket } from "@hobo/core"; export interface Receipt { ticket: Ticket; }\n',
	);
	writeFileSync(
		join(cliDist, "index.d.ts"),
		'export { Ticket } from "@hobo/core"; export type { Receipt } from "@hobo/private";\n',
	);
	const packages = [
		{ name: "@hobo/core", root: core },
		{ name: "@hobo/private", root: internal },
	];
	return {
		root,
		cliDist,
		externalModules,
		packages,
		publicImports: [{ source: "@hobo/core", published: "@hobo-labs/core" }],
		manifestDependencies: ["@hobo-labs/core"],
		outputFile: join(root, "output.d.ts"),
	};
}

test("bundles private types and preserves the published nominal class", () => {
	const input = fixture();
	bundleCliDeclarations(input);
	const result = readFileSync(input.outputFile, "utf8");
	assert.match(result, /from ['"]@hobo-labs\/core['"]/);
	assert.doesNotMatch(result, /@hobo\/private/);
	assert.match(result, /Receipt/);
});

test("fails closed on unapproved external imports without overwriting output", () => {
	const input = fixture();
	const rogue = join(input.externalModules, "rogue");
	mkdirSync(rogue);
	writeFileSync(
		join(rogue, "package.json"),
		JSON.stringify({ name: "rogue", types: "index.d.ts" }),
	);
	writeFileSync(
		join(rogue, "index.d.ts"),
		"export declare class Unsafe { private brand; }\n",
	);
	writeFileSync(
		join(input.cliDist, "index.d.ts"),
		'export { Unsafe } from "rogue";\n',
	);
	writeFileSync(input.outputFile, "sentinel");
	assert.throws(
		() => bundleCliDeclarations(input),
		/Unpublished declaration import: rogue/,
	);
	assert.equal(readFileSync(input.outputFile, "utf8"), "sentinel");
});

test("rejects a public import absent from the staged manifest", () => {
	const input = fixture();
	writeFileSync(input.outputFile, "sentinel");
	assert.throws(
		() => bundleCliDeclarations({ ...input, manifestDependencies: [] }),
		/Declaration import absent from manifest: @hobo-labs\/core/,
	);
	assert.equal(readFileSync(input.outputFile, "utf8"), "sentinel");
});

test("rejects malformed generated declarations without replacing output", () => {
	const input = fixture();
	const generatorFile = join(input.root, "invalid-generator.cjs");
	writeFileSync(
		generatorFile,
		`const fs = require("node:fs"); const out = process.argv[process.argv.indexOf("--out-file") + 1]; fs.writeFileSync(out, "export declare class Ticket { private brand; value: MissingType; }\\nexport interface Receipt { ticket: Ticket; }\\n");`,
	);
	writeFileSync(input.outputFile, "sentinel");
	assert.throws(
		() => bundleCliDeclarations({ ...input, generatorFile }),
		/Cannot find name 'MissingType'/,
	);
	assert.equal(readFileSync(input.outputFile, "utf8"), "sentinel");
});

test("rejects unresolved symbols after public alias rewriting", () => {
	const input = fixture();
	const generatorFile = join(input.root, "invalid-aliased-generator.cjs");
	const output = `import { Missing } from "@hobo/core";\nexport { Ticket } from "@hobo/core";\nexport interface Receipt { ticket: Missing; }\n`;
	writeFileSync(
		generatorFile,
		`const fs = require("node:fs"); const out = process.argv[process.argv.indexOf("--out-file") + 1]; fs.writeFileSync(out, ${JSON.stringify(output)});`,
	);
	writeFileSync(input.outputFile, "sentinel");
	assert.throws(
		() => bundleCliDeclarations({ ...input, generatorFile }),
		/has no exported member 'Missing'/,
	);
	assert.equal(readFileSync(input.outputFile, "utf8"), "sentinel");
});

test("rejects a missing or mismatched package before generation", () => {
	const input = fixture();
	const [core, internal] = input.packages;
	assert.ok(core);
	assert.ok(internal);
	assert.throws(
		() =>
			bundleCliDeclarations({
				...input,
				packages: [{ name: "@hobo/core", root: internal.root }],
			}),
		/Package name mismatch/,
	);
	assert.throws(
		() =>
			bundleCliDeclarations({
				...input,
				packages: [core, core],
			}),
		/Duplicate declaration package/,
	);
});
