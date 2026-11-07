import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CliContext, YardRuntime } from "@hobo/cli";
import { DEFAULT_TENANT, deploymentIdFor } from "@hobo/cli";
import {
	collectStream,
	currentFenceToken,
	deploymentPlanned,
	deploymentViewProjection,
	hashDeploymentPlan,
} from "@hobo/cloud";
import { must } from "@hobo/core/total-access";
import {
	createInMemoryStateBackend,
	createPulumiAutomationAdapter,
} from "@hobo/iac-pulumi";
import type { RuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CloudflareFetch,
	type CloudflareFetchResponse,
	createComposedHoboCli,
	createDefaultYardRuntime,
	createDriftCommand,
	DRIFT_CHECKED_EVENT,
	DRIFT_DETECTED_EVENT,
	type PulumiAutomationAdapter,
} from "../src/index.js";
import { isJsonObject } from "../src/json.js";

// `hobo drift` — REAL drift detection: the declared bindle manifest's desired
// resources are compared against the state the IaC backend actually holds.
// On the Pulumi lanes the estate comes from the shared adapter's state backend
// (seeded by a prior `hobo up`); per-resource verdicts are missing / orphaned /
// diverged (the latter via a refresh through the engine seam). On the live
// Cloudflare lane the recorded DeploymentView is the held state and the REAL
// refresh (GET the Worker script) decides divergence. Every run appends
// `drift.Checked` (+ per-finding `drift.Detected`) facts to the durable log.

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

const CF_ENV = {
	CLOUDFLARE_API_TOKEN: "cf-tok",
	CLOUDFLARE_ACCOUNT_ID: "acct-1",
};

// A CloudflareFetch that answers a Worker-script GET with `scriptGetStatus`
// (200 = present/in-sync, 404 = deleted/drifted) and everything else with 2xx.
function cfFetch(scriptGetStatus: number): CloudflareFetch {
	return async (url, init): Promise<CloudflareFetchResponse> => {
		const isScriptGet =
			init.method === "GET" && /\/workers\/scripts\/[^/]+$/.test(url);
		const status = isScriptGet ? scriptGetStatus : 200;
		const ok = status >= 200 && status < 300;
		const body = url.endsWith("/workers/subdomain")
			? { result: { subdomain: "acme" }, success: true }
			: { success: ok, result: {} };
		return {
			ok,
			status,
			async text() {
				return JSON.stringify(body);
			},
			async json() {
				return body;
			},
		};
	};
}

let openStores: RuntimeLocalEventStore[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const store of openStores) store.close();
	openStores = [];
});

async function recordLegacyUnboundPlan(runtime: YardRuntime, cwd: string) {
	const deploymentId = deploymentIdFor(cwd);
	const stream = `deployment:${deploymentId}`;
	const snapshot = await deploymentViewProjection.rebuildFromZero(
		runtime.store,
		stream,
	);
	const row = deploymentViewProjection.get(snapshot, deploymentId);
	if (!row?.plan) throw new Error("fixture requires a stored deployment plan");
	const plan = {
		...row.plan,
		resources: row.plan.resources.map(
			({ productId: _productId, ...resource }) => resource,
		),
	};
	const events = await collectStream(runtime.store, stream);
	const fenceToken = currentFenceToken(runtime.store, stream);
	await runtime.store.append(
		stream,
		[
			deploymentPlanned({
				deploymentId,
				planHash: hashDeploymentPlan(plan),
				plan,
			}),
		],
		{
			expectedSeq: events.at(-1)?.seq ?? 0,
			actor: { kind: "system", id: "legacy-plan-fixture" },
			tenant: DEFAULT_TENANT,
			...(fenceToken !== undefined ? { fenceToken } : undefined),
		},
	);
}

