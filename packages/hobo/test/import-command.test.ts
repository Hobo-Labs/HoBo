import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CliContext } from "@hobo/cli";
import { deploymentIdFor } from "@hobo/cli";
import { collectStream } from "@hobo/cloud";
import {
	createInMemoryStateBackend,
	createPulumiAutomationAdapter,
} from "@hobo/iac-pulumi";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AdoptedResourceEntry,
	createComposedHoboCli,
	createDefaultYardRuntime,
	createImportCommand,
	type PulumiAutomationAdapter,
	RESOURCE_ADOPTED_EVENT,
} from "../src/index.js";
import { isJsonObject, type JsonObject } from "../src/json.js";

interface AdoptedResourceMap {
	[name: string]: AdoptedResourceEntry;
}

// `hobo import` adopts an existing estate in place: it DISCOVERS the resources
// the IaC state backend actually holds (per-resource stacks + outputs), merges
// them with the project's declared Bindle into one adopted manifest, and
// records the adoption as durable facts (`deployment.Imported` + one
// `resource.Adopted` per discovered resource) — no provisioning runs. The
// DeploymentView then reflects the adopted deployment as deployed/imported.

const HELLO_BINDLE = {
	schema: "hobo.manifest/v1",
	componentHost: { kind: "wasmtime", version: "1.0.0" },
	resources: {
		service: {
			type: "component.v1",
			image: "oci://registry.example.com/hello-bindle@sha256:abc123",
			runtime: "wasm",
			exports: ["wasi:http/incoming-handler"],
			bind: ["sessions"],
		},
		sessions: { type: "data.v1", port: "kv" },
	},
};

let openStores: RuntimeLocalEventStore[] = [];
afterEach(() => {
	for (const store of openStores) store.close();
	openStores = [];
});

