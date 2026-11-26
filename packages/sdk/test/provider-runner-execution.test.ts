import { execFile, execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	createGithubActionsClient,
	createGithubRunnerProvider,
} from "@hobo/runner-github";
import {
	createManualClock,
	createRuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { describe, expect, it } from "vitest";
import { runner } from "../src/dispatcher.js";
import { generateProvider } from "../src/generate-provider.js";
import {
	createGeneratedHttpProvider,
	executeLocalRunner,
	executeProviderGeneration,
	executeRemoteRunner,
	loadGeneratedProvider,
} from "../src/provider-runner-execution.js";

describe("executable SDK runner and provider generation", () => {
	it("executes local jobs without a relay, records real exit outcomes and preserves argv as data", async () => {
		const directory = await mkdtemp(join(tmpdir(), "sdk-runner-"));
		const store = createRuntimeLocalEventStore({
			dataDir: directory,
			clock: createManualClock(),
		});
		const context = {
			executionId: "local-job",
			store,
			actor: { kind: "user" as const, id: "operator" },
			tenant: "test",
		};
		try {
			const result = await executeLocalRunner(
				runner.selfHosted(),
				{
					jobId: "one",
					argv: [
						process.execPath,
						"-e",
						"process.stdout.write(process.argv[1])",
						"$(echo unsafe); *",
					],
					cwd: directory,
				},
				context,
			);
			expect(result.status).toBe("succeeded");
			expect(result.stdout).toBe("$(echo unsafe); *");
			const failed = await executeLocalRunner(
				runner.selfHosted(),
				{
					jobId: "two",
					argv: [process.execPath, "-e", "process.exit(7)"],
					cwd: directory,
				},
				context,
			);
			expect(failed.exitCode).toBe(7);
			expect(failed.status).toBe("failed");
			const events = [];
			for await (const event of store.read(
				`sdk-execution:${JSON.stringify(["test", "local-job"])}`,
			))
				events.push(event.data);
			expect(events).toHaveLength(4);
			await expect(
				executeLocalRunner(
					runner.selfHosted(),
					{
						jobId: "one",
						argv: [process.execPath, "-e", "process.exit(0)"],
						cwd: directory,
					},
					context,
				),
			).rejects.toThrow(/already started/);
			await expect(
				executeLocalRunner(
					runner.selfHosted(),
					{
						jobId: "one",
						argv: [process.execPath, "-e", "process.exit(0)"],
						cwd: directory,
					},
					{ ...context, tenant: "other" },
				),
			).resolves.toMatchObject({ status: "succeeded" });
			expect(events.at(-1)).toMatchObject({
				kind: "runner",
				status: "failed",
				detail: { exitCode: 7 },
			});
		} finally {
			store.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("records timeout, signal termination and output overflow as failed jobs", async () => {
		const directory = await mkdtemp(join(tmpdir(), "sdk-runner-termination-"));
		const store = createRuntimeLocalEventStore({
			dataDir: directory,
			clock: createManualClock(),
		});
		const context = {
			executionId: "terminated-jobs",
			store,
			actor: { kind: "user" as const, id: "operator" },
			tenant: "test",
		};
		try {
			for (const [jobId, script, timeoutMs, maxOutputBytes, timedOut] of [
				["timeout", "setInterval(() => {}, 1000)", 50, 1024, true],
				["signal", "process.kill(process.pid, 'SIGTERM')", 2000, 1024, false],
				["overflow", "process.stdout.write('x'.repeat(4096))", 2000, 64, false],
			] as const) {
				const result = await executeLocalRunner(
					runner.selfHosted(),
					{
						jobId,
						argv: [process.execPath, "-e", script],
						cwd: directory,
						timeoutMs,
						maxOutputBytes,
					},
					context,
				);
				expect(result.status).toBe("failed");
				expect(result.exitCode).not.toBe(0);
				expect(result.timedOut).toBe(timedOut);
			}
			const statuses: string[] = [];
			for await (const event of store.read(
				`sdk-execution:${JSON.stringify(["test", "terminated-jobs"])}`,
			))
				statuses.push(String(event.data.status));
			expect(statuses).toEqual([
				"started",
				"failed",
				"started",
				"failed",
				"started",
				"failed",
			]);
		} finally {
			store.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("keeps provider calls within their declared paths before forwarding credentials", async () => {
		const requests: string[] = [];
		const server = createServer((req, res) => {
			requests.push(`${req.url} ${req.headers.authorization}`);
			res.end("ok");
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (!address || !(address instanceof Object))
			throw new Error("missing server address");
		const base = `http://127.0.0.1:${address.port}/v1`;
		try {
			const provider = createGeneratedHttpProvider(base, [
				{ id: "item", method: "GET", path: "/{id}" },
			]);
			for (const id of [
				".",
				"..",
				"a/b",
				"a\\b",
				"%2e%2e",
				"%2fadmin",
				"%5cadmin",
			]) {
				await expect(
					provider.invoke("item", {
						path: { id },
						headers: { authorization: "Bearer scoped-token" },
					}),
				).rejects.toThrow(/path/);
			}
			for (const path of [
				"/../admin",
				"/a/./admin",
				"/%2e%2e/admin",
				"/%2fadmin",
				"/\\admin",
				"//admin",
			]) {
				await expect(
					createGeneratedHttpProvider(base, [
						{ id: "unsafe", method: "GET", path },
					]).invoke("unsafe", {
						headers: { authorization: "Bearer scoped-token" },
					}),
				).rejects.toThrow(/path/);
			}
			expect(requests).toEqual([]);
			expect(
				await provider.invoke("item", {
					path: { id: "hello world" },
					headers: { authorization: "Bearer scoped-token" },
				}),
			).toMatchObject({ status: 200 });
			expect(requests).toEqual(["/v1/hello%20world Bearer scoped-token"]);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("generates, compiles, signs and invokes a provider against a real self-hosted HTTP API", async () => {
		const directory = await mkdtemp(join(tmpdir(), "sdk-provider-"));
		const store = createRuntimeLocalEventStore({
			dataDir: join(directory, "events"),
			clock: createManualClock(),
		});
		let base = "";
		const calls: string[] = [];
		const server = createServer((req, res) => {
			if (req.url === "/prose") {
				res.end(
					`Items API at ${base}. GET /items/{id} reads an item; POST /items creates an item.`,
				);
				return;
			}
			if (req.url === "/model") {
				let prompt = "";
				req.on("data", (chunk) => {
					prompt += chunk;
				});
				req.on("end", () => {
					expect(JSON.parse(prompt).model).toBe("local-model");
					res.setHeader("content-type", "application/json");
					res.end(
						JSON.stringify({
							choices: [
								{
									message: {
										content: JSON.stringify({
											openapi: "3.0.3",
											servers: [{ url: base }],
											paths: {
												"/items/{id}": { get: { operationId: "getItem" } },
												"/items": { post: { operationId: "createItem" } },
											},
										}),
									},
								},
							],
						}),
					);
				});
				return;
			}
			if (req.url === "/openapi.json") {
				res.setHeader("content-type", "application/json");
				res.end(
					JSON.stringify({
						openapi: "3.0.3",
						servers: [{ url: base }],
						paths: {
							"/items/{id}": { get: { operationId: "getItem" } },
							"/items": { post: { operationId: "createItem" } },
						},
					}),
				);
				return;
			}
			calls.push(`${req.method} ${req.url}`);
			if (req.method === "POST") {
				let body = "";
				req.on("data", (chunk) => {
					body += chunk;
				});
				req.on("end", () => {
					res.statusCode = 201;
					res.end(body);
				});
				return;
			}
			res.end(
				JSON.stringify({
					id: decodeURIComponent(req.url?.split("/").at(-1) ?? ""),
				}),
			);
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (!address || !(address instanceof Object))
			throw new Error("server did not bind TCP");
		base = `http://127.0.0.1:${address.port}`;
		const { privateKey } = generateKeyPairSync("ed25519");
		try {
			const generated = await executeProviderGeneration(
				await generateProvider(`${base}/openapi.json`),
				{
					context: {
						executionId: "provider",
						store,
						actor: { kind: "user", id: "operator" },
						tenant: "test",
					},
					providerId: "self-hosted-api",
					outputDir: join(directory, "output"),
					signingKey: privateKey,
					conformance: [
						{
							operationId: "getItem",
							input: { path: { id: "one" } },
							expectedStatus: 200,
						},
						{
							operationId: "createItem",
							input: { body: { name: "nested", details: { enabled: true } } },
							expectedStatus: 201,
						},
					],
				},
			);
			expect(calls).toEqual(["GET /items/one", "POST /items"]);
			const source = await readFile(generated.receipt.sourcePath, "utf8");
			expect(createHash("sha256").update(source).digest("hex")).toBe(
				generated.receipt.digest,
			);
			expect(
				verify(
					null,
					Buffer.from(generated.receipt.digest),
					generated.receipt.publicKey,
					Buffer.from(generated.receipt.signature, "base64"),
				),
			).toBe(true);
			execFileSync(
				process.execPath,
				[
					createRequire(import.meta.url).resolve("typescript/bin/tsc"),
					"--ignoreConfig",
					"--noEmit",
					"--strict",
					"--target",
					"ES2022",
					"--module",
					"NodeNext",
					"--moduleResolution",
					"NodeNext",
					"--skipLibCheck",
					join(directory, "output", "provider.ts"),
				],
				{ cwd: process.cwd(), stdio: "inherit" },
			);
			// Plain Node loads verified compiled JavaScript through the public SDK.
			// No TypeScript loader or experimental strip-types flag is required.
			expect(generated.receipt.sourcePath.endsWith("provider.mjs")).toBe(true);
			const output = await promisify(execFile)(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`const sdk=await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)});const p=await sdk.loadGeneratedProvider(${JSON.stringify(generated.receipt)},${JSON.stringify(generated.receipt.publicKey)});const r=await p.invoke("getItem",{path:{id:"two"}});console.log(r.body);`,
				],
				{ encoding: "utf8", timeout: 10000 },
			);
			expect(JSON.parse(output.stdout)).toEqual({ id: "two" });
			const trusted = await loadGeneratedProvider(
				generated.receipt,
				generated.receipt.publicKey,
			);
			const beforeTraversal = calls.length;
			for (const id of ["..", "a/b", "%2e%2e"]) {
				await expect(
					trusted.invoke("getItem", {
						path: { id },
						headers: { authorization: "Bearer scoped-token" },
					}),
				).rejects.toThrow(/path/);
			}
			expect(calls).toHaveLength(beforeTraversal);
			expect(
				(await trusted.invoke("getItem", { path: { id: "trusted" } })).status,
			).toBe(200);
			const unverifiedPath = join(directory, "unverified.mjs");
			await writeFile(
				unverifiedPath,
				'throw new Error("unverified replacement executed");',
			);
			let pathReads = 0;
			const switchingReceipt = {
				...generated.receipt,
				get sourcePath() {
					pathReads++;
					return pathReads === 1
						? generated.receipt.sourcePath
						: unverifiedPath;
				},
			};
			const byteBound = await loadGeneratedProvider(
				switchingReceipt,
				generated.receipt.publicKey,
			);
			expect(pathReads).toBe(1);
			expect(
				(await byteBound.invoke("getItem", { path: { id: "verified-bytes" } }))
					.status,
			).toBe(200);
			await writeFile(
				generated.receipt.sourcePath,
				`${source}\nthrow new Error("untrusted execution");`,
			);
			await expect(
				loadGeneratedProvider(generated.receipt, generated.receipt.publicKey),
			).rejects.toThrow(/integrity|signature/);
			await writeFile(generated.receipt.sourcePath, source);
			const prose = await executeProviderGeneration(
				await generateProvider(`${base}/prose`),
				{
					context: {
						executionId: "prose",
						store,
						actor: { kind: "user", id: "operator" },
						tenant: "test",
					},
					providerId: "model-provider",
					outputDir: join(directory, "prose-output"),
					signingKey: privateKey,
					synthesisModel: { endpoint: `${base}/model`, model: "local-model" },
					conformance: [
						{
							operationId: "getItem",
							input: { path: { id: "model" } },
							expectedStatus: 200,
						},
						{
							operationId: "createItem",
							input: { body: { name: "model" } },
							expectedStatus: 201,
						},
					],
				},
			);
			expect(prose.receipt.operationCount).toBe(2);
			await expect(
				executeProviderGeneration(
					await generateProvider(`${base}/openapi.json`),
					{
						context: {
							executionId: "incomplete",
							store,
							actor: { kind: "user", id: "operator" },
							tenant: "test",
						},
						providerId: "incomplete",
						outputDir: join(directory, "incomplete"),
						signingKey: privateKey,
						conformance: [],
					},
				),
			).rejects.toThrow(/conformance case required/);

			const events = [];
			for await (const event of store.read(
				`sdk-execution:${JSON.stringify(["test", "provider"])}`,
			))
				events.push(event.data);
			expect(events.at(-1)).toMatchObject({
				kind: "provider-generation",
				step: "sign",
				status: "succeeded",
			});
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			store.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("runs the real GitHub runner adapter over HTTP and refuses uncorrelated backend results", async () => {
		const directory = await mkdtemp(join(tmpdir(), "sdk-remote-runner-"));
		const store = createRuntimeLocalEventStore({
			dataDir: directory,
			clock: createManualClock(),
		});
		const requests: string[] = [];
		const server = createServer((req, res) => {
			requests.push(`${req.method} ${req.url}`);
			expect(req.headers.authorization).toBe("Bearer test-installation-token");
			if (req.method === "POST") {
				res.statusCode = 204;
				res.end();
				return;
			}
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify({
					workflow_runs: [
						{
							id: 1,
							status: "completed",
							conclusion: "success",
							html_url: "https://self-hosted.example/run/1",
						},
					],
				}),
			);
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (!address || !(address instanceof Object))
			throw new Error("server did not bind");
		const context = {
			executionId: "remote",
			store,
			actor: { kind: "user" as const, id: "operator" },
			tenant: "test",
		};
		try {
			const declaration = runner.github();
			const backend = createGithubRunnerProvider({
				id: declaration.providerId,
				client: createGithubActionsClient({
					owner: "org",
					repo: "repo",
					token: async () => "test-installation-token",
					baseUrl: `http://127.0.0.1:${address.port}`,
				}),
				tracking: { intervalMs: 0, attempts: 1 },
			});
			const result = await executeRemoteRunner(
				declaration,
				{ jobId: "remote-one", command: "node --version" },
				backend,
				context,
			);
			expect(result.status).toBe("succeeded");
			expect(requests).toHaveLength(2);
			await expect(
				executeRemoteRunner(
					declaration,
					{ jobId: "remote-two" },
					{
						id: declaration.providerId,
						async run() {
							return {
								jobId: "wrong",
								providerId: declaration.providerId,
								status: "succeeded",
							};
						},
					},
					context,
				),
			).rejects.toThrow(/uncorrelated/);
			const events = [];
			for await (const event of store.read(
				`sdk-execution:${JSON.stringify(["test", "remote"])}`,
			))
				events.push(event.data);
			expect(events.at(-1)).toMatchObject({ kind: "runner", status: "failed" });
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			store.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
});
