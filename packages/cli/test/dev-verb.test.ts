import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
	ComponentHostEvent,
	InterfaceId,
	ParsedComponentDescriptor,
	ProviderDescriptor,
} from "@hobo/core";
import {
	createLocalStreamer,
	createRuntimeLocalComponentHost,
} from "@hobo/runtime-local";
import { describe, expect, it } from "vitest";

import {
	createDevCommand,
	createHoboCli,
	type DevRuntime,
} from "../src/index.js";
import type { JsonValue } from "../src/json.js";

// S1-19: `hobo dev` boots a runtime-local Camp, collects + links the Bindle,
// serves it locally, and live-tails the component-host events through the
// Streamer — fully offline, no network. The ≤ 60 s cold budget is modeled as an
// assertion on the in-process boot time.

// SAFETY: `const KV_INTERFACE = "wasi:keyvalue/store@0.2.0" as InterfaceId;` is required at this I/O or test boundary.
const KV_INTERFACE = "wasi:keyvalue/store@0.2.0" as InterfaceId;
// SAFETY: `const HTTP_INCOMING = "wasi:http/incoming-handler@0.2.0" as InterfaceId;` is required at this I/O or test boundary.
const HTTP_INCOMING = "wasi:http/incoming-handler@0.2.0" as InterfaceId;

const HELLO_BINDLE = {
	schema: "hobo.manifest/v1",
	componentHost: { kind: "wasmtime", version: "46.0.1" },
	resources: {
		api: {
			type: "component.v1",
			runtime: "wasm",
			exports: ["wasi:http/incoming-handler"],
			bind: ["greeting"],
		},
		greeting: { type: "data.v1", port: "kv" },
	},
};

// Build a DevRuntime backed by the real runtime-local component host + Streamer.
// The hello-bindle guest reads a greeting from a KV provider and returns it —
// proving an end-to-end offline serve with a linked import.
function makeDevRuntime(): DevRuntime {
	const events: ComponentHostEvent[] = [];
	const componentHost = createRuntimeLocalComponentHost({
		appendEvent: (event) => events.push(event),
	});
	const streamer = createLocalStreamer();

	const component: ParsedComponentDescriptor = {
		parsed: true,
		id: "hello-bindle",
		imports: [KV_INTERFACE],
		exports: {
			[HTTP_INCOMING]: {
				handle: async (
					_request: JsonValue,
					context: {
						callImport: (
							importInterface: InterfaceId,
							operation: string,
							payload?: JsonValue,
						) => Promise<JsonValue>;
					},
				) => {
					// SAFETY: `const greeting = (await context.callImport(KV_INTERFACE, "get", {` is required at this I/O or test boundary.
					const greeting = (await context.callImport(KV_INTERFACE, "get", {
						key: "greeting",
					})) as string;
					return { status: 200, headers: [], body: `hello ${greeting}` };
				},
			},
		},
	};

	const provider: ProviderDescriptor = {
		id: "local-kv",
		exports: {
			[KV_INTERFACE]: {
				get: async () => "world",
			},
		},
	};

	return {
		componentHost,
		streamer,
		plan: {
			component,
			providers: [provider],
			links: [
				{
					componentId: "hello-bindle",
					importInterface: KV_INTERFACE,
					providerId: "local-kv",
					exportInterface: KV_INTERFACE,
				},
			],
			probe: { method: "GET", path: "/", headers: [], body: "" },
		},
		readEvents: () => events,
	};
}

