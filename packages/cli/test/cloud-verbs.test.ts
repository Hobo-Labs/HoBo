import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	authorize,
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
import { afterEach, describe, expect, it } from "vitest";

import {
	createDownCommand,
	createHoboCli,
	createLoginCommand,
	createPlanCommand,
	createUpCommand,
	type YardRuntime,
} from "../src/index.js";
import { isJsonString, type JsonValue, parseJsonObject } from "../src/json.js";

// S2-08: the cloud verbs (login/plan/up/down) wired to the @hobo/cloud Yard
// through the shared yard-client seam. The mocked lane drives the gateway +
// orchestrator in-process against a runtime-local EventStore with an injected
// in-memory IacProvider — no real Cloudflare calls.

const HELLO_BINDLE = {
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

const UNSATISFIABLE_BINDLE = {
	schema: "hobo.manifest/v1",
	componentHost: { kind: "wasmtime", version: "1.0.0" },
	resources: {
		service: {
			type: "component.v1",
			image: "oci://registry.example.com/hello-bindle@sha256:abc123",
			runtime: "wasm",
			exports: ["wasi:http/incoming-handler"],
			bind: ["ledger"],
		},
		ledger: { type: "data.v1", port: "hobo:database" },
	},
};

let stores: RuntimeLocalEventStore[] = [];

afterEach(() => {
	for (const store of stores) store.close();
	stores = [];
});

// An in-memory IacProvider — the injected dev/test backend the Executor drives.
// It never touches a real cloud (mocked lane); apply returns a synthetic
// endpoint, destroy is a no-op.
function inMemoryIac(): IacProvider {
	return {
		id: "mock-local-container",
		async preview(program: IacProgram) {
			return { summary: `preview ${program.resourceId}`, changes: 1 };
		},
		async apply(program: IacProgram) {
			return { endpoint: `${program.resourceId}.local` };
		},
		async destroy() {
			/* local backend no-op */
		},
		async refresh() {
			return { drift: false, observed: {} };
		},
	};
}

function makeRuntime(): YardRuntime {
	const dir = path.join(
		tmpdir(),
		`hobo-cli-yard-${Math.random().toString(36).slice(2)}`,
	);
	const store = createRuntimeLocalEventStore({
		dataDir: dir,
		clock: createManualClock(),
	});
	stores.push(store);
	return {
		store,
		actorHost: createInMemoryActorHost(),
		executor: createInProcessExecutor({ iac: inMemoryIac() }),
		broker: createInProcessCredentialBroker(),
		registry: createRegistryFromProviders([createCloudflareProvider()]),
	};
}

async function withProject(
	manifest: JsonValue,
	callback: (cwd: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-cli-cloud-"));
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

describe("hobo plan wired to the Yard Planner", () => {
	it("renders the content-addressed DeploymentPlan for the hello-bindle", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const cli = createHoboCli({
				commands: { plan: createPlanCommand({ runtime: makeRuntime() }) },
			});
			const result = await cli.run(["plan", "--json"], { cwd });

			expect(result.exitCode).toBe(0);
			// SAFETY: `const envelope = JSON.parse(result.stdout) as {` is required at this I/O or test boundary.
			const envelope = JSON.parse(result.stdout) as {
				ok: boolean;
				verb: string;
				status: string;
				data: {
					planHash: string;
					dependencyOrder: string[];
					resources: Array<{ name: string }>;
				};
			};
			expect(envelope.ok).toBe(true);
			expect(envelope.verb).toBe("plan");
			expect(envelope.status).toBe("ok");
			expect(envelope.data.planHash).toMatch(/^sha256:/);
			expect(envelope.data.dependencyOrder).toEqual([
				"assets",
				"sessions",
				"service",
			]);
			expect(envelope.data.resources.map((r) => r.name)).toEqual([
				"assets",
				"service",
				"sessions",
			]);
		});
	});

	it("exits non-zero with machine-readable remediation on a rejected plan", async () => {
		await withProject(UNSATISFIABLE_BINDLE, async (cwd) => {
			const cli = createHoboCli({
				commands: { plan: createPlanCommand({ runtime: makeRuntime() }) },
			});
			const result = await cli.run(["plan", "--json"], { cwd });

			expect(result.exitCode).toBe(1);
			// SAFETY: `const envelope = JSON.parse(result.stdout) as {` is required at this I/O or test boundary.
			const envelope = JSON.parse(result.stdout) as {
				ok: boolean;
				code: string;
				remediation: string[];
				data: { remediations: Array<{ resource: string; code: string }> };
			};
			expect(envelope.ok).toBe(false);
			expect(envelope.code).toBe("HOBO_PLAN_REJECTED");
			expect(envelope.remediation.length).toBeGreaterThanOrEqual(1);
			expect(envelope.data.remediations[0]?.resource).toBe("ledger");
			expect(envelope.data.remediations[0]?.code).toBe(
				"capability.port-unavailable",
			);
		});
	});

	it("falls back to the shell stub when no runtime is injected", async () => {
		await withProject({ name: "snapshop" }, async (cwd) => {
			const result = await createHoboCli().run(["plan", "--json"], { cwd });
			// SAFETY: `const envelope = JSON.parse(result.stdout) as {` is required at this I/O or test boundary.
			const envelope = JSON.parse(result.stdout) as {
				status: string;
				code: string;
			};
			expect(envelope.status).toBe("not_implemented");
			expect(envelope.code).toBe("HOBO_CLI_STUB");
		});
	});
});

