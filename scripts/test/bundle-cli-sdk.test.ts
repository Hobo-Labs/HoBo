import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { it } from "vitest";
import { bundleCliSdk, prepareCliSdkManifest } from "../ci/bundle-cli-sdk.mts";

const root = join(import.meta.dirname, "../..");
const run = promisify(execFile);
const readJson = async (path: string) =>
	JSON.parse(await readFile(path, "utf8"));

it("packs CLI assets with npm-preserved starter dotfiles and verifiable provenance", async () => {
	const temp = await mkdtemp(join(tmpdir(), "hobo-cli-bundle-"));
	try {
		await cp(join(root, "packages/cli/dist"), join(temp, "dist"), {
			recursive: true,
		});
		await cp(join(root, "packages/cli/LICENSE"), join(temp, "LICENSE"));
		const manifest = prepareCliSdkManifest(
			await readJson(join(root, "packages/cli/package.json")),
			root,
		);
		await writeFile(
			join(temp, "package.json"),
			JSON.stringify({
				...manifest,
				scripts: undefined,
				devDependencies: undefined,
			}),
		);
		await bundleCliSdk(temp, root);
		const provenance = await readJson(join(temp, "BUNDLE-PROVENANCE.json"));
		assert.equal(
			provenance.packages["ts-autocode-training"].license,
			"0aab615b233f9f7dfdaa6b1202c1eb5e76246eb7af091dd2bce6530a2a8b2b74",
		);
		const { stdout } = await run(
			"npm",
			["pack", "--ignore-scripts", "--json"],
			{ cwd: temp },
		);
		const packed = JSON.parse(stdout)[0];
		const files = new Set<string>(
			packed.files.map((entry: { path: string }) => entry.path),
		);
		assert(files.has("BUNDLE-PROVENANCE.json"));
		for (const [path, expected] of Object.entries({
			...provenance.assets,
			...provenance.outputs,
		})) {
			assert(files.has(path), `${path} missing from npm pack`);
			assert.equal(
				createHash("sha256")
					.update(await readFile(join(temp, path)))
					.digest("hex"),
				expected,
			);
		}
		for (const name of ["agent", "api", "fullstack", "todo"]) {
			const path = `patterns/starter/cli/${name}/project/.gitignore.tpl`;
			assert(files.has(path), `${path} missing from npm pack`);
			assert.equal(
				await readFile(join(temp, path), "utf8"),
				await readFile(
					join(root, "packages/patterns", path.replace(/\.tpl$/, "")),
					"utf8",
				),
			);
		}
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}, 60_000);

it("rejects unreviewed external imports, computed imports, asset roots, and license changes", async () => {
	const temp = await mkdtemp(join(tmpdir(), "hobo-cli-contract-"));
	const source = join(temp, "source");
	const output = join(temp, "output");
	try {
		await mkdir(source);
		await mkdir(join(output, "dist"), { recursive: true });
		await cp(join(root, "LICENSE"), join(source, "LICENSE"));
		for (const name of [
			"bindings",
			"capability-profiles",
			"cd",
			"cli",
			"cloud",
			"componentize",
			"data",
			"events",
			"manifest-capability",
			"manifest-declaration",
			"manifest-plan",
			"patterns",
		]) {
			const from = join(root, "packages", name);
			const to = join(source, "packages", name);
			await mkdir(to, { recursive: true });
			await cp(join(from, "package.json"), join(to, "package.json"));
			await cp(join(from, "dist"), join(to, "dist"), { recursive: true });
			if (name !== "cloud")
				await cp(join(from, "LICENSE"), join(to, "LICENSE"));
		}
		for (const name of ["grounding", "training"]) {
			const from = join(root, "external/ts-autocode/packages", name);
			const to = join(source, "external/ts-autocode/packages", name);
			await mkdir(to, { recursive: true });
			await cp(join(from, "package.json"), join(to, "package.json"));
			await cp(join(from, "dist"), join(to, "dist"), { recursive: true });
		}
		await cp(
			join(root, "external/ts-autocode/LICENSE"),
			join(source, "external/ts-autocode/LICENSE"),
		);
		const entry = join(source, "packages/cli/dist/index.js");
		const entryOriginal = await readFile(entry, "utf8");
		await writeFile(entry, `import "unreviewed-dependency";\n${entryOriginal}`);
		await assert.rejects(
			bundleCliSdk(output, source),
			/unexpected external imports/,
		);
		await writeFile(entry, entryOriginal);
		const input = join(source, "packages/data/dist/index.js");
		const inputOriginal = await readFile(input, "utf8");
		await writeFile(
			input,
			`${inputOriginal}\nexport const unsafeLoader = () => import(globalThis.unreviewed);\n`,
		);
		await assert.rejects(
			bundleCliSdk(output, source),
			/source contract changed/,
		);
		await writeFile(
			input,
			`${inputOriginal}\nexport const unknownRoot = import.meta.url;\n`,
		);
		await assert.rejects(
			bundleCliSdk(output, source),
			/source contract changed/,
		);
		await writeFile(input, inputOriginal);
		const loader = join(source, "packages/cli/dist/cloud/loader.js");
		const loaderOriginal = await readFile(loader, "utf8");
		await writeFile(
			loader,
			`${loaderOriginal}\nexport const extraLoader = (absolute) => import(pathToFileURL(absolute).href);\n`,
		);
		await assert.rejects(
			bundleCliSdk(output, source),
			/source contract changed/,
		);
		await writeFile(loader, loaderOriginal);
		const componentize = join(
			source,
			"packages/componentize/dist/real-componentize.js",
		);
		const componentizeOriginal = await readFile(componentize, "utf8");
		await writeFile(
			componentize,
			componentizeOriginal.replace(
				'const COMPONENTIZE_JS_SPECIFIER = "@bytecodealliance/componentize-js";',
				'const COMPONENTIZE_JS_SPECIFIER = "unexpected-package";',
			),
		);
		await assert.rejects(
			bundleCliSdk(output, source),
			/componentize specifier changed/,
		);
		await writeFile(componentize, componentizeOriginal);
		await writeFile(
			join(source, "packages/data/LICENSE"),
			"not the reviewed license\n",
		);
		await assert.rejects(bundleCliSdk(output, source), /license changed/);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}, 60_000);
