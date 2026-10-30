import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromJson } from "@bufbuild/protobuf";
import {
	type DeploymentPlan,
	HostingDestinationLiabilitySchema,
	type HostingOperationRequest,
	HostingTransitionAction,
	HostingTransitionPlanSchema,
	hashDeploymentPlan,
} from "@hobo/cloud";
import {
	createBoundedFetchTransport,
	type EventEnvelope,
	type HttpTransport,
	parseApplyResult,
	parseResolveRequest,
	parseResourceLifecycleObservation,
	parseRoutingPlan,
	parseRoutingStatus,
} from "@hobo/core";
import {
	CLOUDFLARE_WORKERS_PRODUCT_ID,
	cloudflareResolverRegistry,
} from "@hobo/provider-cloudflare";
import {
	RAILWAY_SERVICE_PRODUCT_ID,
	railwayResolverRegistry,
} from "@hobo/provider-railway";
import {
	createManualClock,
	createRuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import { createDurableHostingMutationJournal } from "../src/hosting-mutation-journal.js";
import { isJsonObject, isJsonString, parseJsonValue } from "../src/json.js";
import { prepareHostingProviderDesired } from "../src/provider-hosting-catalog.js";
import {
	createResolverHostingTransitionProvider,
	type HostingResourceLifecycleReader,
} from "../src/resolver-hosting-provider.js";

const dispose: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	while (dispose.length) await dispose.pop()?.();
});
async function fixture(
	options: {
		unsupportedSecond?: boolean;
		serving?: "match" | "wrong-health" | "wrong-route";
		railway?: "same-parent" | "distinct-parent" | "shared";
		nowMs?: () => number;
		verifyRoutingCredentialScope?: () => Promise<void>;
		signal?: AbortSignal;
	} = {},
) {
	const calls: { method: string; path: string }[] = [];
	const resources = new Set(["old-worker"]);
	const routingCalls: string[] = [];
	let healthArtifact = "";
	let sourceHealthArtifact = "";
	let healthCapability = "";
	const server = createServer((request, response) => {
		const path = request.url ?? "",
			method = request.method ?? "";
		calls.push({ method, path });
		if (method === "GET" && path.startsWith("/native/")) {
			const nativeId = decodeURIComponent(path.slice("/native/".length));
			response.end(
				JSON.stringify({
					tenantId: "tenant",
					providerId: "cloudflare",
					providerAccountId: "account",
					productId: CLOUDFLARE_WORKERS_PRODUCT_ID,
					resourceId: nativeId,
					physicalId: nativeId,
					operationId: request.headers["x-operation"],
					status: resources.has(nativeId) ? "ready" : "unknown",
					operationTerminal: resources.has(nativeId),
					observedAtMs: 1000,
					evidenceRef: `native:${nativeId}`,
					artifactDigest: `sha256:${createHash("sha256")
						.update(nativeId === "old-worker" ? "old" : "new")
						.digest("hex")}`,
					servingEndpoint:
						nativeId === "old-worker"
							? "https://old.fixture.test/"
							: "https://native.fixture.test/",
					settledMicros: 0,
				}),
			);
			return;
		}
		if (method === "GET" && (path === "/health" || path === "/source-health")) {
			response.end(
				JSON.stringify({
					healthy: true,
					tenantId: "tenant",
					artifactDigest:
						path === "/health" ? healthArtifact : sourceHealthArtifact,
					healthyBackends: 2,
					jurisdiction: "US",
					capabilityDigest: healthCapability,
				}),
			);
			return;
		}
		const parts = path.split("/"),
			name = decodeURIComponent(parts[parts.indexOf("scripts") + 1] ?? "");
		if (method === "GET" && path.endsWith("/settings")) {
			response.writeHead(resources.has(name) ? 200 : 404, {
				"content-type": "application/json",
			});
			response.end(
				JSON.stringify(
					resources.has(name)
						? { success: true, result: { id: name } }
						: {
								success: false,
								errors: [{ code: 10007, message: "not found" }],
							},
				),
			);
			return;
		}
		if (method === "PUT") {
			resources.add(name);
			response.end(JSON.stringify({ success: true, result: { id: name } }));
			return;
		}
		if (method === "DELETE") {
			resources.delete(name);
			response.end(JSON.stringify({ success: true, result: {} }));
			return;
		}
		response.writeHead(404);
		response.end();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	dispose.push(
		() =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	);
	const address = server.address();
	if (!address || isJsonString(address))
		throw new Error("missing fixture address");
	const bounded = createBoundedFetchTransport({ fetchImpl: globalThis.fetch });
	const transport: HttpTransport = (request) =>
		bounded({
			...request,
			url: `http://127.0.0.1:${address.port}${new URL(request.url).pathname}`,
		});
	const dataDir = mkdtempSync(join(tmpdir(), "resolver-hosting-"));
	dispose.push(() => rmSync(dataDir, { recursive: true, force: true }));
	const store = createRuntimeLocalEventStore({
		dataDir,
		clock: createManualClock(),
	});
	dispose.push(() => store.close());
	const context = {
		tenantId: "tenant",
		actor: { kind: "service", id: "worker" } as const,
		fenceToken: 1n,
	};
	const journal = createDurableHostingMutationJournal({
		...context,
		store,
		nowMs: () => 1000,
	});
	const source: DeploymentPlan = {
		schema: "hobo.deployment-plan/v1",
		objective: "min-cost",
		dependencyOrder: ["app"],
		resources: [
			{
				name: "app",
				provider: "cloudflare",
				port: "compute",
				productId: CLOUDFLARE_WORKERS_PRODUCT_ID,
				deps: [],
				realizationParameters: {
					script: "export default {fetch(){return new Response('old')}}",
				},
			},
		],
	};
	const target: DeploymentPlan = structuredClone(source);
	target.resources[0].realizationParameters = {
		script: "export default {fetch(){return new Response('new')}}",
	};
	if (options.unsupportedSecond) {
		target.resources.push({ ...target.resources[0], name: "unsupported" });
		target.dependencyOrder.push("unsupported");
	}
	if (options.railway) {
		source.resources[0] = {
			...source.resources[0],
			provider: "railway",
			productId: RAILWAY_SERVICE_PRODUCT_ID,
			realizationParameters: {
				serviceId: "service-old",
				deploymentId: "deployment-old",
			},
		};
		target.resources[0] = {
			...target.resources[0],
			provider: "railway",
			productId: RAILWAY_SERVICE_PRODUCT_ID,
			realizationParameters:
				options.railway === "shared"
					? { serviceId: "service-old", deploymentId: "deployment-old" }
					: {
							serviceId:
								options.railway === "same-parent"
									? "service-old"
									: "service-new",
							commitSha: "b".repeat(40),
						},
		};
	}
	const sourceHash = hashDeploymentPlan(source),
		targetHash = hashDeploymentPlan(target);
	const blueprint = fromJson(
		HostingTransitionPlanSchema,
		JSON.parse(
			readFileSync(
				new URL(
					"../../cloud/contracts/hosting-transition-fixtures/valid-plan.json",
					import.meta.url,
				),
				"utf8",
			),
		),
	);
	const plan = create(HostingTransitionPlanSchema, {
		...blueprint,
		sourcePlanId: sourceHash,
		targetPlanId: targetHash,
		deploymentId: "deploy",
		sourceIncarnationId: "prior-creation",
		planDigest: "",
	});
	if (!plan.commitment?.evidence) throw new Error("fixture evidence missing");
	plan.commitment.allocations[0].resourceName = "app";
	plan.commitment.allocations[0].quoteId = "funded";
	plan.commitment.allocations[0].providerCharges.push({
		$typeName: "hobo.cloud.hosting.v1.HostingProviderCharge",
		providerAccountId: "account",
		expectedMicros: 2,
		reservedMicros: 5,
	});
	plan.commitment.evidence.quotes = [
		{
			...plan.commitment.evidence.quotes[0],
			id: "funded",
			resourceName: "app",
			providerId: "cloudflare",
			providerAccountId: "account",
		},
	];
	healthArtifact = targetHash;
	sourceHealthArtifact = sourceHash;
	healthCapability = plan.constraints?.requiredCapabilityDigest ?? "";
	const routePlan = (name: string, endpoint: string) => {
		const backends = [{ id: `backend-${name}`, service: "app", endpoint }];
		return parseRoutingPlan({
			planId: `route:${name}`,
			createdAt: "2026-10-30T00:00:00Z",
			backends,
			intent: {
				service: "app",
				tenantId: "tenant",
				rules: [{ backends, weightStrategy: "static" }],
			},
		});
	};
	const sourceRoute = routePlan("source", "https://old.fixture.test/");
	const targetRoute = routePlan(
		"target",
		options.serving === "wrong-route"
			? "https://foreign.fixture.test/"
			: "https://native.fixture.test/",
	);
	const nativeLiability = create(HostingDestinationLiabilitySchema, {
		resourceName: "app",
		providerId: "cloudflare",
		providerAccountId: "account",
		artifactDigest: `sha256:${createHash("sha256").update("new").digest("hex")}`,
		mode: "provider-funded-zero",
		evidenceRef: "provider-funded-entitlement:fixture",
	});
	const nativeSourceLiability = create(HostingDestinationLiabilitySchema, {
		...nativeLiability,
		artifactDigest: `sha256:${createHash("sha256").update("old").digest("hex")}`,
		evidenceRef: "provider-funded-entitlement:source-fixture",
	});
	plan.sourceLiabilities = [structuredClone(nativeSourceLiability)];
	plan.destinationLiabilities = [structuredClone(nativeLiability)];
	if (options.unsupportedSecond)
		plan.destinationLiabilities.push({
			...nativeLiability,
			resourceName: "unsupported",
		});
	const nativeLiabilityState = { finalized: true };
	const provider = createResolverHostingTransitionProvider({
		store,
		context,
		mutationJournal: journal,
		artifacts: new Map([
			[sourceHash, source],
			[targetHash, target],
		]),
		resourceArtifacts: new Map([
			[
				sourceHash,
				new Map([
					["app", `sha256:${createHash("sha256").update("old").digest("hex")}`],
				]),
			],
			[
				targetHash,
				new Map([
					["app", `sha256:${createHash("sha256").update("new").digest("hex")}`],
				]),
			],
		]),
		resourceIdentities: new Map([
			[
				sourceHash,
				new Map([
					[
						"app",
						parseResolveRequest({
							ref: {
								slot: "service",
								productId: CLOUDFLARE_WORKERS_PRODUCT_ID,
								logicalId: "old-worker",
								physicalId: "old-worker",
							},
							desired: {},
							credentialRef: "env://cloudflare",
						}).ref,
					],
				]),
			],
		]),
		providers: new Map([
			[
				source.resources[0].provider,
				{
					prepareDesired: (input) =>
						prepareHostingProviderDesired("cloudflare", input),
					registry: options.railway
						? railwayResolverRegistry({
								projectId: "11111111-1111-1111-1111-111111111111",
								environmentId: "22222222-2222-2222-2222-222222222222",
								resolveCredential: async () => "fixture-token",
							})
						: cloudflareResolverRegistry({
								accountId: "account",
								resolveCredential: async () => "fixture-token",
							}),
					transport,
					credentialRef: "env://cloudflare",
					providerAccountId: "account",
					verifyCredentialScope: async () => {},
					...(options.serving
						? {
								observeLifecycle: async (
									input: Parameters<HostingResourceLifecycleReader>[0],
								) => {
									const response = await input.transport({
										method: "GET",
										url: `https://api.cloudflare.com/native/${encodeURIComponent(input.resourceId)}`,
										headers: {
											"x-operation": input.request.operation.operationId,
										},
										timeoutMs: 1000,
										maxResponseBytes: 65_536,
									});
									return parseResourceLifecycleObservation(
										parseJsonValue(response.body),
										input.context,
									);
								},
							}
						: undefined),
					observeOperatingLiability: async (input) => ({
						liability: structuredClone(
							input.artifactId === sourceHash
								? nativeSourceLiability
								: nativeLiability,
						),
						finalized: nativeLiabilityState.finalized,
					}),
				},
			],
		]),
		routing: options.serving
			? new Map([
					[
						"deploy",
						{
							providerAccountId: "account",
							credentialRef: "env://cloudflare",
							verifyCredentialScope:
								options.verifyRoutingCredentialScope ?? (async () => {}),
							source: sourceRoute,
							target: targetRoute,
							port: {
								provider: "cloudflare" as const,
								apply: async (route: typeof targetRoute) => {
									routingCalls.push(route.planId);
									return parseApplyResult({
										appliedRules: 1,
										planId: route.planId,
										provider: "cloudflare",
										realized: "full",
										notes: [],
									});
								},
								status: async (planId: typeof targetRoute.planId) =>
									parseRoutingStatus({
										planId,
										active: true,
										realized: "full",
										notes: [],
									}),
							},
						},
					],
				])
			: new Map(),
		health: options.serving
			? new Map([
					[
						targetHash,
						{
							url:
								options.serving === "wrong-health"
									? "https://foreign.fixture.test/health"
									: "https://native.fixture.test/health",
							transport,
						},
					],
					[
						sourceHash,
						{ url: "https://old.fixture.test/source-health", transport },
					],
				])
			: new Map(),
		billing: { observe: async () => [] },
		nowMs: options.nowMs ?? (() => 1000),
	});
	const request: HostingOperationRequest = {
		plan,
		operation: {
			operationId: "prepare",
			operationDigest: `sha256:${"b".repeat(64)}`,
			action: HostingTransitionAction.PREPARE,
			startedAtMs: 1000,
			deadlineAtMs: 10_000,
			observationAttempts: 0,
			nextObservationAtMs: 1000,
			mutationDispatched: true,
			$typeName: "hobo.cloud.hosting.v1.HostingTransitionOperation",
		},
		reservationId: "funded",
		fenceToken: 1n,
		signal: options.signal ?? new AbortController().signal,
	};
	return {
		provider,
		request,
		calls,
		resources,
		store,
		nativeLiability,
		nativeSourceLiability,
		nativeLiabilityState,
		routingCalls,
	};
}
describe("production resolver hosting execution", () => {
	it("refuses Railway in-place rollout before financial admission or native effects", async () => {
		const fx = await fixture({ railway: "same-parent" });
		expect(() =>
			fx.provider.requiresSourceLiabilityProofFor?.(fx.request.plan),
		).toThrow("distinct service parent");
		await expect(fx.provider.execute(fx.request)).rejects.toThrow(
			"distinct service parent",
		);
		expect(fx.calls).toEqual([]);
	});
	it("permits a distinct Railway staging service or an unchanged pinned shared service", async () => {
		for (const railway of ["distinct-parent", "shared"] as const) {
			const fx = await fixture({ railway });
			expect(
				fx.provider.requiresSourceLiabilityProofFor?.(fx.request.plan),
			).toBe(true);
			expect(fx.calls).toEqual([]);
		}
	});

	it("checks native serving endpoint, exact Station backend and real HTTP health before SHIFT", async () => {
		const fx = await fixture({ serving: "match" });
		await fx.provider.execute(fx.request);
		fx.request.operation.action = HostingTransitionAction.SHIFT;
		await fx.provider.execute(fx.request);
		expect(fx.routingCalls).toEqual(["route:target"]);
		expect(fx.calls.some((row) => row.path === "/health")).toBe(true);
	});
	it.each([
		HostingTransitionAction.SHIFT,
		HostingTransitionAction.RESTORE,
	])("refuses routing action %s when credential verification exhausts its deadline", async (action) => {
		let nowMs = 1000;
		const fx = await fixture({
			serving: "match",
			nowMs: () => nowMs,
			verifyRoutingCredentialScope: async () => {
				nowMs = 10_000;
			},
		});
		await fx.provider.execute(fx.request);
		fx.request.operation.action = action;
		await expect(fx.provider.execute(fx.request)).rejects.toThrow(
			"expired before routing I/O",
		);
		expect(fx.routingCalls).toEqual([]);
		expect(fx.calls.filter((call) => call.method === "DELETE")).toEqual([]);
	});
	it.each([
		HostingTransitionAction.SHIFT,
		HostingTransitionAction.RESTORE,
	])("refuses routing action %s when aborted during credential verification", async (action) => {
		const controller = new AbortController();
		const fx = await fixture({
			serving: "match",
			signal: controller.signal,
			verifyRoutingCredentialScope: async () => {
				controller.abort();
			},
		});
		await fx.provider.execute(fx.request);
		fx.request.operation.action = action;
		await expect(fx.provider.execute(fx.request)).rejects.toThrow(
			"expired before routing I/O",
		);
		expect(fx.routingCalls).toEqual([]);
		expect(fx.calls.filter((call) => call.method === "DELETE")).toEqual([]);
	});
	it("cannot authorize SHIFT with an unrelated healthy URL or a backend absent from native readback", async () => {
		for (const serving of ["wrong-health", "wrong-route"] as const) {
			const fx = await fixture({ serving });
			await fx.provider.execute(fx.request);
			fx.request.operation.action = HostingTransitionAction.SHIFT;
			await expect(fx.provider.execute(fx.request)).rejects.toThrow(
				serving === "wrong-health"
					? "health probe does not belong"
					: "independently observed native serving endpoint",
			);
			expect(fx.routingCalls).toEqual([]);
			expect(fx.calls.some((row) => row.path === "/health")).toBe(false);
		}
	});

	it("refuses unsupported state transfer before creating an empty replacement database", async () => {
		const fx = await fixture();
		if (!fx.request.plan.constraints) throw new Error("missing constraints");
		fx.request.plan.constraints.movementClass = "single-writer";
		await expect(fx.provider.execute(fx.request)).rejects.toThrow(
			"checkpoint and write-fence",
		);
		expect(fx.calls).toEqual([]);
	});
	it("refuses a corrupted durable resource identity before repeating any provider effect", async () => {
		const fx = await fixture();
		await fx.provider.execute(fx.request);
		let located: EventEnvelope | undefined;
		for await (const row of fx.store.readAll())
			if (row.event.type === "hosting.ResourceLocated") located = row.event;
		if (!located || !isJsonObject(located.data))
			throw new Error("missing native receipt");
		await fx.store.commit({
			streamId: located.streamId,
			append: {
				tenant: "tenant",
				actor: { kind: "service", id: "worker" },
				fenceToken: 1n,
				expectedSeq: located.seq,
			},
			events: [
				{
					type: "hosting.ResourceLocated",
					data: { ...located.data, providerAccountId: "foreign-account" },
				},
			],
		});
		const before = fx.calls.length;
		await expect(fx.provider.execute(fx.request)).rejects.toThrow(
			"another resource, account or incarnation",
		);
		expect(fx.calls).toHaveLength(before);
	});
	it("uses different native target names for identical content across deployments and later lifetimes", async () => {
		const fx = await fixture();
		await fx.provider.execute(fx.request);
		fx.request.plan.deploymentId = "another-deployment";
		await fx.provider.execute(fx.request);
		fx.request.plan.transitionId = "another-lifetime";
		await fx.provider.execute(fx.request);
		const targets = fx.calls
			.filter((row) => row.method === "PUT")
			.map((row) => row.path);
		expect(targets).toHaveLength(3);
		expect(new Set(targets).size).toBe(3);
	});
	it("refuses an existing unbounded source before the replacement can spend", async () => {
		const fx = await fixture();
		fx.nativeSourceLiability.mode = "estimated-quota";
		await expect(fx.provider.execute(fx.request)).rejects.toThrow(
			"native destination liability",
		);
		expect(fx.calls).toEqual([]);
	});
	it("requires an independently observed enforceable destination bound before any native mutation", async () => {
		const fx = await fixture();
		fx.nativeLiability.mode = "estimated-quota";
		await expect(fx.provider.execute(fx.request)).rejects.toThrow(
			"native destination liability",
		);
		expect(fx.calls).toEqual([]);
	});
	it("refuses a native bound for a different account or artifact rather than echoing the approved plan", async () => {
		for (const field of [
			"providerAccountId",
			"artifactDigest",
			"evidenceRef",
		] as const) {
			const fx = await fixture();
			fx.nativeLiability[field] = "foreign";
			await expect(fx.provider.execute(fx.request)).rejects.toThrow(
				"native destination liability",
			);
			expect(fx.calls).toEqual([]);
		}
	});
	it("preflights the complete plan before a later unsupported resource can leave a paid partial deployment", async () => {
		const fx = await fixture({ unsupportedSecond: true });
		await expect(fx.provider.execute(fx.request)).rejects.toThrow();
		expect(fx.calls).toEqual([]);
	});

	it("executes the shipped Cloudflare resolver through real HTTP using a separate target generation", async () => {
		const fx = await fixture();
		await fx.provider.execute(fx.request);
		expect(fx.calls.some((row) => row.method === "PUT")).toBe(true);
		expect(
			fx.calls.some(
				(row) => row.method === "PUT" && row.path.includes("/old-worker"),
			),
		).toBe(false);
		expect(fx.resources.has("old-worker")).toBe(true);
		const records = [];
		for await (const row of fx.store.readAll()) records.push(row.event);
		expect(records.some((row) => row.type === "hosting.ResourceLocated")).toBe(
			true,
		);
		expect(JSON.stringify(records)).not.toContain("fixture-token");
	});
	it("refuses a mismatched funded provider account before any network call", async () => {
		const fx = await fixture();
		if (!fx.request.plan.commitment?.evidence)
			throw new Error("missing fixture");
		fx.request.plan.commitment.evidence.quotes[0].providerAccountId =
			"other-account";
		await expect(fx.provider.execute(fx.request)).rejects.toThrow(
			"funded quote",
		);
		expect(fx.calls).toEqual([]);
	});
	it("refuses expired and foreign operations before provider I/O", async () => {
		const fx = await fixture();
		fx.request.operation.deadlineAtMs = 999;
		await expect(fx.provider.execute(fx.request)).rejects.toThrow("expired");
		expect(fx.calls).toEqual([]);
		fx.request.plan.tenantId = "foreign";
		await expect(fx.provider.execute(fx.request)).rejects.toThrow(
			"another tenant",
		);
	});
	it("never treats a create acknowledgement as healthy application evidence", async () => {
		const fx = await fixture();
		await fx.provider.execute(fx.request);
		const observed = await fx.provider.observe(fx.request);
		expect(observed.ready).toBe(false);
		expect(observed.outcome).toBe("pending");
		expect(fx.calls.filter((row) => row.method === "PUT")).toHaveLength(1);
	});
});
