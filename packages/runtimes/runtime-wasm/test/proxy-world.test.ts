import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

import { componentizePrivateGuest } from "../src/sandbox.js";

const jco = path.resolve(
	import.meta.dirname,
	"../node_modules/@bytecodealliance/jco/src/jco.js",
);
const worlds = [
	path.resolve(import.meta.dirname, "../wit/wasi-http"),
	path.resolve(import.meta.dirname, "../../../hobo/wit/wasi-http"),
] as const;

test("runtime and packaged HTTP worlds agree", () => {
	for (const file of [
		"proxy.wit",
		"deps/http/proxy.wit",
		"deps/http/handler.wit",
		"deps/http/types.wit",
		"deps.toml",
		"deps.lock",
	]) {
		assert.equal(
			readFileSync(path.join(worlds[0], file), "utf8"),
			readFileSync(path.join(worlds[1], file), "utf8"),
			file,
		);
	}
});

test("private HTTP world avoids stdin while preserving the standard proxy", () => {
	const output = mkdtempSync(path.join(tmpdir(), "hobo-http-world-"));
	try {
		for (const [index, wit] of worlds.entries()) {
			for (const [world, filename] of [
				["proxy", "proxy.d.ts"],
				["wasi:http/proxy@0.2.3", "proxy@0.2.3.d.ts"],
			] as const) {
				const dir = path.join(
					output,
					`${index}-${world === "proxy" ? "private" : "standard"}`,
				);
				execFileSync(
					process.execPath,
					[
						jco,
						"types",
						wit,
						"--world-name",
						world,
						"--out-dir",
						dir,
						"--quiet",
					],
					{ timeout: 30_000, stdio: "pipe" },
				);
				const declarations = readFileSync(path.join(dir, filename), "utf8");
				assert.match(
					declarations,
					/export wasi:http\/incoming-handler@0\.2\.3/u,
				);
				assert.match(
					declarations,
					/import wasi:http\/outgoing-handler@0\.2\.3/u,
				);
				if (world === "proxy")
					assert.doesNotMatch(declarations, /wasi:cli\/stdin/u);
				else assert.match(declarations, /import wasi:cli\/stdin@0\.2\.3/u);
			}
		}
	} finally {
		rmSync(output, { recursive: true, force: true });
	}
}, 60_000);

test("component cache tracks WIT changes and discards failed rebuilds", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "hobo-component-cache-"));
	const wit = path.join(root, "wit");
	const guest = path.join(root, "source.mjs");
	const fakeJco = path.join(root, "jco.mjs");
	const countFile = path.join(root, "count");
	const failureFile = path.join(root, "fail");
	const workDir = path.join(root, "component");
	try {
		mkdirSync(path.join(wit, "deps"), { recursive: true });
		writeFileSync(
			path.join(wit, "proxy.wit"),
			"package hobo:test; world proxy {}\n",
		);
		writeFileSync(path.join(wit, "deps", "types.wit"), "package hobo:types;\n");
		writeFileSync(guest, "export const version = 1;\n");
		writeFileSync(
			fakeJco,
			`import { existsSync, readFileSync, writeFileSync } from "node:fs";
const countFile = ${JSON.stringify(countFile)};
const failureFile = ${JSON.stringify(failureFile)};
if (existsSync(failureFile)) process.exit(1);
const count = existsSync(countFile) ? Number(readFileSync(countFile, "utf8")) + 1 : 1;
writeFileSync(countFile, String(count));
writeFileSync(process.argv[process.argv.indexOf("-o") + 1], "component-" + count);
`,
		);
		const options = {
			resourceName: "api",
			guestSourcePath: guest,
			workDir,
			jcoBin: fakeJco,
			witDir: wit,
		};
		const compile = () => componentizePrivateGuest(options);
		const count = () => readFileSync(countFile, "utf8");

		const first = await compile();
		assert.equal(readFileSync(first.wasmPath, "utf8"), "component-1");
		await compile();
		assert.equal(count(), "1");

		writeFileSync(
			path.join(wit, "deps", "types.wit"),
			"package hobo:types@0.1.0;\n",
		);
		await compile();
		assert.equal(count(), "2");
		rmSync(path.join(wit, "deps", "types.wit"));
		await compile();
		assert.equal(count(), "3");

		writeFileSync(path.join(workDir, ".componentize-ok"), "legacy timestamp\n");
		await compile();
		assert.equal(count(), "4");

		writeFileSync(guest, "export const version = 2;\n");
		writeFileSync(failureFile, "fail\n");
		await assert.rejects(compile(), /jco componentize failed/u);
		assert.equal(existsSync(first.wasmPath), false);
		assert.equal(existsSync(path.join(workDir, ".componentize-ok")), false);
		rmSync(failureFile);
		await compile();
		assert.equal(count(), "5");

		const automatic = {
			resourceName: "api",
			guestSourcePath: guest,
			jcoBin: fakeJco,
			witDir: wit,
			hoboHome: root,
		};
		const before = await componentizePrivateGuest(automatic);
		writeFileSync(
			path.join(wit, "proxy.wit"),
			"package hobo:test; world proxy { }\n",
		);
		const after = await componentizePrivateGuest(automatic);
		assert.notEqual(before.workDir, after.workDir);

		if (process.platform !== "win32") {
			const externalWit = path.join(root, "external.wit");
			writeFileSync(externalWit, "package hobo:external;\n");
			symlinkSync(externalWit, path.join(wit, "linked.wit"));
			await compile();
			const previousCount = Number(count());
			writeFileSync(externalWit, "package hobo:external@0.1.0;\n");
			await compile();
			assert.equal(Number(count()), previousCount + 1);
			symlinkSync(wit, path.join(wit, "cycle"), "dir");
			await assert.rejects(compile(), /symbolic link cycle/u);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