async function withProject(
	callback: (cwd: string) => Promise<void>,
	writeManifest = true,
): Promise<void> {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-import-"));
	if (writeManifest) {
		await writeFile(
			path.join(dir, "hobo.bindle.json"),
			`${JSON.stringify(HELLO_BINDLE, null, 2)}\n`,
		);
	}
	try {
		await callback(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

// biome-ignore lint/suspicious/noExplicitAny: test-only envelope reader.
function envelope(stdout: string): any {
	return JSON.parse(stdout);
}

function runInput(cwd: string) {
	return {
		// SAFETY: assertion required at this I/O or test boundary.
		context: { cwd, projectDir: cwd } as CliContext,
		// SAFETY: assertion required at this I/O or test boundary.
		flags: { cwd } as never,
		// SAFETY: assertion required at this I/O or test boundary.
		args: [] as readonly string[],
		verb: "import",
		emitProgress: () => {},
	};
}

// Seed an in-memory state backend with an already-provisioned estate for the
// given deployment, and hand back the adapter reading it.
function seededAdapter(
	deploymentId: string,
	resources: Record<string, JsonObject>,
): PulumiAutomationAdapter {
	const stateBackend = createInMemoryStateBackend();
	for (const [name, outputs] of Object.entries(resources)) {
		stateBackend.write(`${deploymentId}/${name}`, {
			resources: {
				[name]: {
					id: `pulumi:stack:${name}`,
					status: "provisioned",
					outputs,
					specHash: "seeded",
				},
			},
		});
	}
	// SAFETY: assertion required at this I/O or test boundary.
	return createPulumiAutomationAdapter({
		stateBackend,
	}) as PulumiAutomationAdapter;
}

describe("createImportCommand", () => {
	it("adopts the declared estate without provisioning, and inspect sees it", async () => {
		await withProject(async (cwd) => {
			const runtime = createDefaultYardRuntime();
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const cli = createComposedHoboCli({ yardRuntime: runtime });

			const imported = envelope(
				(await cli.run(["import", "--json"], { cwd })).stdout,
			);
			expect(imported.code).not.toBe("HOBO_CLI_STUB");
			expect(imported.ok).toBe(true);
			expect(imported.status).toBe("imported");
			expect(imported.data.imported).toBe(true);
			expect(imported.data.deploymentStatus).toBe("deployed");
			expect(imported.data.bindleHash).toMatch(/^sha256:/);
			expect(Object.keys(imported.data.resources).sort()).toEqual([
				"service",
				"sessions",
			]);

			// inspect now operates on the adopted deployment.
			const inspect = envelope(
				(await cli.run(["inspect", "--json"], { cwd })).stdout,
			);
			expect(inspect.status).toBe("deployed");
			expect(Object.keys(inspect.data.resources).sort()).toEqual([
				"service",
				"sessions",
			]);
		});
	});

	it("discovers the estate the state backend holds and adopts it alongside the declared bindle", async () => {
		await withProject(async (cwd) => {
			const deploymentId = deploymentIdFor(cwd);
			const adapter = seededAdapter(deploymentId, {
				"legacy-db": { endpoint: "postgres://legacy-db.internal:5432/shop" },
			});
			const runtime = createDefaultYardRuntime({ iacAdapter: adapter });
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);

			const command = createImportCommand({ runtime, adapter });
			const result = await command.run(runInput(cwd));

			expect(result.ok).toBe(true);
			expect(result.status).toBe("imported");
			// SAFETY: assertion required at this I/O or test boundary.
			const data = result.data as {
				discovered: string[];
				declared: string[];
				resources: Record<string, string>;
				adoptedManifest: {
					resources: AdoptedResourceMap;
				};
			};
			expect(data.discovered).toEqual(["legacy-db"]);
			expect(data.declared).toEqual(["service", "sessions"]);
			expect(Object.keys(data.resources).sort()).toEqual([
				"legacy-db",
				"service",
				"sessions",
			]);

			// The adopted manifest merges declared entries (as-is) with an
			// adopt-in-place entry per discovered resource, carrying its outputs.
			// SAFETY: assertion required at this I/O or test boundary.
			const adopted = data.adoptedManifest.resources[
				"legacy-db"
			] as AdoptedResourceEntry;
			expect(adopted.type).toBe("adopted.v1");
			expect(adopted.adopted).toBe(true);
			expect(adopted.externalId).toBe("pulumi:stack:legacy-db");
			expect(adopted.outputs).toEqual({
				endpoint: "postgres://legacy-db.internal:5432/shop",
			});

			// The adoption is a durable per-resource fact.
			const events = await collectStream(
				runtime.store,
				`deployment:${deploymentId}`,
			);
			const adoptions = events.filter((e) => e.type === RESOURCE_ADOPTED_EVENT);
			expect(adoptions.length).toBe(1);
			const adoptedFact = adoptions[0]?.data;
			expect(
				isJsonObject(adoptedFact) && adoptedFact.resource === "legacy-db",
			).toBe(true);
			expect(
				isJsonObject(adoptedFact) ? adoptedFact.lifecycle : undefined,
			).toEqual({
				reconcile: "drift-detect-only",
				destroy: "retain",
			});
		});
	});

	it("adopts a discovered estate even without a declared bindle (discovery-driven import)", async () => {
		await withProject(async (cwd) => {
			const deploymentId = deploymentIdFor(cwd);
			const adapter = seededAdapter(deploymentId, {
				"legacy-db": { endpoint: "postgres://legacy" },
				"legacy-bucket": { bucketName: "legacy" },
			});
			const runtime = createDefaultYardRuntime({ iacAdapter: adapter });
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);

			const command = createImportCommand({ runtime, adapter });
			const result = await command.run(runInput(cwd));

			expect(result.ok).toBe(true);
			expect(result.status).toBe("imported");
			// SAFETY: assertion required at this I/O or test boundary.
			const data = result.data as {
				discovered: string[];
				declared: string[];
				adoptedManifest: { resources: JsonObject };
			};
			expect(data.discovered.sort()).toEqual(["legacy-bucket", "legacy-db"]);
			expect(data.declared).toEqual([]);
			// The adopted manifest IS the estate — every entry came from discovery.
			expect(Object.keys(data.adoptedManifest.resources).sort()).toEqual([
				"legacy-bucket",
				"legacy-db",
			]);
		}, false);
	});

	it("is idempotent: a second import of a managed deployment is a no-op", async () => {
		await withProject(async (cwd) => {
			const runtime = createDefaultYardRuntime();
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const cli = createComposedHoboCli({ yardRuntime: runtime });

			await cli.run(["import", "--json"], { cwd });
			const again = envelope(
				(await cli.run(["import", "--json"], { cwd })).stdout,
			);
			expect(again.ok).toBe(true);
			expect(again.status).toBe("already_managed");
		});
	});

	it("errors when there is no Bindle and the backend holds no estate", async () => {
		await withProject(async (cwd) => {
			const runtime = createDefaultYardRuntime();
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const cli = createComposedHoboCli({ yardRuntime: runtime });

			const result = envelope(
				(await cli.run(["import", "--json"], { cwd })).stdout,
			);
			expect(result.ok).toBe(false);
			expect(result.code).toBe("HOBO_NO_BINDLE");
		}, false);
	});

	it("fails closed with a typed error when HOBO_PULUMI_LIVE=1 and the pulumi binary is missing", async () => {
		await withProject(async (cwd) => {
			const runtime = createDefaultYardRuntime();
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const command = createImportCommand({
				runtime,
				env: {
					HOBO_PULUMI_LIVE: "1",
					HOBO_PULUMI_BIN: "definitely-not-pulumi-xyz",
				},
			});
			const result = await command.run(runInput(cwd));
			expect(result.ok).toBe(false);
			expect(result.code).toBe("HOBO_PULUMI_UNAVAILABLE");
			// SAFETY: assertion required at this I/O or test boundary.
			expect((result.data as { engineCode: string }).engineCode).toBe(
				"pulumi-cli-missing",
			);
		});
	});

	it("reports unavailable when no runtime is wired", async () => {
		const result = await createImportCommand().run(runInput("/tmp"));
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_NO_RUNTIME");
	});
});
