import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { it } from "vitest";
import * as originalRuntime from "../../packages/runtime/src/index.js";
import * as originalSqlite from "../../packages/storage-sqlite/src/index.js";
import {
	bundleSqliteSdk,
	prepareSqliteSdkManifest,
} from "../ci/bundle-sqlite-sdk.mts";
import {
	applyScopeToManifest,
	loadNpmScopeMap,
} from "../ci/npm-publish-scope.mts";
import {
	prepareRuntimeGroundingManifest,
	vendorRuntimeGrounding,
} from "../ci/vendor-runtime-grounding.mts";

const run = promisify(execFile);
const root = join(import.meta.dirname, "../..");

it("packs SQLite and runtime SDKs with shared identity and usable declarations", async () => {
	const temp = await mkdtemp(join(tmpdir(), "hobo-sqlite-sdk-"));
	const consumer = join(temp, "consumer");
	const version = "0.0.0-proof.1";
	const packages = [
		"core",
		"fleet",
		"backend-routing",
		"storage-sqlite",
		"runtime",
		"wit",
	];
	const dirs = Object.fromEntries(
		packages.map((name) => [name, join(temp, name)]),
	);
	try {
		await mkdir(consumer);
		for (const name of packages) {
			const source = join(root, "packages", name);
			const target = dirs[name]!;
			await mkdir(target);
			await cp(join(source, "dist"), join(target, "dist"), { recursive: true });
			await cp(join(source, "LICENSE"), join(target, "LICENSE"));
			if (name === "wit") {
				await cp(join(source, "src/generated"), join(target, "src/generated"), {
					recursive: true,
				});
				await cp(join(source, "wit"), join(target, "wit"), { recursive: true });
				await cp(join(source, "wit-lock.json"), join(target, "wit-lock.json"));
			}
			const raw = JSON.parse(
				await readFile(join(source, "package.json"), "utf8"),
			);
			const manifest =
				name === "storage-sqlite"
					? applyScopeToManifest(
							prepareSqliteSdkManifest(raw, root),
							loadNpmScopeMap(),
							{ version },
						)
					: name === "runtime"
						? applyScopeToManifest(
								{
									...prepareRuntimeGroundingManifest(
										raw,
										JSON.parse(
											await readFile(
												join(
													root,
													"external/ts-autocode/packages/grounding/package.json",
												),
												"utf8",
											),
										),
									),
									name: "@hobo/runtime",
								},
								loadNpmScopeMap(),
								{ version },
							)
						: {
								...raw,
								name:
									name === "core" || name === "fleet" || name === "wit"
										? `@hobo-labs/${name}`
										: raw.name,
								version,
							};
			delete manifest.scripts;
			delete manifest.devDependencies;
			if (name === "fleet" || name === "backend-routing") {
				manifest.dependencies["@hobo/core"] = `npm:@hobo-labs/core@${version}`;
			}
			if (name === "backend-routing") {
				manifest.dependencies["@hobo/fleet"] =
					`npm:@hobo-labs/fleet@${version}`;
			}
			await writeFile(join(target, "package.json"), JSON.stringify(manifest));
		}
		const originalManifest = JSON.parse(
			await readFile(
				join(root, "packages/storage-sqlite/package.json"),
				"utf8",
			),
		);
		const stagedManifest = JSON.parse(
			await readFile(join(dirs["storage-sqlite"]!, "package.json"), "utf8"),
		);
		assert.deepEqual(stagedManifest.exports, originalManifest.exports);
		bundleSqliteSdk(
			dirs["storage-sqlite"]!,
			join(root, "packages/storage-sqlite"),
			root,
		);
		vendorRuntimeGrounding({
			runtimeDir: dirs.runtime!,
			groundingDir: join(root, "external/ts-autocode/packages/grounding"),
			licenseFile: join(root, "external/ts-autocode/LICENSE"),
		});
		const typescript = join(temp, "typescript");
		await cp(
			join(
				root,
				"external/ts-autocode/packages/grounding/node_modules/typescript",
			),
			typescript,
			{ recursive: true, dereference: true },
		);
		const buf = join(temp, "protobuf");
		await cp(join(root, "node_modules/@bufbuild/protobuf"), buf, {
			recursive: true,
			dereference: true,
		});
		const nodeTypes = join(temp, "node-types");
		const nodeTypesPath = await realpath(
			join(root, "node_modules/@types/node"),
		);
		await cp(nodeTypesPath, nodeTypes, { recursive: true });
		const undici = join(temp, "undici-types");
		await cp(join(dirname(dirname(nodeTypesPath)), "undici-types"), undici, {
			recursive: true,
			dereference: true,
		});
		const packed = new Map<
			string,
			{ data: Buffer; manifest: { name: string; version: string } }
		>();
		const archive = new Map<string, string>();
		for (const dir of [
			...packages.map((name) => dirs[name]!),
			buf,
			nodeTypes,
			undici,
			typescript,
		]) {
			const manifest = JSON.parse(
				await readFile(join(dir, "package.json"), "utf8"),
			);
			const result = await run("npm", ["pack", "--json", "--ignore-scripts"], {
				cwd: dir,
			});
			const file = join(dir, JSON.parse(result.stdout)[0].filename);
			packed.set(manifest.name, { data: await readFile(file), manifest });
			archive.set(manifest.name, file);
		}
		const server = createServer((request, response) => {
			const url = decodeURIComponent(request.url ?? "");
			const name = url.startsWith("/tar/") ? url.slice(5) : url.slice(1);
			const entry = packed.get(name);
			if (!entry) {
				response.writeHead(404);
				response.end();
				return;
			}
			if (url.startsWith("/tar/")) {
				response.writeHead(200);
				response.end(entry.data);
				return;
			}
			const address = server.address();
			if (!(address instanceof Object))
				throw new Error("registry address missing");
			const pkgVersion = String(entry.manifest.version);
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					name,
					"dist-tags": { latest: pkgVersion },
					versions: {
						[pkgVersion]: {
							...entry.manifest,
							dist: { tarball: `http://127.0.0.1:${address.port}/tar/${name}` },
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
				throw new Error("registry address missing");
			await writeFile(
				join(consumer, "package.json"),
				'{"name":"consumer","version":"1.0.0","type":"module","private":true}',
			);
			await run(
				"npm",
				[
					"install",
					"--ignore-scripts",
					"--no-audit",
					"--no-fund",
					"--registry",
					`http://127.0.0.1:${address.port}`,
					archive.get("@hobo-labs/storage-sqlite")!,
					archive.get("@hobo/backend-routing")!,
					archive.get("@hobo-labs/runtime")!,
					archive.get("@types/node")!,
				],
				{ cwd: consumer, timeout: 30_000 },
			);
			const installed = await run(
				"node",
				[
					"--input-type=module",
					"-e",
					`
				import assert from "node:assert/strict";
				import * as sqlite from "@hobo-labs/storage-sqlite";
				import * as runtime from "@hobo-labs/runtime";
				assert(Array.isArray(runtime.listTrainables()));
				assert.equal(runtime.TRAINABLE, Symbol.for("hobo.trainable"));
				import { ImmutableJournalError as CoreError, EventStoreError } from "@hobo/core";
				import { ImmutableJournalError as RoutingError } from "@hobo/backend-routing";
				assert.equal(CoreError, RoutingError);
				assert(new sqlite.MigrationFailureError("proof") instanceof EventStoreError);
				const db = sqlite.createMemoryNodeSqliteDriver();
				db.exec("create table t (v integer); insert into t values (42)");
				assert.equal(db.prepare("select v from t").get().v, 42n);
				let attempts = 0, recoverCalls = 0, authorizations = 0;
				const journal = { fleetId: "events", anchorDigest: "0".repeat(64), quorum: 2, members: [],
					async recover() { recoverCalls++; return []; },
					async read() { throw new RoutingError("quorum-unavailable"); },
					async append() { attempts++; if (attempts === 1) throw new RoutingError("head-conflict"); return {}; } };
				const store = sqlite.createQuorumEventStore({ journal, nowMs: () => 1800000000000,
					maxReplayEntries: 100, maxReplayBytes: 1000000,
					operationalRecovery: { async authorize() { authorizations++; } } });
				await store.append("stream", [{ type: "test.Created" }], { actor: { kind: "service", id: "test" }, tenant: "tenant", expectedSeq: 0 });
				assert.equal(attempts, 2); assert.equal(recoverCalls, 2);
				for await (const item of store.readAll({})) void item;
				assert.equal(recoverCalls, 3); assert.equal(authorizations, 2); await store.close();
				const spoof = { reason: "quorum-unavailable" };
				const guarded = sqlite.createQuorumEventStore({ journal: { ...journal, async read() { throw spoof; } },
					nowMs: () => 1800000000000, maxReplayEntries: 100, maxReplayBytes: 1000000,
					operationalRecovery: { async authorize() { throw new Error("must not authorize"); } } });
				await assert.rejects(async () => { for await (const item of guarded.readAll({})) void item; }, (error) => error === spoof);
				await guarded.close();
				console.log(JSON.stringify([Object.keys(sqlite).sort(), Object.keys(runtime).sort()]));
			`,
				],
				{ cwd: consumer },
			);
			assert.equal(
				installed.stdout.trim(),
				JSON.stringify([
					Object.keys(originalSqlite).sort(),
					Object.keys(originalRuntime).sort(),
				]),
			);
			await writeFile(
				join(consumer, "check.ts"),
				'import { createMemoryNodeSqliteDriver, createQuorumEventStore } from "@hobo-labs/storage-sqlite"; import type { WitActorKey } from "@hobo-labs/runtime"; let key: WitActorKey; void key!; void createMemoryNodeSqliteDriver; void createQuorumEventStore;',
			);
			await run(
				join(root, "node_modules/.bin/tsc"),
				[
					"--noEmit",
					"--strict",
					"--module",
					"NodeNext",
					"--moduleResolution",
					"NodeNext",
					"--target",
					"ES2022",
					"--types",
					"node",
					"check.ts",
				],
				{ cwd: consumer },
			);
			const runtimeLicense = await run("tar", [
				"-xOzf",
				archive.get("@hobo-labs/runtime")!,
				"package/dist/_vendor/ts-autocode-grounding/LICENSE",
			]);
			assert.equal(
				runtimeLicense.stdout,
				await readFile(join(root, "external/ts-autocode/LICENSE"), "utf8"),
			);
			const contents = await run("tar", [
				"-tzf",
				archive.get("@hobo-labs/storage-sqlite")!,
			]);
			for (const file of [
				"package/LICENSE",
				"package/LICENSE.backend-routing",
				"package/LICENSE.fleet",
			])
				assert(contents.stdout.split("\n").includes(file));
			for (const name of ["backend-routing", "fleet"]) {
				const embedded = await run("tar", [
					"-xOzf",
					archive.get("@hobo-labs/storage-sqlite")!,
					"package/LICENSE." + name,
				]);
				assert.equal(
					embedded.stdout,
					await readFile(join(root, "packages", name, "LICENSE"), "utf8"),
				);
			}
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}, 120_000);

it("rejects SQLite bundle dependency drift", async () => {
	const temp = await mkdtemp(join(tmpdir(), "hobo-sqlite-guard-"));
	try {
		for (const name of ["backend-routing", "fleet"]) {
			const dir = join(temp, "packages", name);
			await mkdir(dir, { recursive: true });
			await writeFile(
				join(dir, "package.json"),
				JSON.stringify({
					name: `@hobo/${name}`,
					dependencies: {
						"@bufbuild/protobuf": "2.12.1",
						"unexpected-package": "1.0.0",
					},
				}),
			);
		}
		assert.throws(
			() =>
				prepareSqliteSdkManifest(
					{
						name: "@hobo/storage-sqlite",
						exports: {
							".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
						},
						dependencies: {
							"@hobo/core": "workspace:*",
							"@hobo/backend-routing": "workspace:*",
						},
					},
					temp,
				),
			/unsupported dependency unexpected-package/,
		);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});
