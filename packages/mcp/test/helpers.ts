import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createDownCommand,
	createHoboCli,
	createLoginCommand,
	createPlanCommand,
	createUpCommand,
	type HoboCli,
	type YardRuntime,
} from "@hobo/cli";
import {
	createInProcessCredentialBroker,
	createInProcessExecutor,
	createRegistryFromProviders,
	type IacProgram,
	type IacProvider,
} from "@hobo/cloud";
import { createInMemoryActorHost } from "@hobo/data";
import { createCloudflareProvider } from "@hobo/provider-cloudflare";
import {
	createManualClock,
	createRuntimeLocalEventStore,
	type RuntimeLocalEventStore,
} from "@hobo/runtime-local";
import type { AuthContext } from "../src/auth.js";
import type { JsonValue } from "../src/json.js";
import { MCP_TOOL_CALL_VERB, MCP_TOOL_PORT } from "../src/tool-surface.js";

export const HELLO_BINDLE = {
	schema: "hobo.manifest/v1",
	componentHost: { kind: "wasmtime", version: "1.0.0" },
	resources: {
		service: {
			type: "component.v1",
			image: "oci://registry.example.com/hello-bindle@sha256:abc123",
			runtime: "wasm",
			exports: ["wasi:http/incoming-handler"],
			bind: ["sessions", "assets"],
		},
		sessions: { type: "data.v1", port: "kv" },
		assets: { type: "data.v1", port: "objectStore" },
	},
};

const openStores: RuntimeLocalEventStore[] = [];

export function closeStores(): void {
	for (const store of openStores) store.close();
	openStores.length = 0;
}

function inMemoryIac(): IacProvider {
	return {
		id: "mock-local-container",
		async preview(program: IacProgram) {
			return { summary: `preview ${program.resourceId}`, changes: 1 };
		},
		async apply(program: IacProgram) {
			return { endpoint: `${program.resourceId}.local` };
		},
		async destroy() {},
		async refresh() {
			return { drift: false, observed: {} };
		},
	};
}

export function makeRuntime(): YardRuntime {
	const dir = path.join(
		tmpdir(),
		`hobo-mcp-yard-${Math.random().toString(36).slice(2)}`,
	);
	const store = createRuntimeLocalEventStore({
		dataDir: dir,
		clock: createManualClock(),
	});
	openStores.push(store);
	return {
		store,
		actorHost: createInMemoryActorHost(),
		executor: createInProcessExecutor({ iac: inMemoryIac() }),
		broker: createInProcessCredentialBroker(),
		registry: createRegistryFromProviders([createCloudflareProvider()]),
	};
}

export function makeWiredCli(runtime = makeRuntime()): HoboCli {
	return createHoboCli({
		commands: {
			login: createLoginCommand(),
			plan: createPlanCommand({ runtime }),
			up: createUpCommand({ runtime }),
			down: createDownCommand({ runtime }),
		},
	});
}

export async function withProject(
	manifest: JsonValue,
	callback: (cwd: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-mcp-project-"));
	await writeFile(
		path.join(dir, "hobo.bindle.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	try {
		await callback(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

export function authGranting(
	toolNames: readonly string[],
	overrides: { subject?: string; tenant?: string } = {},
): AuthContext {
	const subject = overrides.subject ?? "spiffe://yard/acme/agent/deployer";
	return {
		subject,
		tenant: overrides.tenant ?? "acme",
		principal: { kind: "agent", id: subject },
		scope: toolNames.map((name) => ({
			port: MCP_TOOL_PORT,
			resource: `tool:${name}`,
			verbs: [MCP_TOOL_CALL_VERB],
		})),
	};
}
