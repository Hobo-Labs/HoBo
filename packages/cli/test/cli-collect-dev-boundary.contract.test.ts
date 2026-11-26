import { readFileSync } from "node:fs";
import {
	mkdtemp as mkdtempAsync,
	rm as rmAsync,
	writeFile as writeFileAsync,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CollectionContext, CollectionTarget } from "@hobo/bindles";

import type {
	ComponentHostEvent,
	InterfaceId,
	ParsedComponentDescriptor,
	ProviderDescriptor,
} from "@hobo/core";
import { at, first } from "@hobo/core/total-access";
import {
	createLocalStreamer,
	createRuntimeLocalComponentHost,
} from "@hobo/runtime-local";
import { describe, expect, it } from "vitest";
import {
	createCollectCommand,
	createDevCommand,
	createHoboCli,
	type DevRuntime,
} from "../src/index.js";
import type { JsonObject, JsonValue } from "../src/json.js";

// Consumer pact for the CLI <-> local-dev-loop boundary: the collect (@hobo/bindles
// run-to-collect) and dev (runtime-local Camp) verbs share this seam. The
// recorded expectations pin the collect manifest hash and the offline dev serve
// so drift in either boundary is caught here.

const pactPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"contracts",
	"cli-collect-dev-boundary.pact.json",
);

const COMPONENT_HOST = { kind: "wasmtime", version: "46.0.1" } as const;
// SAFETY: `const KV_INTERFACE = "wasi:keyvalue/store@0.2.0" as InterfaceId;` is required at this I/O or test boundary.
const KV_INTERFACE = "wasi:keyvalue/store@0.2.0" as InterfaceId;
// SAFETY: `const HTTP_INCOMING = "wasi:http/incoming-handler@0.2.0" as InterfaceId;` is required at this I/O or test boundary.
const HTTP_INCOMING = "wasi:http/incoming-handler@0.2.0" as InterfaceId;

interface Interaction {
	description: string;
	request: { verb: string; bindle: string };
	response: JsonObject;
}

function collectTarget(): CollectionTarget {
	return {
		bindleId: "hello-bindle",
		componentHost: COMPONENT_HOST,
		define(collect: CollectionContext) {
			const db = collect.data("db", { paradigm: "relational" });
			collect.service("api", {
				image: "oci://registry.example.com/api@sha256:abc123",
				bind: { db },
			});
		},
	};
}

function makeDevRuntime(): DevRuntime {
	const events: ComponentHostEvent[] = [];
	const componentHost = createRuntimeLocalComponentHost({
		appendEvent: (event) => events.push(event),
	});
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
					// SAFETY: `const greeting = (await context.callImport(` is required at this I/O or test boundary.
					const greeting = (await context.callImport(
						KV_INTERFACE,
						"get",
						{},
					)) as string;
					return { status: 200, headers: [], body: `hello ${greeting}` };
				},
			},
		},
	};
	const provider: ProviderDescriptor = {
		id: "local-kv",
		exports: { [KV_INTERFACE]: { get: async () => "world" } },
	};
	return {
		componentHost,
		streamer: createLocalStreamer(),
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
	manifest: JsonValue,
	callback: (cwd: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtempAsync(
		path.join(tmpdir(), "hobo-cli-devcollect-pact-"),
	);
	await writeFileAsync(
		path.join(dir, "hobo.bindle.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	try {
		await callback(dir);
	} finally {
		await rmAsync(dir, { recursive: true, force: true });
	}
}

const HELLO_BINDLE_MANIFEST = {
	schema: "hobo.manifest/v1",
	componentHost: COMPONENT_HOST,
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

describe("CLI <-> local-dev-loop boundary pact", () => {
	// SAFETY: `const pact = JSON.parse(readFileSync(pactPath, "utf8")) as {` is required at this I/O or test boundary.
	const pact = JSON.parse(readFileSync(pactPath, "utf8")) as {
		consumer: { name: string };
		provider: { name: string };
		interactions: Interaction[];
	};

	it("names the CLI consumer and the local-dev-loop provider", () => {
		expect(pact.consumer.name).toBe("@hobo/cli");
		expect(pact.provider.name).toBe("@hobo/local-dev-loop");
	});

	it("hobo collect matches the recorded manifest IR interaction", async () => {
		const expected = first(pact.interactions).response;
		await withProject({}, async (cwd) => {
			const cli = createHoboCli({
				commands: {
					collect: createCollectCommand({ target: collectTarget() }),
				},
			});
			const result = await cli.run(["collect", "--json"], { cwd });
			// SAFETY: `const envelope = JSON.parse(result.stdout) as {` is required at this I/O or test boundary.
			const envelope = JSON.parse(result.stdout) as {
				status: string;
				data: {
					manifestHash: string;
					resources: string[];
					events: Array<{ type: string }>;
				};
			};
			expect(envelope.status).toBe(expected.status);
			expect(envelope.data.manifestHash).toBe(expected.manifestHash);
			expect(envelope.data.resources).toEqual(expected.resources);
			expect(envelope.data.events.map((e) => e.type)).toEqual(expected.events);
		});
	});

	it("hobo dev matches the recorded offline serve interaction", async () => {
		// SAFETY: `const expected = at(pact.interactions, 1).response as {` is required at this I/O or test boundary.
		const expected = at(pact.interactions, 1).response as {
			status: string;
			runtime: string;
			offline: boolean;
			served: { status: number; body: string };
			events: string[];
		};
		await withProject(HELLO_BINDLE_MANIFEST, async (cwd) => {
			const cli = createHoboCli({
				commands: { dev: createDevCommand({ runtime: makeDevRuntime() }) },
			});
			const result = await cli.run(["dev", "--json"], { cwd });
			// SAFETY: `const envelope = JSON.parse(result.stdout) as {` is required at this I/O or test boundary.
			const envelope = JSON.parse(result.stdout) as {
				status: string;
				data: {
					runtime: string;
					offline: boolean;
					served: { status: number; body: string };
					events: string[];
				};
			};
			expect(envelope.status).toBe(expected.status);
			expect(envelope.data.runtime).toBe(expected.runtime);
			expect(envelope.data.offline).toBe(expected.offline);
			expect(envelope.data.served).toEqual(expected.served);
			expect(envelope.data.events).toEqual(expected.events);
		});
	});
});
