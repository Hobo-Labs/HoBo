import { inMemoryState, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import {
	Agent37Runner,
	Agent37RunnerProvider,
	createAlchemyRunnerBackend,
	createInMemoryLocalRunnerRegistry,
	guardedHostingerRunnerTransport,
	HostingerRunner,
	HostingerRunnerProvider,
	isAllowedHostingerFleetRoute,
	LocalRunner,
	LocalRunnerProvider,
	parseOwnerCredentialLocator,
} from "../src/runners/index.js";

function runStack<Output, Req, LayerError>(
	stack: Alchemist.ConfiguredStack<Output, Req>,
	runtimeLayer: Layer.Layer<Alchemist.Services | Req, LayerError, never>,
	operation: "deploy" | "destroy",
) {
	return Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const plan = yield* Alchemist.plan({
					stack,
					stage: "test",
					operation,
				});
				return yield* Alchemist.apply(plan);
			}),
		).pipe(Effect.provide(runtimeLayer)),
	);
}

describe("Alchemy v2 runner providers", () => {
	it("enforces owner:// credential locators and rejects non-owner schemes", () => {
		expect(parseOwnerCredentialLocator("owner://HOSTINGER_API_KEY")).toBe(
			"owner://HOSTINGER_API_KEY",
		);
		const invalidScheme = ["e", "nv://HOSTINGER_API_KEY"].join("");
		expect(() => parseOwnerCredentialLocator(invalidScheme)).toThrow(
			"owner://<NAME>",
		);
		expect(() => parseOwnerCredentialLocator("http://example.test")).toThrow(
			"owner://<NAME>",
		);
	});

	it("reconciles HostingerRunner through allowed fleet routes with zero secret persistence", async () => {
		const observedHeaders: string[] = [];
		const observedUrls: string[] = [];
		const secretMaterial = "ephemeral-hostinger-credential-value";
		const stateRecords: NonNullable<Parameters<typeof inMemoryState>[0]> = {};
		const state = inMemoryState(stateRecords);
		const providers = HostingerRunnerProvider({
			resolveCredential: async (locator) => {
				expect(locator).toBe("owner://HOSTINGER_FLEET");
				return secretMaterial;
			},
			transport: async (request) => {
				observedUrls.push(request.url);
				observedHeaders.push(request.headers.authorization ?? "");
				return {
					status: 200,
					body: {
						id: "42001",
						hostname: "runner-hv-1.hostinger",
						state: "running",
						actionId: "act-42001",
					},
				};
			},
		});
		const stack = Stack(
			"hostinger-fleet-test",
			{ providers, state },
			Effect.gen(function* () {
				const runner = yield* HostingerRunner("hv-1", {
					jobId: "job-hv-1",
					machineId: "42001",
					hostname: "runner-hv-1.hostinger",
					labels: ["hobo-fleet", "hostinger"],
					credentialLocator: "owner://HOSTINGER_FLEET",
				});
				return {
					runnerId: runner.runnerId,
					actionId: runner.actionId,
					credentialLocator: runner.credentialLocator,
				};
			}),
		);
		const runtimeLayer = Layer.merge(Alchemist.layer(), providers);
		const outputs = await runStack(stack, runtimeLayer, "deploy");
		expect(outputs).toEqual({
			runnerId: "hostinger:job-hv-1:42001",
			actionId: "act-42001",
			credentialLocator: "owner://HOSTINGER_FLEET",
		});
		expect(observedUrls).toEqual([
			"https://developers.hostinger.com/api/vps/v1/virtual-machines/42001/start",
		]);
		expect(observedHeaders).toEqual([`Bearer ${secretMaterial}`]);
		expect(JSON.stringify(stateRecords)).not.toContain(secretMaterial);
	});

	it("refuses Hostinger fleet routes that only match pathname on a foreign host or carry userinfo", () => {
		expect(
			isAllowedHostingerFleetRoute(
				"POST",
				"https://evil.example.test/api/vps/v1/virtual-machines/99/start",
			),
		).toBe(false);
		expect(
			isAllowedHostingerFleetRoute(
				"POST",
				"https://token:secret@developers.hostinger.com/api/vps/v1/virtual-machines/99/start",
			),
		).toBe(false);
	});

	it("refuses non-fleet Hostinger routes before transport execution", async () => {
		expect(
			isAllowedHostingerFleetRoute(
				"GET",
				"https://developers.hostinger.com/api/vps/v1/virtual-machines",
			),
		).toBe(true);
		expect(
			isAllowedHostingerFleetRoute(
				"POST",
				"https://developers.hostinger.com/api/vps/v1/virtual-machines/99/restart",
			),
		).toBe(true);
		expect(
			isAllowedHostingerFleetRoute(
				"POST",
				"https://developers.hostinger.com/api/vps/v1/virtual-machines/99/recreate",
			),
		).toBe(false);
		expect(
			isAllowedHostingerFleetRoute(
				"POST",
				"https://developers.hostinger.com/api/billing/v1/orders",
			),
		).toBe(false);

		let calls = 0;
		const transport = guardedHostingerRunnerTransport(async () => {
			calls++;
			return { status: 200, body: {} };
		});
		await expect(
			transport({
				method: "POST",
				url: "https://developers.hostinger.com/api/vps/v1/virtual-machines/99/recreate",
				headers: {},
			}),
		).rejects.toThrow("hostinger runner route refused");
		expect(calls).toBe(0);
	});

	it("provisions and destroys Agent37Runner and LocalRunner via Alchemy Stacks without leaking secrets", async () => {
		const secretMaterial = "ephemeral-agent37-credential-value";
		const deletedSandboxes: string[] = [];
		const localRegistry = createInMemoryLocalRunnerRegistry();
		const stateRecords: NonNullable<Parameters<typeof inMemoryState>[0]> = {};
		const state = inMemoryState(stateRecords);
		const providers = Layer.merge(
			Agent37RunnerProvider({
				resolveCredential: async () => secretMaterial,
				client: {
					createSandbox: async (input) => {
						expect(input.authorizationHeader).toBe(`Bearer ${secretMaterial}`);
						return {
							sandboxId: "sbx-101",
							status: "running",
							endpointUrl: "https://sbx-101.agent37.invalid",
						};
					},
					deleteSandbox: async (input) => {
						deletedSandboxes.push(input.sandboxId);
					},
				},
			}),
			LocalRunnerProvider(localRegistry),
		);
		const stack = Stack(
			"mixed-runners-test",
			{ providers, state },
			Effect.gen(function* () {
				const local = yield* LocalRunner("mac-studio", {
					machineId: "mac-studio",
					jobId: "job-mac-studio",
					labels: ["hobo-fleet", "local"],
					maxConcurrency: 2,
				});
				const agent37 = yield* Agent37Runner("burst-1", {
					name: "burst-1",
					template: "ubuntu-runner",
					instanceType: "vm",
					region: "us",
					cpu: 4,
					memoryGb: 8,
					labels: ["hobo-fleet", "agent37"],
					credentialLocator: "owner://AGENT37_FLEET",
				});
				return {
					localId: local.runnerId,
					agent37Id: agent37.runnerId,
				};
			}),
		);
		const runtimeLayer = Layer.merge(Alchemist.layer(), providers);
		const deployed = await runStack(stack, runtimeLayer, "deploy");
		expect(deployed).toEqual({
			localId: "local:job-mac-studio",
			agent37Id: "agent37:sbx-101",
		});
		expect(localRegistry.activeRunnerIds()).toEqual(["local:job-mac-studio"]);
		expect(JSON.stringify(stateRecords)).not.toContain(secretMaterial);

		await runStack(stack, runtimeLayer, "destroy");
		expect(localRegistry.activeRunnerIds()).toEqual([]);
		expect(deletedSandboxes).toEqual(["sbx-101"]);
	});

	it("enforces local pool maxConcurrency without allowing a second job when the pool is full", async () => {
		const localRegistry = createInMemoryLocalRunnerRegistry();
		const backend = createAlchemyRunnerBackend({
			local: { registry: localRegistry, maxConcurrency: 1 },
		});
		const first = await backend.provisionRunner({
			jobId: "job-a",
			poolId: "shared-pool",
			tier: "local",
			label: "hobo-fleet",
		});
		expect(first.runnerId).toBe("local:job-a");
		await expect(
			backend.provisionRunner({
				jobId: "job-b",
				poolId: "shared-pool",
				tier: "local",
				label: "hobo-fleet",
			}),
		).rejects.toThrow("exceeded maxConcurrency");
		await backend.releaseRunner({ runnerId: first.runnerId, tier: "local" });
		const second = await backend.provisionRunner({
			jobId: "job-b",
			poolId: "shared-pool",
			tier: "local",
			label: "hobo-fleet",
		});
		expect(second.runnerId).toBe("local:job-b");
		await backend.releaseRunner({ runnerId: second.runnerId, tier: "local" });
	});

	it("bridges runner tiers through createAlchemyRunnerBackend with jobId-keyed ids and refuses unconfigured github", async () => {
		const localRegistry = createInMemoryLocalRunnerRegistry();
		const deletedSandboxes: string[] = [];
		const backend = createAlchemyRunnerBackend({
			local: { registry: localRegistry, maxConcurrency: 2 },
			hostinger: {
				machineIdForPool: () => "77001",
				credentialLocator: "owner://HOSTINGER_FLEET",
				resolveCredential: () => "hostinger-key",
				transport: async () => ({
					status: 200,
					body: { id: "77001", state: "running", actionId: "act-77" },
				}),
			},
			agent37: {
				template: "ci-runner",
				instanceType: "default",
				region: "us",
				cpu: 2,
				memoryGb: 4,
				credentialLocator: "owner://AGENT37_FLEET",
				resolveCredential: () => "agent37-key",
				client: {
					createSandbox: async () => ({
						sandboxId: "sbx-77",
						status: "running",
						endpointUrl: "https://sbx-77.agent37.invalid",
					}),
					deleteSandbox: async ({ sandboxId }) => {
						deletedSandboxes.push(sandboxId);
					},
				},
			},
		});

		const localRunner = await backend.provisionRunner({
			jobId: "job-1",
			poolId: "local-box",
			tier: "local",
			label: "hobo-fleet",
		});
		const hostingerRunner = await backend.provisionRunner({
			jobId: "job-2",
			poolId: "hv-box",
			tier: "hostinger",
			label: "hobo-fleet",
		});
		const agent37Runner = await backend.provisionRunner({
			jobId: "job-3",
			poolId: "a37-box",
			tier: "agent37",
			label: "hobo-fleet",
		});
		expect(localRunner.runnerId).toBe("local:job-1");
		expect(hostingerRunner.runnerId).toBe("hostinger:job-2:77001");
		expect(agent37Runner.runnerId).toBe("agent37:sbx-77");
		await expect(
			backend.provisionRunner({
				jobId: "job-4",
				poolId: "gh-ubuntu",
				tier: "github",
				label: "ubuntu-latest",
			}),
		).rejects.toThrow("github runner provider not configured");

		const concurrentLocal = await backend.provisionRunner({
			jobId: "job-5",
			poolId: "local-box",
			tier: "local",
			label: "hobo-fleet",
		});
		expect(concurrentLocal.runnerId).toBe("local:job-5");
		expect(localRegistry.activeRunnerIds().sort()).toEqual([
			"local:job-1",
			"local:job-5",
		]);

		await backend.releaseRunner({
			runnerId: localRunner.runnerId,
			tier: "local",
		});
		expect(localRegistry.activeRunnerIds()).toEqual(["local:job-5"]);
		await backend.releaseRunner({
			runnerId: concurrentLocal.runnerId,
			tier: "local",
		});
		await backend.releaseRunner({
			runnerId: agent37Runner.runnerId,
			tier: "agent37",
		});
		expect(localRegistry.activeRunnerIds()).toEqual([]);
		expect(deletedSandboxes).toEqual(["sbx-77"]);
	});

	it("reconciles Agent37 orphan sandboxes with the same name before and after provision", async () => {
		const deletedSandboxes: string[] = [];
		const listedSandboxes = [
			{ sandboxId: "sbx-orphan", name: "burst-1" },
			{ sandboxId: "sbx-other", name: "other" },
		];
		const stateRecords: NonNullable<Parameters<typeof inMemoryState>[0]> = {};
		const state = inMemoryState(stateRecords);
		const providers = Agent37RunnerProvider({
			resolveCredential: async () => "agent37-key",
			client: {
				createSandbox: async () => ({
					sandboxId: "sbx-fresh",
					status: "running",
					endpointUrl: "https://sbx-fresh.agent37.invalid",
				}),
				deleteSandbox: async ({ sandboxId }) => {
					deletedSandboxes.push(sandboxId);
				},
				listSandboxes: async () => listedSandboxes,
			},
		});
		const runtimeLayer = Layer.merge(Alchemist.layer(), providers);
		const initialStack = Stack(
			"agent37-orphan-reconcile",
			{ providers, state },
			Effect.gen(function* () {
				const runner = yield* Agent37Runner("burst-1", {
					name: "burst-1",
					template: "ubuntu-runner",
					instanceType: "vm",
					region: "us",
					cpu: 4,
					memoryGb: 8,
					labels: ["hobo-fleet"],
					credentialLocator: "owner://AGENT37_FLEET",
				});
				return { runnerId: runner.runnerId };
			}),
		);
		const replacedStack = Stack(
			"agent37-orphan-reconcile",
			{ providers, state },
			Effect.gen(function* () {
				const runner = yield* Agent37Runner("burst-1", {
					name: "burst-1",
					template: "ubuntu-runner",
					instanceType: "performance",
					region: "us",
					cpu: 8,
					memoryGb: 16,
					labels: ["hobo-fleet"],
					credentialLocator: "owner://AGENT37_FLEET",
				});
				return { runnerId: runner.runnerId };
			}),
		);
		const initial = await runStack(initialStack, runtimeLayer, "deploy");
		expect(initial.runnerId).toBe("agent37:sbx-fresh");
		expect(deletedSandboxes).toContain("sbx-orphan");
		const replaced = await runStack(replacedStack, runtimeLayer, "deploy");
		expect(replaced.runnerId).toBe("agent37:sbx-fresh");
		expect(deletedSandboxes.filter((id) => id === "sbx-fresh").length).toBe(1);
	});
});