async function withProject(
	callback: (cwd: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-dev-"));
	await writeFile(
		path.join(dir, "hobo.bindle.json"),
		`${JSON.stringify(HELLO_BINDLE, null, 2)}\n`,
	);
	try {
		await callback(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("hobo dev boots a runtime-local Camp offline", () => {
	it("serves the hello-bindle in-process within the cold budget", async () => {
		await withProject(async (cwd) => {
			const progress: string[] = [];
			const cli = createHoboCli({
				commands: { dev: createDevCommand({ runtime: makeDevRuntime() }) },
			});
			const result = await cli.run(["dev", "--json"], {
				cwd,
				onProgress: (message) => progress.push(message),
			});

			expect(result.exitCode).toBe(0);
			// SAFETY: `const envelope = JSON.parse(result.stdout) as {` is required at this I/O or test boundary.
			const envelope = JSON.parse(result.stdout) as {
				ok: boolean;
				verb: string;
				status: string;
				data: {
					runtime: string;
					offline: boolean;
					localUrl: string;
					bootMs: number;
					withinColdBudget: boolean;
					coldBudgetMs: number;
					served: { status: number; body: string };
					linkedComponents: string[];
					events: string[];
					streamedFrames: number;
				};
			};

			expect(envelope.ok).toBe(true);
			expect(envelope.verb).toBe("dev");
			expect(envelope.status).toBe("serving");
			expect(envelope.data.runtime).toBe("runtime-local");
			expect(envelope.data.offline).toBe(true);
			expect(envelope.data.served.status).toBe(200);
			expect(envelope.data.served.body).toBe("hello world");
			expect(envelope.data.linkedComponents).toEqual(["hello-bindle"]);
			expect(envelope.data.withinColdBudget).toBe(true);
			expect(envelope.data.coldBudgetMs).toBe(60_000);
			expect(envelope.data.bootMs).toBeLessThan(60_000);
			// Live-tailed component-host lifecycle through the Streamer.
			expect(envelope.data.events).toEqual([
				"component.Loaded",
				"link.Established",
				"link.Called",
				"component.Invoked",
			]);
			expect(envelope.data.streamedFrames).toBe(4);
		});
	});

	it("serves deterministically across two cold boots", async () => {
		await withProject(async (cwd) => {
			const run = async () => {
				const cli = createHoboCli({
					commands: { dev: createDevCommand({ runtime: makeDevRuntime() }) },
				});
				const result = await cli.run(["dev", "--json"], { cwd });
				// SAFETY: `return JSON.parse(result.stdout) as {` is required at this I/O or test boundary.
				return JSON.parse(result.stdout) as {
					data: { served: { body: string }; events: string[] };
				};
			};

			const first = await run();
			const second = await run();
			expect(second.data.served.body).toBe(first.data.served.body);
			expect(second.data.events).toEqual(first.data.events);
		});
	});

	it("falls back to the shell stub when no runtime is injected", async () => {
		await withProject(async (cwd) => {
			const result = await createHoboCli().run(["dev", "--json"], { cwd });
			// SAFETY: `const envelope = JSON.parse(result.stdout) as {` is required at this I/O or test boundary.
			const envelope = JSON.parse(result.stdout) as {
				status: string;
				code: string;
			};
			expect(envelope.status).toBe("not_implemented");
			expect(envelope.code).toBe("HOBO_CLI_STUB");
		});
	});

	it("keeps the Yard alive under --serve even when stdio is piped", async () => {
		await withProject(async (cwd) => {
			let once: boolean | undefined;
			let waited = false;
			let closed = false;
			const cli = createHoboCli({
				commands: {
					dev: createDevCommand({
						serveProject: async (input) => {
							once = input.once;
							return {
								primaryUrl: "http://127.0.0.1:4173/",
								bindleName: "hello",
								campId: "camp-local",
								yardName: "local",
								providerId: "bare-metal",
								endpoints: [],
								serviceDiscovery: {},
								probe: { status: 200, body: "ok" },
								close: async () => {
									closed = true;
								},
								waitUntilStopped: async () => {
									waited = true;
								},
							};
						},
					}),
				},
			});
			const result = await cli.run(["dev", "--serve"], { cwd });
			expect(result.exitCode).toBe(0);
			expect(once).toBe(false);
			expect(waited).toBe(true);
			expect(closed).toBe(false);
		});
	});

	it("lets --once win over --serve", async () => {
		await withProject(async (cwd) => {
			let once: boolean | undefined;
			let waited = false;
			const cli = createHoboCli({
				commands: {
					dev: createDevCommand({
						serveProject: async (input) => {
							once = input.once;
							return {
								primaryUrl: "http://127.0.0.1:4173/",
								bindleName: "hello",
								campId: "camp-local",
								yardName: "local",
								providerId: "bare-metal",
								endpoints: [],
								serviceDiscovery: {},
								probe: { status: 200, body: "ok" },
								close: async () => {},
								waitUntilStopped: async () => {
									waited = true;
								},
							};
						},
					}),
				},
			});
			const result = await cli.run(["dev", "--serve", "--once"], { cwd });
			expect(result.exitCode).toBe(0);
			expect(once).toBe(true);
			expect(waited).toBe(false);
		});
	});
});