async function withProject(
	callback: (cwd: string) => Promise<void>,
	writeManifest = true,
): Promise<void> {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-drift-"));
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

function runInput(cwd: string, emit: (m: string) => void = () => {}) {
	return {
		// SAFETY: assertion required at this I/O or test boundary.
		context: { cwd, projectDir: cwd } as CliContext,
		// SAFETY: assertion required at this I/O or test boundary.
		flags: { cwd } as never,
		// SAFETY: assertion required at this I/O or test boundary.
		args: [] as readonly string[],
		verb: "drift",
		emitProgress: emit,
	};
}

interface DriftData {
	checked: number;
	drifted: string[];
	missing: string[];
	orphaned: string[];
	diverged: string[];
	backend?: string;
	engineCode?: string;
}

describe("createDriftCommand", () => {
	it("reports in-sync on the in-memory lane after `hobo up` (declared == held state)", async () => {
		await withProject(async (cwd) => {
			const runtime = createDefaultYardRuntime();
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const cli = createComposedHoboCli({ yardRuntime: runtime });

			await cli.run(["up", "--json"], { cwd });
			// SAFETY: assertion required at this I/O or test boundary.
			const drift = JSON.parse(
				(await cli.run(["drift", "--json"], { cwd })).stdout,
			) as {
				ok: boolean;
				status: string;
				code?: string;
				data: DriftData;
			};

			expect(drift.code).not.toBe("HOBO_CLI_STUB");
			expect(drift.ok).toBe(true);
			expect(drift.status).toBe("in-sync");
			expect(drift.data.checked).toBe(2);
			expect(drift.data.drifted).toEqual([]);

			// The check is a durable fact on the deployment stream.
			const events = await collectStream(
				runtime.store,
				`deployment:${deploymentIdFor(cwd)}`,
			);
			const checked = events.filter((e) => e.type === DRIFT_CHECKED_EVENT);
			expect(checked.length).toBe(1);
			// SAFETY: assertion required at this I/O or test boundary.
			const checkedData = checked[0]?.data;
			expect(isJsonObject(checkedData) && checkedData.checked === 2).toBe(true);
		});
	});

	it("reports a declared-but-absent resource as missing", async () => {
		await withProject(async (cwd) => {
			const runtime = createDefaultYardRuntime();
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const cli = createComposedHoboCli({ yardRuntime: runtime });
			await cli.run(["up", "--json"], { cwd });

			// Declare one MORE resource than the estate holds.
			await writeFile(
				path.join(cwd, "hobo.bindle.json"),
				`${JSON.stringify(
					{
						...HELLO_BINDLE,
						resources: {
							...HELLO_BINDLE.resources,
							cache: { type: "data.v1", port: "kv" },
						},
					},
					null,
					2,
				)}\n`,
			);

			// SAFETY: assertion required at this I/O or test boundary.
			const drift = JSON.parse(
				(await cli.run(["drift", "--json"], { cwd })).stdout,
			) as { ok: boolean; status: string; data: DriftData };
			expect(drift.status).toBe("drifted");
			expect(drift.data.missing).toEqual(["cache"]);
			expect(drift.data.orphaned).toEqual([]);
			expect(drift.data.drifted).toContain("cache");
		});
	});

	it("reports a held-but-undeclared resource as orphaned", async () => {
		await withProject(async (cwd) => {
			const runtime = createDefaultYardRuntime();
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const cli = createComposedHoboCli({ yardRuntime: runtime });
			await cli.run(["up", "--json"], { cwd });

			// Remove `sessions` from the declaration; the estate still holds it.
			await writeFile(
				path.join(cwd, "hobo.bindle.json"),
				`${JSON.stringify(
					{
						...HELLO_BINDLE,
						resources: {
							service: {
								...HELLO_BINDLE.resources.service,
								bind: [],
							},
						},
					},
					null,
					2,
				)}\n`,
			);

			// SAFETY: assertion required at this I/O or test boundary.
			const drift = JSON.parse(
				(await cli.run(["drift", "--json"], { cwd })).stdout,
			) as { ok: boolean; status: string; data: DriftData };
			expect(drift.status).toBe("drifted");
			expect(drift.data.orphaned).toEqual(["sessions"]);
			expect(drift.data.missing).toEqual([]);

			// The finding is recorded as a drift.Detected fact.
			const events = await collectStream(
				runtime.store,
				`deployment:${deploymentIdFor(cwd)}`,
			);
			const detected = events.filter((e) => e.type === DRIFT_DETECTED_EVENT);
			expect(
				// SAFETY: assertion required at this I/O or test boundary.
				detected.map((e) => (e.data as { resource: string }).resource),
			).toContain("sessions");
			// SAFETY: assertion required at this I/O or test boundary.
			expect(detected.map((e) => (e.data as { kind: string }).kind)).toContain(
				"orphaned",
			);
		});
	});

	it("reports diverged when the held state no longer matches the stored plan", async () => {
		await withProject(async (cwd) => {
			const stateBackend = createInMemoryStateBackend();
			// SAFETY: assertion required at this I/O or test boundary.
			const adapter = createPulumiAutomationAdapter({
				stateBackend,
			}) as PulumiAutomationAdapter;
			const runtime = createDefaultYardRuntime({ iacAdapter: adapter });
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const cli = createComposedHoboCli({ yardRuntime: runtime });
			await cli.run(["up", "--json"], { cwd });

			// Tamper with the held state OUT OF BAND (the drift story): the stack
			// still exists but its record no longer matches the realized spec.
			const deploymentId = deploymentIdFor(cwd);
			const stackKey = `${deploymentId}/service`;
			// SAFETY: assertion required at this I/O or test boundary.
			const held = stateBackend.read(stackKey) as {
				resources: Record<string, { specHash?: string }>;
			};
			expect(held.resources.service).toBeDefined();
			must(held.resources.service, "held.resources.service").specHash =
				"sha256:tampered-out-of-band";
			stateBackend.write(stackKey, held);

			const command = createDriftCommand({ runtime, adapter });
			const result = await command.run(runInput(cwd));
			// SAFETY: assertion required at this I/O or test boundary.
			const data = result.data as DriftData;
			expect(result.ok).toBe(true);
			expect(result.status).toBe("drifted");
			expect(data.diverged).toEqual(["service"]);
			expect(data.missing).toEqual([]);
			expect(data.orphaned).toEqual([]);
		});
	});

	it("refuses to infer a native product from an old plan even when a Worker exists", async () => {
		await withProject(async (cwd) => {
			const runtime = createDefaultYardRuntime();
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const cli = createComposedHoboCli({ yardRuntime: runtime });
			await cli.run(["up", "--json"], { cwd });
			await recordLegacyUnboundPlan(runtime, cwd);
			const nativeFetch = vi
				.spyOn(globalThis, "fetch")
				.mockRejectedValue(
					new Error("unbound plan must not perform provider I/O"),
				);

			const command = createDriftCommand({
				runtime,
				env: CF_ENV,
				cloudflareFetch: cfFetch(200),
			});
			await expect(command.run(runInput(cwd))).rejects.toMatchObject({
				code: "RESOLVER_IAC_PRODUCT_UNDECIDED",
			});
			expect(nativeFetch).not.toHaveBeenCalled();
		});
	});

	it("does not turn an unrelated Worker 404 into retirement evidence for an unbound old plan", async () => {
		await withProject(async (cwd) => {
			const runtime = createDefaultYardRuntime();
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const cli = createComposedHoboCli({ yardRuntime: runtime });
			await cli.run(["up", "--json"], { cwd });
			await recordLegacyUnboundPlan(runtime, cwd);
			const nativeFetch = vi
				.spyOn(globalThis, "fetch")
				.mockRejectedValue(
					new Error("unbound plan must not perform provider I/O"),
				);

			const emitted: string[] = [];
			const command = createDriftCommand({
				runtime,
				env: CF_ENV,
				cloudflareFetch: cfFetch(404),
			});
			await expect(
				command.run(runInput(cwd, (message) => emitted.push(message))),
			).rejects.toMatchObject({ code: "RESOLVER_IAC_PRODUCT_UNDECIDED" });
			expect(emitted).toEqual([]);
			expect(nativeFetch).not.toHaveBeenCalled();
		});
	});

	it("reports no deployment when nothing has been deployed on the live lane", async () => {
		await withProject(async (cwd) => {
			const runtime = createDefaultYardRuntime();
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const command = createDriftCommand({
				runtime,
				env: CF_ENV,
				cloudflareFetch: cfFetch(200),
			});
			const result = await command.run(runInput(cwd));
			expect(result.ok).toBe(true);
			expect(result.status).toBe("no_deployment");
			// SAFETY: assertion required at this I/O or test boundary.
			expect((result.data as DriftData).checked).toBe(0);
		});
	});

	it("fails closed with a typed error when HOBO_PULUMI_LIVE=1 and the pulumi binary is missing", async () => {
		await withProject(async (cwd) => {
			const runtime = createDefaultYardRuntime();
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const command = createDriftCommand({
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
			expect((result.data as DriftData).backend).toBe("pulumi-live");
			// SAFETY: assertion required at this I/O or test boundary.
			expect((result.data as DriftData).engineCode).toBe("pulumi-cli-missing");
		});
	});

	it("errors when there is no bindle to compare against", async () => {
		await withProject(async (cwd) => {
			const runtime = createDefaultYardRuntime();
			// SAFETY: assertion required at this I/O or test boundary.
			openStores.push(runtime.store as RuntimeLocalEventStore);
			const command = createDriftCommand({ runtime });
			const result = await command.run(runInput(cwd));
			expect(result.ok).toBe(false);
			expect(result.code).toBe("HOBO_NO_BINDLE");
		}, false);
	});

	it("reports unavailable when no runtime is wired", async () => {
		const result = await createDriftCommand().run(runInput("/tmp"));
		expect(result.ok).toBe(false);
		expect(result.code).toBe("HOBO_NO_RUNTIME");
	});
});
