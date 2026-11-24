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
			runnerId: "hostinger:42001",
			actionId: "act-42001",
			credentialLocator: "owner://HOSTINGER_FLEET",
		});
		expect(observedUrls).toEqual([
			"https://developers.hostinger.com/api/vps/v1/virtual-machines/42001/start",
		]);
		expect(observedHeaders).toEqual([`Bearer ${secretMaterial}`]);
		expect(JSON.stringify(stateRecords)).not.toContain(secretMaterial);
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
			localId: "local:mac-studio",
			agent37Id: "agent37:sbx-101",
		});
		expect(localRegistry.activeRunnerIds()).toEqual(["local:mac-studio"]);
		expect(JSON.stringify(stateRecords)).not.toContain(secretMaterial);

		await runStack(stack, runtimeLayer, "destroy");
		expect(localRegistry.activeRunnerIds()).toEqual([]);
		expect(deletedSandboxes).toEqual(["sbx-101"]);
	});

	it("bridges all four runner tiers through createAlchemyRunnerBackend", async () => {
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
		const githubRunner = await backend.provisionRunner({
			jobId: "job-4",
			poolId: "gh-ubuntu",
			tier: "github",
			label: "ubuntu-latest",
		});

		expect(localRunner.runnerId).toBe("local:local-box");
		expect(hostingerRunner.runnerId).toBe("hostinger:77001");
		expect(agent37Runner.runnerId).toBe("agent37:sbx-77");
		expect(githubRunner.runnerId).toBe("github:gh-ubuntu:job-4");

		await backend.releaseRunner({
			runnerId: localRunner.runnerId,
			tier: "local",
		});
		await backend.releaseRunner({
			runnerId: agent37Runner.runnerId,
			tier: "agent37",
		});
		expect(localRegistry.activeRunnerIds()).toEqual([]);
		expect(deletedSandboxes).toEqual(["sbx-77"]);
	});
});
