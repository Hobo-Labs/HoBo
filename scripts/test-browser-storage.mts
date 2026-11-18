import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
const runtime = join(root, "packages/runtimes/runtime-browser");
const directory = await mkdtemp(join(tmpdir(), "hobo-browser-storage-"));
const resolveRuntime = createRequire(join(runtime, "package.json"));

try {
	await Promise.all([
		build({
			stdin: {
				contents: `export * from ${JSON.stringify(join(runtime, "src/index.ts"))}; export { OptimisticSequenceConflictError } from "@hobo/core/eventstore";`,
				resolveDir: runtime,
				loader: "ts",
			},
			bundle: true,
			platform: "browser",
			format: "esm",
			outfile: join(directory, "main.js"),
			logLevel: "silent",
		}),
		build({
			entryPoints: [join(runtime, "src/sqlite-worker.ts")],
			bundle: true,
			platform: "browser",
			format: "esm",
			outfile: join(directory, "sqlite-worker.js"),
			logLevel: "silent",
		}),
		copyFile(
			resolveRuntime.resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm"),
			join(directory, "sqlite3.wasm"),
		),
	]);
	const files = new Map([
		["/main.js", ["main.js", "text/javascript"]],
		["/sqlite-worker.js", ["sqlite-worker.js", "text/javascript"]],
		["/sqlite3.wasm", ["sqlite3.wasm", "application/wasm"]],
	]);
	const server = createServer(async (request, response) => {
		if (request.url === "/") {
			response.writeHead(200, { "content-type": "text/html" });
			response.end("<!doctype html><title>Browser storage</title>");
			return;
		}
		const file = files.get(request.url ?? "");
		if (!file?.[0] || !file[1]) {
			response.writeHead(404).end();
			return;
		}
		try {
			const body = await readFile(join(directory, file[0]));
			response.writeHead(200, { "content-type": file[1] }).end(body);
		} catch {
			response.writeHead(500).end();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!(address instanceof Object))
			throw new Error("Browser test server has no port");
		const executablePath =
			process.env.HOBO_CHROMIUM_PATH ??
			(existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
		const browser = await chromium.launch({
			...(executablePath ? { executablePath } : undefined),
			args: ["--no-sandbox"],
		});
		try {
			const page = await browser.newPage();
			await page.goto(`http://127.0.0.1:${address.port}/`);
			const result = await page.evaluate(async () => {
				const entry = "/main.js";
				const sdk: typeof import("../packages/runtimes/runtime-browser/src/index.js") &
					typeof import("../packages/core/src/eventstore.js") = await import(
					entry
				);
				const partitionId = `browser-test-${Date.now()}`;
				const store = await sdk.createBrowserEventStore({ partitionId });
				const received: string[] = [];
				const subscription = store.subscribe(
					{ streamId: "notes:1" },
					(event) => {
						received.push(event.type);
					},
				);
				await subscription.ready;
				const result = await store.append(
					"notes:1",
					[{ type: "note.Saved", data: { text: "stored" } }],
					{
						expectedSeq: 0,
						actor: { kind: "system", id: "browser" },
						tenant: "t",
					},
				);
				await store.snapshot("notes:1", { text: "stored" }, 1);
				if (!store.claimSubscription || !store.commitCheckpoint)
					throw new Error("Checkpoint operations are unavailable");
				const lease = await store.claimSubscription({
					subscriptionId: "reader",
					partitionId,
					holderId: "browser",
				});
				const checkpoint = await store.commitCheckpoint({
					subscriptionId: "reader",
					partitionId,
					position: 1n,
					fenceToken: lease.fenceToken,
				});
				let conflict = "";
				let typedConflict = false;
				try {
					await store.append("notes:1", [{ type: "note.Saved", data: {} }], {
						expectedSeq: 0,
						actor: { kind: "system", id: "browser" },
						tenant: "t",
					});
				} catch (error) {
					typedConflict =
						error instanceof sdk.OptimisticSequenceConflictError &&
						error.expectedSeq === 0 &&
						error.actualSeq === 1;
					if (error instanceof Error && "code" in error)
						conflict = String(error.code);
				}
				subscription.unsubscribe();
				await store.close();
				const reopened = await sdk.createBrowserEventStore({ partitionId });
				const events = [];
				for await (const event of reopened.read("notes:1")) events.push(event);
				const snapshot = await reopened.loadSnapshot?.("notes:1");
				const savedCheckpoint = await reopened.loadCheckpoint?.({
					subscriptionId: "reader",
					partitionId,
				});
				await reopened.close();
				Object.defineProperty(navigator.storage, "getDirectory", {
					configurable: true,
					value: undefined,
				});
				const transient = await sdk.createBrowserEventStore({
					partitionId,
					allowTransient: true,
				});
				const transientMode = transient.persistenceMode;
				await transient.append(
					"temporary",
					[{ type: "note.Saved", data: {} }],
					{
						expectedSeq: 0,
						actor: { kind: "system", id: "browser" },
						tenant: "t",
					},
				);
				await transient.close();
				const freshTransient = await sdk.createBrowserEventStore({
					partitionId,
					allowTransient: true,
				});
				const transientEvents = [];
				for await (const event of freshTransient.read("temporary"))
					transientEvents.push(event);
				await freshTransient.close();
				return {
					mode: store.persistenceMode,
					firstPosition: String(result.firstPosition),
					received,
					events: events.map((event) => event.data),
					snapshot: snapshot?.state,
					checkpoint: String(checkpoint.position),
					savedCheckpoint: String(savedCheckpoint?.position),
					conflict,
					typedConflict,
					transientMode,
					transientCount: transientEvents.length,
				};
			});
			assert.deepEqual(result, {
				mode: "opfs-sahpool",
				firstPosition: "1",
				received: ["note.Saved"],
				events: [{ text: "stored" }],
				snapshot: { text: "stored" },
				checkpoint: "1",
				savedCheckpoint: "1",
				conflict: "OPTIMISTIC_SEQUENCE_CONFLICT",
				typedConflict: true,
				transientMode: "transient-memory",
				transientCount: 0,
			});
			console.log(
				"Browser OPFS journal persisted events, snapshots and checkpoints across reopen.",
			);
		} finally {
			await browser.close();
		}
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
} finally {
	await rm(directory, { recursive: true, force: true });
}