describe("hobo login establishes a Yard session the gateway accepts", () => {
	it("mints a fixture principal accepted by gateway.authorize and persists it", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const cli = createHoboCli({ commands: { login: createLoginCommand() } });
			const result = await cli.run(["login", "--json"], { cwd });

			expect(result.exitCode).toBe(0);
			// SAFETY: `const envelope = JSON.parse(result.stdout) as {` is required at this I/O or test boundary.
			const envelope = JSON.parse(result.stdout) as {
				ok: boolean;
				data: {
					token: string;
					principal: { kind: string; id: string };
					sessionFile: string;
				};
			};
			expect(envelope.ok).toBe(true);
			expect(envelope.data.token).toMatch(/^hobo-svid-/);
			// SAFETY: `expect(authorize(envelope.data.principal as never).allowed).toBe(true);` is required at this I/O or test boundary.
			expect(authorize(envelope.data.principal as never).allowed).toBe(true);

			// SAFETY: `const persisted = JSON.parse(` is required at this I/O or test boundary.
			const persisted = JSON.parse(
				await readFile(envelope.data.sessionFile, "utf8"),
			) as {
				token: string;
			};
			expect(persisted.token).toBe(envelope.data.token);
		});
	});
});

describe("hobo up drives the in-process Yard to deployment.Deployed", () => {
	it("provisions every resource and reports the deployed set", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const cli = createHoboCli({
				commands: { up: createUpCommand({ runtime: makeRuntime() }) },
			});
			const result = await cli.run(["up", "--json"], { cwd });

			expect(result.exitCode).toBe(0);
			// SAFETY: `const envelope = JSON.parse(result.stdout) as {` is required at this I/O or test boundary.
			const envelope = JSON.parse(result.stdout) as {
				ok: boolean;
				status: string;
				data: {
					planHash: string;
					provisioned: string[];
					progress: Array<{ type: string; resourceId?: string }>;
				};
			};
			expect(envelope.ok).toBe(true);
			expect(envelope.status).toBe("deployed");
			expect(envelope.data.provisioned).toEqual([
				"assets",
				"service",
				"sessions",
			]);
			const provisionedEvents = envelope.data.progress.filter(
				(p) => p.type === "resource.Provisioned",
			);
			expect(provisionedEvents.length).toBe(3);
		});
	});
});

describe("hobo down drives the compensation/destroy path to Destroyed", () => {
	it("tears down every provisioned resource after up on a shared runtime", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const runtime = makeRuntime();
			const cli = createHoboCli({
				commands: {
					up: createUpCommand({ runtime }),
					down: createDownCommand({ runtime }),
				},
			});

			const up = await cli.run(["up", "--json"], { cwd });
			expect(JSON.parse(up.stdout).status).toBe("deployed");

			const down = await cli.run(["down", "--json"], { cwd });
			expect(down.exitCode).toBe(0);
			// SAFETY: `const envelope = JSON.parse(down.stdout) as {` is required at this I/O or test boundary.
			const envelope = JSON.parse(down.stdout) as {
				ok: boolean;
				status: string;
				data: { destroyed: string[] };
			};
			expect(envelope.ok).toBe(true);
			expect(envelope.status).toBe("destroyed");
			expect([...envelope.data.destroyed].sort()).toEqual([
				"assets",
				"service",
				"sessions",
			]);
			// Dependents tear down before their dependencies.
			expect(envelope.data.destroyed.indexOf("service")).toBeLessThan(
				envelope.data.destroyed.indexOf("sessions"),
			);
		});
	});
});

describe("cloud verbs emit valid JSON envelopes end to end", () => {
	it("login -> plan -> up -> down all round-trip through one shared runtime", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const runtime = makeRuntime();
			const cli = createHoboCli({
				commands: {
					login: createLoginCommand(),
					plan: createPlanCommand({ runtime }),
					up: createUpCommand({ runtime }),
					down: createDownCommand({ runtime }),
				},
			});

			for (const verb of ["login", "plan", "up", "down"]) {
				const result = await cli.run([verb, "--json"], { cwd });
				// SAFETY: `const envelope = JSON.parse(result.stdout) as {` is required at this I/O or test boundary.
				const envelope = parseJsonObject(result.stdout);
				expect(envelope.verb).toBe(verb);
				expect(isJsonString(envelope.status)).toBe(true);
			}
		});
	});
});
