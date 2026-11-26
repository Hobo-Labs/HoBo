import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import {
	applyScopeToManifest,
	loadNpmScopeMap,
} from "../ci/npm-publish-scope.mts";
import { installSdkTarballsIntoApp } from "../ci/stage-release-oci-app.mts";

async function command(
	cwd: string,
	executable: string,
	args: string[],
): Promise<string> {
	return await new Promise((resolve, reject) => {
		const child = spawn(executable, args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		child.on("error", reject);
		child.on("close", (code) =>
			code === 0
				? resolve(stdout)
				: reject(new Error(`${executable} exited ${code}: ${stderr}`)),
		);
	});
}

it("installs a packed SDK package and resolves its original workspace import", async () => {
	const root = await mkdtemp(join(tmpdir(), "hobo-npm-pack-"));
	const core = join(root, "core");
	const bindles = join(root, "bindles");
	const consumer = join(root, "consumer");
	await Promise.all([core, bindles, consumer].map((dir) => mkdir(dir)));
	const map = loadNpmScopeMap();
	const version = "0.0.0-test.1";
	try {
		const coreManifest = applyScopeToManifest({ name: "@hobo/core" }, map, {
			version,
		});
		const bindlesManifest = applyScopeToManifest(
			{
				name: "@hobo/bindles",
				dependencies: { "@hobo/core": "workspace:*" },
			},
			map,
			{ version },
		);
		await writeFile(
			join(core, "package.json"),
			JSON.stringify({ ...coreManifest, type: "module", main: "index.js" }),
		);
		await writeFile(join(core, "index.js"), "export const value = 42;\n");
		await writeFile(
			join(bindles, "package.json"),
			JSON.stringify({ ...bindlesManifest, type: "module", main: "index.js" }),
		);
		await writeFile(
			join(bindles, "index.js"),
			'export { value } from "@hobo/core";\n',
		);
		await writeFile(
			join(consumer, "package.json"),
			'{"name":"consumer","version":"1.0.0","private":true,"type":"module"}',
		);
		const [corePack, bindlesPack] = await Promise.all([
			command(core, "npm", ["pack", "--json", "--ignore-scripts"]),
			command(bindles, "npm", ["pack", "--json", "--ignore-scripts"]),
		]);
		const coreTar = await readFile(
			join(core, JSON.parse(corePack)[0].filename),
		);
		const bindlesTar = join(bindles, JSON.parse(bindlesPack)[0].filename);
		const artifacts = join(root, "artifacts");
		const overlay = join(root, "overlay");
		await Promise.all([artifacts, overlay].map((dir) => mkdir(dir)));
		const coreFile = JSON.parse(corePack)[0].filename;
		const bindlesFile = JSON.parse(bindlesPack)[0].filename;
		await Promise.all([
			copyFile(join(core, coreFile), join(artifacts, coreFile)),
			copyFile(bindlesTar, join(artifacts, bindlesFile)),
		]);
		await writeFile(
			join(artifacts, "MANIFEST.json"),
			JSON.stringify({
				version,
				packages: [
					{
						workspace: "@hobo/core",
						public: "@hobo-labs/core",
						file: coreFile,
					},
					{
						workspace: "@hobo/bindles",
						public: "@hobo-labs/bindles",
						file: bindlesFile,
					},
				],
			}),
		);
		installSdkTarballsIntoApp(overlay, artifacts);
		const overlayResult = await command(overlay, "node", [
			"--input-type=module",
			"-e",
			'import { value } from "@hobo-labs/bindles"; console.log(value)',
		]);
		assert.equal(overlayResult.trim(), "42");
		const server = createServer((request, response) => {
			if (request.url === "/core.tgz") {
				response.writeHead(200, { "content-type": "application/octet-stream" });
				response.end(coreTar);
				return;
			}
			const address = server.address();
			if (!(address instanceof Object))
				throw new Error("missing registry address");
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					name: coreManifest.name,
					"dist-tags": { latest: version },
					versions: {
						[version]: {
							...coreManifest,
							dist: { tarball: `http://127.0.0.1:${address.port}/core.tgz` },
						},
					},
				}),
			);
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		try {
			const address = server.address();
			if (!(address instanceof Object))
				throw new Error("missing registry address");
			await command(consumer, "npm", [
				"install",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
				"--registry",
				`http://127.0.0.1:${address.port}`,
				bindlesTar,
			]);
			const result = await command(consumer, "node", [
				"--input-type=module",
				"-e",
				'import { value } from "@hobo-labs/bindles"; console.log(value)',
			]);
			assert.equal(result.trim(), "42");
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
