import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { create, toJsonString } from "@bufbuild/protobuf";
import {
	AccountSchema,
	effectiveCiAccount,
	LeaseSchema,
	OfferSchema,
	parseCiPolicy,
	parsePipeline,
	route,
	SandboxAllowanceSchema,
	SandboxPricingSchema,
} from "@hobo/ci";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { foldBudgetSignals } from "../../broker/src/budget-signals.js";
import { createHostedCiBudgetRoutingBridge } from "../../stations/src/hosted-ci-routing.js";
import { createCiRelayClient } from "../src/client.js";
import { createHostedControlPlane } from "../src/hosted-control.js";
import { HostedRelay } from "../src/hosted-relay.js";
import {
	type OnboardingGithubPort,
	OnboardingOperationSchema,
	OnboardingPlanSchema,
	parseOnboardingPlan,
} from "../src/onboarding.js";
import type { LeaseStore } from "../src/store.js";
import { harness, job, NOW } from "./fixtures.js";

const stores: LeaseStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});
function setup(
	runtimeDiagnostic?: () => {
		sandboxEnabled: boolean;
		allowedDomains: readonly string[];
		deploymentId: string | null;
	},
) {
	const h = harness();
	stores.push(h.store);
	h.store.configure(h.configuration, 0, NOW);
	const sync = h.store;
	const store = {
		configuration: async () => sync.configuration(),
		reattestRate: async (
			input: Parameters<typeof sync.reattestRate>[0],
			rev: number,
			at: string,
		) => sync.reattestRate(input, rev, at),
		configure: async (
			config: Parameters<typeof sync.configure>[0],
			rev: number,
			at: string,
		) => sync.configure(config, rev, at),
		configureWithRecord: async (
			config: Parameters<typeof sync.configure>[0],
			rev: number,
			at: string,
			key: string,
			accountId: string,
			json: string,
		) => {
			const saved = sync.configure(config, rev, at);
			sync.putControlRecord(key, accountId, json, at);
			return saved;
		},
		controlRecord: async (key: string) => sync.controlRecord(key),
		putControlRecordMonotonic: async (
			key: string,
			accountId: string,
			json: string,
			at: string,
			terminal: string,
		) => {
			const old = sync.controlRecord(key);
			if (
				old &&
				JSON.parse(old.bodyJson).status === terminal &&
				JSON.parse(json).status !== terminal
			)
				return old;
			sync.putControlRecord(key, accountId, json, at);
			return sync.controlRecord(key);
		},
		all: async () => sync.all(),
		get: async (id: string) => sync.get(id),
		events: async () => sync.events(),
		quarantinedWebhooks: async (
			_accountId: string,
			_revision: number,
		): Promise<
			Array<{
				deliveryId: string;
				event: string;
				installationId: number;
				repositoryId: number;
				receivedAt: string;
				attempts: number;
			}>
		> => [],
		retryQuarantinedWebhook: async (
			_accountId: string,
			_revision: number,
			_deliveryId: string,
		) => false,
		pendingJobs: async () => sync.pendingJobs(),
		observe: async (...args: Parameters<typeof sync.observe>) =>
			sync.observe(...args),
		queue: async (...args: Parameters<typeof sync.queue>) =>
			sync.queue(...args),
		reserve: async (...args: Parameters<typeof sync.reserve>) =>
			sync.reserve(...args),
		transition: async (...args: Parameters<typeof sync.transition>) =>
			sync.transition(...args),
		cancelAndRequeue: async (
			...args: Parameters<typeof sync.cancelAndRequeue>
		) => sync.cancelAndRequeue(...args),
		abortIsolatedAndRequeue: async (
			...args: Parameters<typeof sync.abortIsolatedAndRequeue>
		) => sync.abortIsolatedAndRequeue(...args),
		settle: async (...args: Parameters<typeof sync.settle>) =>
			sync.settle(...args),
	};
	const relay = new HostedRelay({
		config: h.configuration,
		store,
		github: h.api,
		identity: h.relay.options.identity,
		webhookSecret: "test-webhook-secret-at-least-32-chars",
		now: () => NOW,
	});
	const github: OnboardingGithubPort = {
		request: h.api.request.bind(h.api),
		appRequest: async () => {
			throw new Error("unexpected app request");
		},
	};
	let revoked = false;
	const controlOptions: Parameters<typeof createHostedControlPlane>[0] = {
		relay,
		store,
		github,
		authenticate: (auth) =>
			!revoked && auth === "Bearer admin"
				? {
						accountId: "account-a",
						installationIds: [10],
						scopes: [
							"policy:read",
							"policy:write",
							"repositories:write",
							"operations:write",
						],
					}
				: auth === "Bearer observer"
					? {
							accountId: "account-a",
							installationIds: [10],
							scopes: ["observations:write"],
						}
					: auth === "Bearer ops-b"
						? {
								accountId: "account-b",
								installationIds: [11],
								scopes: ["operations:write"],
							}
						: auth === "Bearer neighbor"
							? {
									accountId: "account-b",
									installationIds: [11],
									scopes: ["policy:read", "policy:write", "repositories:write"],
								}
							: auth === "Bearer missing-account"
								? {
										accountId: "missing-account",
										installationIds: [],
										scopes: ["policy:read"],
									}
								: undefined,
		publicOrigin: "https://relay.example",
		assets: { workflow: "fixture", bootstrap: "fixture" },
	};
	if (runtimeDiagnostic) controlOptions.runtimeDiagnostic = runtimeDiagnostic;
	const handler = createHostedControlPlane(controlOptions);
	async function request<T>(
		path: string,
		method = "GET",
		token = "admin",
		payload?: T,
		version = 1,
	) {
		const init: RequestInit = {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				"if-match": `"${version}"`,
				"content-type": "application/json",
			},
		};
		if (payload !== undefined) init.body = JSON.stringify(payload);
		const req = new Request(`https://relay.example${path}`, init);
		const result = await handler(req);
		if (!result) throw new Error("route missing");
		return result;
	}
	return {
		h,
		store,
		relay,
		request,
		handler,
		github,
		revoke: () => {
			revoked = true;
		},
	};
}
function desired() {
	return {
		accountId: "account-a",
		tenantId: "account-a",
		pool: { label: "hobo", os: "linux", architecture: "x64" },
		providers: [
			{
				id: "blacksmith-a",
				kind: "blacksmith",
				connectionRef: "owned-blacksmith-account",
				runsOn: "blacksmith-2vcpu-ubuntu-2404",
				enabled: false,
			},
		],
		budget: {
			scope: "ci-account",
			currency: "USD",
			limitMicros: 50000,
			period: "manual",
			timeZone: "UTC",
		},
		routing: {
			strategy: "lowest-total-incremental-cost",
			noEligibleProvider: "queue",
			unknownAllocation: "zero",
		},
		thresholds: [],
	};
}

function mockIsolatedGithub(
	t: ReturnType<typeof setup>,
	beforeRepository?: () => void,
) {
	const appRequest = vi.fn(async (path: string) => {
		if (path === "/app") return Response.json({ id: 42 });
		if (path === "/app/installations/10")
			return Response.json({
				id: 10,
				app_id: 42,
				suspended_at: null,
				permissions: {
					actions: "write",
					administration: "write",
					metadata: "read",
				},
			});
		if (path === "/repos/org/repo/installation")
			return Response.json({ id: 10, app_id: 42 });
		throw new Error(`unexpected GitHub endpoint ${path}`);
	});
	const request = vi.fn(async (_id: number, path: string, method?: string) => {
		if (path !== "/repos/org/repo" || (method && method !== "GET"))
			throw new Error("unexpected GitHub operation");
		beforeRepository?.();
		return Response.json({
			id: 101,
			full_name: "org/repo",
			private: false,
			default_branch: "main",
		});
	});
	t.github.appRequest = appRequest;
	t.github.request = request;
	return { appRequest, request };
}

describe("bridge-free isolated onboarding", () => {
	const input = {
		repository: "org/repo",
		repositoryId: 101,
		installationId: 10,
		trustedRepositoryAcknowledged: true,
		publicRepositoryAcknowledged: true,
		acceptAllMatchingRepositoryJobs: true,
	};
	it("connects through the SDK after verifying the installation, without mutating GitHub", async () => {
		const t = setup();
		t.relay.options.denyUnisolated = true;
		t.relay.options.isolatedHost = {
			launch: async () => {},
			reconcile: async () => {},
		};
		const github = mockIsolatedGithub(t);
		const client = createCiRelayClient({
			origin: "https://relay.example",
			accountToken: () => "admin",
			fetch: async (url, init) => {
				const response = await t.handler(new Request(url, init));
				if (!response) throw new Error("route missing");
				return response;
			},
		});
		const result = await client.connectIsolatedRepository(input, {
			revision: 1,
		});
		expect(result).toMatchObject({
			repositoryId: 101,
			isolatedOnly: true,
			bridgeWorkflow: "",
			bridgeSha: "",
			bridgeRef: "",
			dispatcherActorId: 0,
			allowedRefs: [],
			acceptAllMatchingRepositoryJobs: true,
		});
		expect((await t.store.configuration())?.revision).toBe(2);
		expect(
			(await t.store.configuration())?.configuration?.connections[0],
		).toMatchObject({ isolatedOnly: true });
		expect(github.request).toHaveBeenCalledTimes(1);
		expect(github.request.mock.calls[0]?.[2]).toBeUndefined();
	});
	it("revalidates an isolated connection live without changing custom settings or revision", async () => {
		const t = setup();
		t.relay.options.isolatedHost = {
			launch: async () => {},
			reconcile: async () => {},
		};
		const github = mockIsolatedGithub(t);
		const path = "/v1/accounts/self/repositories/isolated-connect";
		expect((await t.request(path, "POST", "admin", input)).status).toBe(200);
		const saved = await t.store.configuration();
		const config = saved?.configuration;
		const connection = config?.connections[0];
		if (!config || !connection) throw new Error("missing connected fixture");
		connection.runnerGroupId = 27;
		const before = await t.store.configure(config, 2, NOW);
		const response = await t.request(path, "POST", "admin", input, 3);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ runnerGroupId: 27 });
		expect(await t.store.configuration()).toEqual(before);
		expect(github.request).toHaveBeenCalledTimes(2);
		expect(
			(
				await t.request(
					path,
					"POST",
					"admin",
					{ ...input, runnerGroupId: 28 },
					3,
				)
			).status,
		).toBe(409);
		expect(await t.store.configuration()).toEqual(before);
		github.appRequest.mockImplementation(
			async () => new Response(null, { status: 404 }),
		);
		expect((await t.request(path, "POST", "admin", input, 3)).status).toBe(503);
		expect(await t.store.configuration()).toEqual(before);
	});
	it("rejects configuration before contacting GitHub when no isolated host is enabled", async () => {
		const t = setup();
		const github = mockIsolatedGithub(t);
		const response = await t.request(
			"/v1/accounts/self/repositories/isolated-connect",
			"POST",
			"admin",
			input,
		);
		expect(response.status).toBe(409);
		expect(github.appRequest).not.toHaveBeenCalled();
		expect((await t.store.configuration())?.revision).toBe(1);
	});
	it("rejects an authority revoked while GitHub identity is being verified", async () => {
		const t = setup();
		t.relay.options.isolatedHost = {
			launch: async () => {},
			reconcile: async () => {},
		};
		mockIsolatedGithub(t, t.revoke);
		const response = await t.request(
			"/v1/accounts/self/repositories/isolated-connect",
			"POST",
			"admin",
			input,
		);
		expect(response.status).toBe(403);
		expect((await t.store.configuration())?.revision).toBe(1);
	});
	it("does not change runner authority while an existing lease is active", async () => {
		const t = setup();
		t.relay.options.isolatedHost = {
			launch: async () => {},
			reconcile: async () => {},
		};
		mockIsolatedGithub(t);
		const account = t.h.configuration.accounts[0];
		if (!account) throw new Error("fixture");
		expect(t.h.store.reserve(account, job(), NOW)).toBeDefined();
		const response = await t.request(
			"/v1/accounts/self/repositories/isolated-connect",
			"POST",
			"admin",
			input,
		);
		expect(response.status).toBe(409);
		expect((await t.store.configuration())?.revision).toBe(1);
		expect(
			(await t.store.configuration())?.configuration?.connections[0]
				?.isolatedOnly,
		).toBe(false);
	});
	it("does not overwrite policy changes made during GitHub verification", async () => {
		const t = setup();
		t.relay.options.isolatedHost = {
			launch: async () => {},
			reconcile: async () => {},
		};
		mockIsolatedGithub(t, () => {
			t.h.store.configure(t.h.configuration, 1, NOW);
		});
		const response = await t.request(
			"/v1/accounts/self/repositories/isolated-connect",
			"POST",
			"admin",
			input,
		);
		expect(response.status).toBe(409);
		expect((await t.store.configuration())?.revision).toBe(2);
		expect(
			(await t.store.configuration())?.configuration?.connections[0]
				?.isolatedOnly,
		).toBe(false);
	});
});

describe("hosted asynchronous account control", () => {
	it("limits rate re-attestation to a scoped trusted publisher and existing zero-credit offer", async () => {
		const t = setup();
		const state = await t.store.configuration();
		const config = state?.configuration;
		const account = config?.accounts[0];
		if (!config || !account) throw new Error("missing account");
		account.offers.push(
			create(OfferSchema, {
				id: "sandbox-rate",
				provider: "vercel",
				providerAccountId: "vercel-a",
				backend: "sandbox",
				runsOn: "sandbox-2",
				enabled: true,
				bridgeAcknowledged: true,
				concurrency: 1,
				budgetMicros: 100000,
				observedAt: "2026-10-26T00:00:00Z",
				validUntil: "2026-10-26T13:00:00Z",
				sourceUrl: "https://vercel.com/docs/sandbox/pricing",
				sandboxPricing: create(SandboxPricingSchema, {
					vcpus: 2,
					memoryMb: 4096,
					maxEgressBytes: 100000,
					cpuMicrosPerVcpuHour: 10,
					memoryMicrosPerGbHour: 1,
					creationMicros: 1,
					egressMicrosPerGb: 1,
					proxyMicrosPerGb: 1,
					proxyFixedMicros: 1,
					networkHeadroomBytes: 1,
					bootstrapFixedMicros: 1,
				}),
			}),
		);
		await t.store.configure(config, 1, NOW);
		const input = {
			offerId: "sandbox-rate",
			checkedAt: NOW,
			validUntil: "2026-10-27T12:00:00Z",
			sourceUrl: "https://vercel.com/docs/sandbox/pricing",
		};
		expect(
			(
				await t.request(
					"/v2/accounts/self/rate-observations",
					"POST",
					"admin",
					input,
					2,
				)
			).status,
		).toBe(403);
		expect(
			(
				await t.request(
					"/v2/accounts/self/rate-observations",
					"POST",
					"observer",
					input,
					1,
				)
			).status,
		).toBe(409);
		expect(
			(
				await t.request(
					"/v2/accounts/self/rate-observations",
					"POST",
					"observer",
					{ ...input, sourceUrl: "https://attacker.example" },
					2,
				)
			).status,
		).toBe(400);
		const observer = createCiRelayClient({
			origin: "https://relay.example",
			accountToken: () => "observer",
			fetch: async (url, init) =>
				(await t.handler(new Request(url, init))) ??
				new Response(null, { status: 404 }),
		});
		expect((await observer.reattestRate(input, { revision: 2 })).revision).toBe(
			3,
		);
		const after = (
			await t.store.configuration()
		)?.configuration?.accounts[0]?.offers.find(
			(offer) => offer.id === input.offerId,
		);
		expect(after?.observedAt).toBe("2026-10-26T00:00:00Z");
		expect(after?.validUntil).toBe(input.validUntil);
	});
	it("restricts runtime diagnostics to policy readers of existing accounts", async () => {
		const diagnostic = vi.fn(() => ({
			sandboxEnabled: true,
			allowedDomains: ["github.com", "*.actions.githubusercontent.com"],
			deploymentId: "dpl_ABC123",
		}));
		const t = setup(diagnostic);
		expect(
			(await t.request("/v2/accounts/self/runtime", "GET", "invalid")).status,
		).toBe(401);
		expect(
			(await t.request("/v2/accounts/self/runtime", "GET", "observer")).status,
		).toBe(403);
		expect(
			(await t.request("/v2/accounts/self/runtime", "GET", "missing-account"))
				.status,
		).toBe(404);
		expect((await t.request("/v2/accounts/self/runtime", "POST")).status).toBe(
			404,
		);
		expect(diagnostic).not.toHaveBeenCalled();
		const result = await t.request("/v2/accounts/self/runtime");
		expect(result.status).toBe(200);
		expect(result.headers.get("cache-control")).toBe("no-store");
		expect(await result.json()).toEqual({
			sandboxEnabled: true,
			allowedDomains: ["github.com", "*.actions.githubusercontent.com"],
			deploymentId: "dpl_ABC123",
		});
		expect(diagnostic).toHaveBeenCalledTimes(1);
		expect((await setup().request("/v2/accounts/self/runtime")).status).toBe(
			404,
		);
	});
	it.each([
		"refs",
		"events",
		"public acknowledgment",
		"PR policy",
	])("does not treat a ready plan as connected when %s differs, and drains active leases", async (difference) => {
		const t = setup();
		const fixture = z
			.object({
				metadata: z.object({ consumerFixtures: z.object({ plan: z.json() }) }),
			})
			.parse(
				JSON.parse(
					readFileSync(
						new URL(
							"../contracts/onboarding-boundary.pact.json",
							import.meta.url,
						),
						"utf8",
					),
				),
			);
		const original = parseOnboardingPlan(
			JSON.stringify(fixture.metadata.consumerFixtures.plan),
		);
		const plan = {
			...original,
			accountId: "account-a",
			installationId: 10,
			repository: "org/repo",
			repositoryId: 101,
			dispatcherActorId: 123,
			installBranch: "",
			bridgeRef: "",
			planDigest: "",
		};
		const hash = (value: string) =>
			createHash("sha256").update(value).digest("hex");
		const suffix = hash(toJsonString(OnboardingPlanSchema, plan)).slice(0, 20);
		plan.installBranch = `hobo-ci-install-${suffix}`;
		plan.bridgeRef = `hobo-ci-bridge-${suffix}`;
		plan.planDigest = hash(toJsonString(OnboardingPlanSchema, plan));
		const connection = t.h.configuration.connections[0];
		const account = t.h.configuration.accounts[0];
		if (!connection || !account) throw new Error("fixture");
		connection.bridgeRef = plan.bridgeRef;
		connection.bridgeWorkflow = plan.bridgeWorkflow;
		connection.allowedEvents = ["push", "workflow_dispatch"];
		connection.allowedRefs = [...plan.trustedRefs];
		if (difference === "refs") connection.allowedRefs.push("refs/heads/other");
		if (difference === "events") connection.allowedEvents.push("pull_request");
		if (difference === "public acknowledgment")
			connection.publicRepositoryAcknowledged = true;
		if (difference === "PR policy") connection.allowAllPullRequests = true;
		t.h.store.configure(t.h.configuration, 1, NOW);
		expect(t.h.store.reserve(account, job(), NOW)).toBeDefined();
		const id = "00000000-0000-4000-8000-000000000001";
		t.h.store.putControlRecord(
			`onboarding:${id}`,
			"account-a",
			toJsonString(
				OnboardingOperationSchema,
				create(OnboardingOperationSchema, { id, plan, status: "ready" }),
			),
			NOW,
		);
		const response = await t.request(
			`/v1/accounts/self/repositories/${id}/connect`,
			"POST",
			"admin",
			undefined,
			2,
		);
		expect(response.status).toBe(409);
		expect(await response.text()).toContain("drain active repository leases");
	});
	it("refuses to prepare an all-PR plan without an isolated host", async () => {
		const t = setup();
		const response = await t.request(
			"/v1/accounts/self/repositories/prepare",
			"POST",
			"admin",
			{
				repository: "org/repo",
				repositoryId: 101,
				installationId: 10,
				allowedRefs: ["refs/heads/main"],
				trustedRepositoryAcknowledged: true,
				allowAllPullRequests: true,
			},
		);
		expect(response.status).not.toBe(201);
		expect(t.h.api.violations).toEqual([]);
	});
	it("does not prepare a bridge that the hosted relay cannot execute", async () => {
		const t = setup();
		t.relay.options.denyUnisolated = true;
		const githubRequest = vi.spyOn(t.github, "request");
		const record = vi.spyOn(t.store, "putControlRecordMonotonic");
		const response = await t.request(
			"/v1/accounts/self/repositories/prepare",
			"POST",
			"admin",
			{
				repository: "org/repo",
				repositoryId: 101,
				installationId: 10,
				allowedRefs: ["refs/heads/main"],
				trustedRepositoryAcknowledged: true,
			},
		);
		expect(response.status).toBe(409);
		expect(await response.text()).toContain("workflow bridge is unavailable");
		expect(githubRequest).not.toHaveBeenCalled();
		expect(record).not.toHaveBeenCalled();
	});
	it.each([
		"apply",
		"connect",
	])("refuses to %s an existing bridge plan after bridge execution is disabled", async (action) => {
		const t = setup();
		const fixture = z
			.object({
				metadata: z.object({ consumerFixtures: z.object({ plan: z.json() }) }),
			})
			.parse(
				JSON.parse(
					readFileSync(
						new URL(
							"../contracts/onboarding-boundary.pact.json",
							import.meta.url,
						),
						"utf8",
					),
				),
			);
		const original = parseOnboardingPlan(
			JSON.stringify(fixture.metadata.consumerFixtures.plan),
		);
		const plan = {
			...original,
			accountId: "account-a",
			installationId: 10,
			repository: "org/repo",
			repositoryId: 101,
			dispatcherActorId: 123,
			installBranch: "",
			bridgeRef: "",
			planDigest: "",
		};
		const hash = (value: string) =>
			createHash("sha256").update(value).digest("hex");
		const suffix = hash(toJsonString(OnboardingPlanSchema, plan)).slice(0, 20);
		plan.installBranch = `hobo-ci-install-${suffix}`;
		plan.bridgeRef = `hobo-ci-bridge-${suffix}`;
		plan.planDigest = hash(toJsonString(OnboardingPlanSchema, plan));
		const id = "00000000-0000-4000-8000-000000000001";
		t.h.store.putControlRecord(
			`onboarding:${id}`,
			"account-a",
			toJsonString(
				OnboardingOperationSchema,
				create(OnboardingOperationSchema, { id, plan, status: "planned" }),
			),
			NOW,
		);
		t.relay.options.denyUnisolated = true;
		const githubRequest = vi.spyOn(t.github, "request");
		const response = await t.request(
			`/v1/accounts/self/repositories/${id}/${action}`,
			"POST",
			"admin",
		);
		expect(response.status).toBe(409);
		expect(await response.text()).toContain("workflow bridge is unavailable");
		expect(githubRequest).not.toHaveBeenCalled();
		expect(t.h.store.controlRecord(`onboarding:${id}`)?.bodyJson).toContain(
			'"status":"planned"',
		);
	});
	it.each([
		"apply",
		"connect",
	])("refuses %s of an all-PR plan after isolated host removal", async (action) => {
		const t = setup();
		const fixture = z
			.object({
				metadata: z.object({ consumerFixtures: z.object({ plan: z.json() }) }),
			})
			.parse(
				JSON.parse(
					readFileSync(
						new URL(
							"../contracts/onboarding-boundary.pact.json",
							import.meta.url,
						),
						"utf8",
					),
				),
			);
		const plan = parseOnboardingPlan(
			JSON.stringify(fixture.metadata.consumerFixtures.plan),
		);
		const revised = {
			...plan,
			allowAllPullRequests: true,
			installBranch: "",
			bridgeRef: "",
			planDigest: "",
		};
		const hash = (value: string) =>
			createHash("sha256").update(value).digest("hex");
		const suffix = hash(toJsonString(OnboardingPlanSchema, revised)).slice(
			0,
			20,
		);
		revised.installBranch = `hobo-ci-install-${suffix}`;
		revised.bridgeRef = `hobo-ci-bridge-${suffix}`;
		revised.planDigest = hash(toJsonString(OnboardingPlanSchema, revised));
		const id = "00000000-0000-4000-8000-000000000001";
		const operation = create(OnboardingOperationSchema, {
			id,
			plan: revised,
			status: "planned",
		});
		t.h.store.putControlRecord(
			`onboarding:${id}`,
			"account-a",
			toJsonString(OnboardingOperationSchema, operation),
			NOW,
		);
		const response = await t.request(
			`/v1/accounts/self/repositories/${id}/${action}`,
			"POST",
			"admin",
		);
		expect(response.status).toBe(409);
		expect(t.h.api.violations).toEqual([]);
	});
	it("fulfills each hosted control boundary interaction", async () => {
		// SAFETY: This checked-in Pact fixture is validated by the interaction assertions below.
		const pact = JSON.parse(
			readFileSync(
				new URL(
					"../contracts/hosted-control-boundary.pact.json",
					import.meta.url,
				),
				"utf8",
			),
		) as {
			interactions: Array<{
				request: { path: string; method: string; body: object };
				response: { status: number };
			}>;
		};
		expect(pact.interactions).toHaveLength(2);
		const t = setup();
		for (const interaction of pact.interactions) {
			const actual = await t.request(
				interaction.request.path,
				interaction.request.method,
				"admin",
				interaction.request.body,
			);
			expect(actual.status).toBe(interaction.response.status);
		}
	});
	it("authenticates and rejects unsafe legacy writes before mutating account", async () => {
		const t = setup();
		expect(
			(
				await t.request("/v1/accounts/self/policy", "PUT", "admin", {
					id: "account-a",
				})
			).status,
		).toBe(410);
		expect(
			(
				await t.request(
					"/v2/accounts/self/policy",
					"PUT",
					"neighbor",
					desired(),
				)
			).status,
		).toBe(403);
		expect(
			(await t.request("/v2/accounts/self/policy", "PUT", "invalid", desired()))
				.status,
		).toBe(401);
		expect((await t.store.configuration())?.revision).toBe(1);
	});
	it("atomically applies desired budget and operator gate while preserving observed usage", async () => {
		const t = setup();
		const before = (await t.store.configuration())?.configuration?.accounts[0];
		const result = await t.request(
			"/v2/accounts/self/policy",
			"PUT",
			"admin",
			desired(),
		);
		expect(result.status).toBe(200);
		expect(result.headers.get("etag")).toBe('"2"');
		const saved = (await t.store.configuration())?.configuration?.accounts[0];
		expect(saved?.budgetMicros).toBe(50000);
		expect(saved?.offers[0]?.freeMinutes).toBe(before?.offers[0]?.freeMinutes);
		expect(saved?.offers[0]?.enabled).toBe(true);
		const policy = parseCiPolicy(
			(await t.store.controlRecord("ci-policy:account-a"))?.bodyJson ?? "",
		);
		if (!saved) throw new Error("missing account");
		expect(effectiveCiAccount(saved, policy).offers[0]?.enabled).toBe(false);
		expect(
			(
				await t.request(
					"/v2/accounts/self/policy",
					"PUT",
					"admin",
					desired(),
					1,
				)
			).status,
		).toBe(409);
	});
	it("rejects injected balance and unauthorized provider binding", async () => {
		const t = setup();
		const d = desired();
		const invalid = { ...d, spentMicros: 1 };
		expect(
			(await t.request("/v2/accounts/self/policy", "PUT", "admin", invalid))
				.status,
		).toBe(400);
		const alteredProvider = d.providers[0];
		if (!alteredProvider) throw new Error("missing provider fixture");
		alteredProvider.connectionRef = "other";
		expect(
			(await t.request("/v2/accounts/self/policy", "PUT", "admin", d)).status,
		).toBe(409);
		expect((await t.store.configuration())?.revision).toBe(1);
	});
	it("publishes an SDK policy containing the provisioned isolated Sandbox", async () => {
		const t = setup();
		const state = await t.store.configuration();
		const config = state?.configuration;
		const account = config?.accounts[0];
		if (!account || !config) throw new Error("fixture missing");
		account.offers.push(
			create(OfferSchema, {
				id: "sandbox-a",
				provider: "vercel",
				providerAccountId: "vercel-account-a",
				backend: "sandbox",
				runsOn: "sandbox-2",
				enabled: true,
				bridgeAcknowledged: true,
				concurrency: 2,
				budgetMicros: 100000,
				observedAt: "2026-10-26T00:00:00Z",
				validUntil: "2026-10-28T00:00:00Z",
				sourceUrl: "https://example.com/pricing",
				sandboxPricing: create(SandboxPricingSchema, {
					vcpus: 2,
					memoryMb: 4096,
					maxEgressBytes: 100000,
					cpuMicrosPerVcpuHour: 10,
					memoryMicrosPerGbHour: 1,
					creationMicros: 1,
					egressMicrosPerGb: 1,
					proxyMicrosPerGb: 1,
					proxyFixedMicros: 1,
					networkHeadroomBytes: 1,
					bootstrapFixedMicros: 1,
				}),
			}),
		);
		await t.store.configure(config, 1, NOW);
		const policy = desired();
		policy.providers.push({
			id: "sandbox-a",
			kind: "vercel",
			connectionRef: "vercel-account-a",
			runsOn: "sandbox-2",
			enabled: true,
		});
		const bad = structuredClone(policy);
		const badSandbox = bad.providers[1];
		if (!badSandbox) throw new Error("missing sandbox provider");
		badSandbox.connectionRef = "other-account";
		expect(
			(await t.request("/v2/accounts/self/policy", "PUT", "admin", bad, 2))
				.status,
		).toBe(409);
		expect(
			(await t.request("/v2/accounts/self/policy", "PUT", "admin", policy, 2))
				.status,
		).toBe(200);
		const saved = (await t.store.configuration())?.configuration?.accounts[0];
		const compiled = parseCiPolicy(
			(await t.store.controlRecord("ci-policy:account-a"))?.bodyJson ?? "",
		);
		if (!saved) throw new Error("missing account");
		expect(effectiveCiAccount(saved, compiled).offers[1]?.enabled).toBe(true);
	});
	it("configures an existing provider without changing usage evidence or an active reservation", async () => {
		const t = setup();
		const state = await t.store.configuration();
		const configuration = state?.configuration;
		const account = configuration?.accounts[0];
		if (!account || !configuration) throw new Error("missing account");
		account.offers.push(
			create(OfferSchema, {
				id: "sandbox-a",
				provider: "vercel",
				providerAccountId: "vercel-account-a",
				backend: "sandbox",
				runsOn: "sandbox-2",
				enabled: true,
				bridgeAcknowledged: true,
				concurrency: 2,
				budgetMicros: 100000,
				spentMicros: 5,
				observedAt: "2026-10-26T00:00:00Z",
				validUntil: "2026-10-27T00:00:00Z",
				sourceUrl: "https://example.com/pricing",
				sandboxAllowance: create(SandboxAllowanceSchema, {
					cpuVcpuMs: 3000,
				}),
				sandboxPricing: create(SandboxPricingSchema, {
					vcpus: 2,
					memoryMb: 4096,
					maxEgressBytes: 100000,
					cpuMicrosPerVcpuHour: 10,
					memoryMicrosPerGbHour: 1,
					creationMicros: 1,
					egressMicrosPerGb: 1,
					proxyMicrosPerGb: 1,
					proxyFixedMicros: 1,
					networkHeadroomBytes: 1,
					bootstrapFixedMicros: 5,
				}),
			}),
		);
		await t.store.configure(configuration, 1, NOW);
		const pipeline = parsePipeline(
			JSON.stringify({
				id: "test-provider-policy",
				accountId: account.id,
				timeoutSeconds: 60,
				steps: [{ id: "check", argv: ["true"] }],
			}),
		);
		const lease = t.h.store.reservePipeline(
			account,
			pipeline,
			"provider-policy-input",
			["sandbox-a"],
			NOW,
		);
		if (!lease) throw new Error("missing active reservation");
		const original = account.offers.find((offer) => offer.id === "sandbox-a");
		if (!original?.sandboxPricing) throw new Error("missing Sandbox offer");
		const candidate = JSON.parse(toJsonString(OfferSchema, original));
		candidate.budgetMicros = 120000;
		candidate.concurrency = 1;
		candidate.sandboxPricing.bootstrapFixedMicros = 10;
		expect(
			(
				await t.request(
					"/v2/accounts/self/providers",
					"PUT",
					"admin",
					{ ...candidate, budgetMicros: account.budgetMicros + 1 },
					2,
				)
			).status,
		).toBe(400);
		expect(
			(
				await t.request(
					"/v2/accounts/self/providers",
					"PUT",
					"admin",
					candidate,
					2,
				)
			).status,
		).toBe(200);
		const next = (
			await t.store.configuration()
		)?.configuration?.accounts[0]?.offers.find(
			(offer) => offer.id === "sandbox-a",
		);
		expect(next?.budgetMicros).toBe(120000);
		expect(next?.concurrency).toBe(1);
		expect(next?.sandboxPricing?.bootstrapFixedMicros).toBe(10);
		expect(next?.observedAt).toBe(original.observedAt);
		expect(next?.spentMicros).toBe(original.spentMicros);
		expect(next?.sandboxAllowance).toEqual(original.sandboxAllowance);
		expect(t.h.store.get(lease.id)?.reservedPaidMicros).toBe(
			lease.reservedPaidMicros,
		);
		const savedAccount = (await t.store.configuration())?.configuration
			?.accounts[0];
		if (!savedAccount || !next) throw new Error("missing saved account");
		const policyAccount = { ...savedAccount, offers: [next] };
		const withoutHistory = route(policyAccount, [], NOW);
		if (!withoutHistory) throw new Error("missing Sandbox quote");
		const settled = create(LeaseSchema, {
			accountId: account.id,
			offerId: next.id,
			state: "completed",
			paidMicros: withoutHistory.paidMicros + 1,
			usageCompletedAt: "2026-10-26T01:00:00Z",
			sandboxUsedAllowance: create(SandboxAllowanceSchema, { cpuVcpuMs: 3000 }),
		});
		const withHistory = route(policyAccount, [settled], NOW);
		expect(withoutHistory.sandboxReservedAllowance?.cpuVcpuMs).toBe(3000);
		expect(withHistory?.sandboxReservedAllowance?.cpuVcpuMs ?? 0).toBe(0);
		const cap = withoutHistory.paidMicros + settled.paidMicros - 1;
		const capped = {
			...policyAccount,
			budgetMicros: cap,
			offers: [{ ...next, budgetMicros: cap }],
		};
		expect(route(capped, [], NOW)).toBeDefined();
		expect(route(capped, [settled], NOW)).toBeUndefined();
		expect((await t.store.configuration())?.revision).toBe(3);
		// An equal estimate is allowed, but lowering it needs a fresh observation.
		expect(
			(
				await t.request(
					"/v2/accounts/self/providers",
					"PUT",
					"admin",
					candidate,
					3,
				)
			).status,
		).toBe(200);
		candidate.sandboxPricing.bootstrapFixedMicros = 9;
		expect(
			(
				await t.request(
					"/v2/accounts/self/providers",
					"PUT",
					"admin",
					candidate,
					4,
				)
			).status,
		).toBe(403);
		expect((await t.store.configuration())?.revision).toBe(4);
	});
	it("rejects cross-tenant, stale, unauthorized, invented or forged provider updates", async () => {
		const t = setup();
		const offer = (await t.store.configuration())?.configuration?.accounts[0]
			?.offers[0];
		if (!offer) throw new Error("missing offer");
		const body = JSON.parse(toJsonString(OfferSchema, offer));
		for (const [token, revision, expected] of [
			["invalid", 1, 401],
			["observer", 1, 403],
			["neighbor", 1, 404],
			["admin", 0, 409],
		] as const) {
			expect(
				(
					await t.request(
						"/v2/accounts/self/providers",
						"PUT",
						token,
						body,
						revision,
					)
				).status,
			).toBe(expected);
		}
		for (const [field, value] of [
			["providerAccountId", "other"],
			["observedAt", "2026-10-26T01:00:00Z"],
			["sourceUrl", "https://other.example"],
			["freeMinutes", 999],
			["spentMicros", 0],
			["priceMicrosPerMinute", 1],
			["enabled", false],
		] as const) {
			const changed = { ...body, [field]: value };
			if (field === "spentMicros") changed.spentMicros = 999;
			expect(
				(
					await t.request(
						"/v2/accounts/self/providers",
						"PUT",
						"admin",
						changed,
						1,
					)
				).status,
			).toBe(400);
		}
		expect(
			(
				await t.request(
					"/v2/accounts/self/providers",
					"PUT",
					"admin",
					{ ...body, id: "invented" },
					1,
				)
			).status,
		).toBe(404);
		expect((await t.store.configuration())?.revision).toBe(1);
	});
	it("accepts current Sandbox prices and verified free snapshots without letting observations alter resource limits", async () => {
		const t = setup();
		const state = await t.store.configuration();
		const config = state?.configuration;
		const account = config?.accounts[0];
		if (!account || !config) throw new Error("fixture missing");
		account.offers.push(
			create(OfferSchema, {
				id: "sandbox-a",
				provider: "vercel",
				providerAccountId: "vercel-account-a",
				backend: "sandbox",
				runsOn: "sandbox-2",
				enabled: true,
				bridgeAcknowledged: true,
				concurrency: 2,
				budgetMicros: 100000,
				observedAt: "2026-10-26T00:00:00Z",
				validUntil: "2026-10-27T00:00:00Z",
				sourceUrl: "https://example.com/pricing",
				sandboxPricing: create(SandboxPricingSchema, {
					vcpus: 2,
					memoryMb: 4096,
					maxEgressBytes: 100000,
					cpuMicrosPerVcpuHour: 10,
					memoryMicrosPerGbHour: 1,
					creationMicros: 1,
					egressMicrosPerGb: 1,
					proxyMicrosPerGb: 1,
					proxyFixedMicros: 1,
					networkHeadroomBytes: 1,
					bootstrapFixedMicros: 1,
				}),
			}),
		);
		await t.store.configure(config, 1, NOW);
		const live = (await t.store.configuration())?.configuration?.accounts[0];
		if (!live) throw new Error("fixture missing");
		const wire = JSON.parse(toJsonString(AccountSchema, live));
		const offer = wire.offers.find(
			(item: { id: string }) => item.id === "sandbox-a",
		);
		const sameTime = structuredClone(wire);
		sameTime.offers.find(
			(item: { id: string }) => item.id === "sandbox-a",
		).sandboxPricing.cpuMicrosPerVcpuHour = 11;
		expect(
			(
				await t.request(
					"/v2/accounts/self/observations",
					"POST",
					"observer",
					sameTime,
					2,
				)
			).status,
		).toBe(409);
		const unsafeResource = structuredClone(wire);
		unsafeResource.offers.find(
			(item: { id: string }) => item.id === "sandbox-a",
		).sandboxPricing.vcpus = 4;
		expect(
			(
				await t.request(
					"/v2/accounts/self/observations",
					"POST",
					"observer",
					unsafeResource,
					2,
				)
			).status,
		).toBe(400);
		for (const patch of [
			{ proxyVmRequired: true },
			{ region: "iad1" },
			{ proxyControlMaxCalls: 100 },
			{ plan: "hobby" },
		]) {
			const changed = structuredClone(wire);
			Object.assign(
				changed.offers.find((item: { id: string }) => item.id === "sandbox-a")
					.sandboxPricing,
				patch,
			);
			expect(
				(
					await t.request(
						"/v2/accounts/self/observations",
						"POST",
						"observer",
						changed,
						2,
					)
				).status,
			).toBe(400);
		}
		offer.observedAt = "2026-10-26T01:00:00Z";
		offer.sandboxPricing.cpuMicrosPerVcpuHour = 11;
		offer.sandboxAllowance = JSON.parse(
			toJsonString(
				SandboxAllowanceSchema,
				create(SandboxAllowanceSchema, { cpuVcpuMs: 3600000 }),
			),
		);
		expect(
			(
				await t.request(
					"/v2/accounts/self/observations",
					"POST",
					"observer",
					wire,
					2,
				)
			).status,
		).toBe(200);
		const saved = (
			await t.store.configuration()
		)?.configuration?.accounts[0]?.offers.find(
			(item) => item.id === "sandbox-a",
		);
		expect(saved?.sandboxPricing?.cpuMicrosPerVcpuHour).toBe(11);
		expect(saved?.sandboxAllowance?.cpuVcpuMs).toBe(3600000);
	});
	it("separates observation authority from policy authority and freezes policy fields", async () => {
		const t = setup();
		const account = (await t.store.configuration())?.configuration?.accounts[0];
		if (!account) throw new Error("fixture");
		const wire = JSON.parse(toJsonString(AccountSchema, account));
		wire.offers[0].freeMinutes = 3;
		wire.offers[0].observedAt = "2026-10-26T01:00:00Z";
		expect(
			(await t.request("/v2/accounts/self/observations", "POST", "admin", wire))
				.status,
		).toBe(403);
		expect(
			(
				await t.request(
					"/v2/accounts/self/observations",
					"POST",
					"observer",
					wire,
				)
			).status,
		).toBe(200);
		expect(
			(await t.store.configuration())?.configuration?.accounts[0]?.offers[0]
				?.freeMinutes,
		).toBe(3);
		wire.budgetMicros = 1;
		expect(
			(
				await t.request(
					"/v2/accounts/self/observations",
					"POST",
					"observer",
					wire,
					2,
				)
			).status,
		).toBe(400);
		expect((await t.store.configuration())?.revision).toBe(2);
	});
	it("rejects stale, conflicting and future financial snapshots while allowing a newer billing reset", async () => {
		const t = setup();
		const account = (await t.store.configuration())?.configuration?.accounts[0];
		if (!account) throw new Error("fixture");
		const original = JSON.parse(toJsonString(AccountSchema, account));
		const sameTime = structuredClone(original);
		sameTime.offers[0].freeMinutes = 100;
		const old = structuredClone(sameTime);
		old.offers[0].observedAt = "2026-10-25T23:00:00Z";
		const future = structuredClone(sameTime);
		future.offers[0].observedAt = "2026-10-26T12:01:00Z";
		const untimed = structuredClone(original);
		untimed.spentMicros = 1;
		for (const observation of [sameTime, old, future, untimed]) {
			expect(
				(
					await t.request(
						"/v2/accounts/self/observations",
						"POST",
						"observer",
						observation,
					)
				).status,
			).toBe(409);
			expect((await t.store.configuration())?.revision).toBe(1);
		}
		// Initial usage and a new billing-period reset are both legitimate when
		// explicitly timestamped; each refresh supersedes only earlier leases.
		const spent = structuredClone(original);
		spent.spentMicros = 100;
		spent.usageObservedAt = "2026-10-26T01:00:00Z";
		spent.offers[0].spentMicros = 100;
		spent.offers[0].observedAt = "2026-10-26T01:00:00Z";
		expect(
			(
				await t.request(
					"/v2/accounts/self/observations",
					"POST",
					"observer",
					spent,
				)
			).status,
		).toBe(200);
		const reset = structuredClone(spent);
		reset.spentMicros = 0;
		reset.usageObservedAt = "2026-10-26T02:00:00Z";
		reset.offers[0].freeMinutes = 20;
		reset.offers[0].spentMicros = 0;
		reset.offers[0].observedAt = "2026-10-26T02:00:00Z";
		expect(
			(
				await t.request(
					"/v2/accounts/self/observations",
					"POST",
					"observer",
					reset,
					2,
				)
			).status,
		).toBe(200);
		const conflicting = structuredClone(reset);
		conflicting.spentMicros = 1;
		expect(
			(
				await t.request(
					"/v2/accounts/self/observations",
					"POST",
					"observer",
					conflicting,
					3,
				)
			).status,
		).toBe(409);
		expect((await t.store.configuration())?.revision).toBe(3);
	});
	it("refuses unbound repository discovery before any GitHub network request", async () => {
		const t = setup();
		const result = await t.request(
			"/v1/accounts/self/repositories/prepare",
			"POST",
			"admin",
			{
				repository: "org/repo",
				installationId: 999,
				trustedRepositoryAcknowledged: true,
			},
		);
		expect(result.status).toBe(403);
		expect(t.h.api.violations).toEqual([]);
	});
	it("applies actual ordered Broker signals without changing operator intent or balances", async () => {
		const t = setup();
		const policy = { ...desired(), thresholds: [{ fraction: 1, allow: [] }] };
		const configuredProvider = policy.providers[0];
		if (!configuredProvider) throw new Error("missing provider fixture");
		configuredProvider.enabled = true;
		expect(
			(await t.request("/v2/accounts/self/policy", "PUT", "admin", policy))
				.status,
		).toBe(200);
		const signals = foldBudgetSignals(
			[
				{
					type: "meter.UsageRecorded",
					data: { tenantId: "account-a", costUsd: 100 },
				},
				{
					type: "budget.CreditApplied",
					data: { tenantId: "account-a", amountUsd: 25 },
				},
			],
			{ budgetUsd: 100, tenantId: "account-a", thresholds: [1] },
		).signals;
		expect(signals).toHaveLength(2);
		expect(
			(
				await t.request(
					"/v2/accounts/self/signals",
					"POST",
					"admin",
					signals[0],
					2,
				)
			).status,
		).toBe(403);
		expect(
			(
				await t.request(
					"/v2/accounts/self/signals",
					"POST",
					"observer",
					signals[0],
					2,
				)
			).status,
		).toBe(200);
		const record = await t.store.controlRecord("ci-policy:account-a");
		const compiled = parseCiPolicy(record?.bodyJson ?? "");
		const crossed = (await t.store.configuration())?.configuration?.accounts[0];
		if (!crossed) throw new Error("missing account");
		expect(crossed.offers[0]?.enabled).toBe(true);
		expect(crossed.offers[0]?.freeMinutes).toBe(10);
		expect(effectiveCiAccount(crossed, compiled).offers[0]?.enabled).toBe(
			false,
		);
		// Proto JSON accepts these special floating-point strings.  None is an
		// observed spend, and accepting them could release a threshold gate.
		for (const netSpentUsd of ["NaN", "Infinity", "-Infinity"]) {
			const recovery = signals[1];
			if (!recovery) throw new Error("missing recovery fixture");
			const invalid = {
				...recovery,
				data: { ...recovery.data, netSpentUsd },
			};
			expect(
				(
					await t.request(
						"/v2/accounts/self/signals",
						"POST",
						"observer",
						invalid,
						3,
					)
				).status,
			).toBe(400);
			expect((await t.store.configuration())?.revision).toBe(3);
		}
		const recovery = signals[1];
		if (!recovery) throw new Error("missing recovery fixture");
		// Broker net spend can be negative when credits exceed gross spend.
		const creditedRecovery = {
			...recovery,
			data: { ...recovery.data, netSpentUsd: -25 },
		};
		expect(
			(
				await t.request(
					"/v2/accounts/self/signals",
					"POST",
					"observer",
					creditedRecovery,
					3,
				)
			).status,
		).toBe(200);
		const recovered = (await t.store.configuration())?.configuration
			?.accounts[0];
		if (!recovered) throw new Error("missing account");
		expect(effectiveCiAccount(recovered, compiled).offers[0]?.enabled).toBe(
			true,
		);
		expect(
			(
				await t.request(
					"/v2/accounts/self/signals",
					"POST",
					"observer",
					signals[0],
					4,
				)
			).status,
		).toBe(200);
		expect((await t.store.configuration())?.revision).toBe(4);
		const foreign = structuredClone(signals[0]);
		if (!foreign) throw new Error("fixture");
		foreign.data.tenantId = "other";
		expect(
			(
				await t.request(
					"/v2/accounts/self/signals",
					"POST",
					"observer",
					foreign,
					4,
				)
			).status,
		).toBe(400);
		expect((await t.store.configuration())?.revision).toBe(4);
	});
	it("connects the scoped SDK and Station bridge to hosted policy and Broker signals", async () => {
		const t = setup();
		let conflict = true;
		const transport: typeof fetch = async (input, init) => {
			const req = new Request(input, init);
			if (
				req.method === "POST" &&
				new URL(req.url).pathname.endsWith("/signals") &&
				conflict
			) {
				conflict = false;
				return new Response("{}", { status: 409 });
			}
			return (await t.handler(req)) ?? new Response(null, { status: 404 });
		};
		const admin = createCiRelayClient({
			origin: "https://relay.example",
			accountToken: () => "admin",
			fetch: transport,
		});
		const observer = createCiRelayClient({
			origin: "https://relay.example",
			accountToken: () => "observer",
			fetch: transport,
		});
		const policy = { ...desired(), thresholds: [{ fraction: 1, allow: [] }] };
		const configuredProvider = policy.providers[0];
		if (!configuredProvider) throw new Error("missing provider fixture");
		configuredProvider.enabled = true;
		await admin.putDesiredPolicy(policy, { revision: 1 });
		const bridge = createHostedCiBudgetRoutingBridge({
			accountId: "account-a",
			tenantId: "account-a",
			client: observer,
		});
		const signals = foldBudgetSignals(
			[
				{
					type: "meter.UsageRecorded",
					data: { tenantId: "account-a", costUsd: 100 },
				},
				{
					type: "budget.CreditApplied",
					data: { tenantId: "account-a", amountUsd: 25 },
				},
			],
			{ budgetUsd: 100, tenantId: "account-a", thresholds: [1] },
		).signals;
		const crossed = signals[0];
		const recovered = signals[1];
		if (!crossed || !recovered) throw new Error("missing Broker signal");
		expect(await bridge.accept(JSON.stringify(crossed))).toEqual({
			changed: true,
			revision: 3,
		});
		let account = (await t.store.configuration())?.configuration?.accounts[0];
		if (!account) throw new Error("missing account");
		expect(
			effectiveCiAccount(account, parseCiPolicy(JSON.stringify(policy)))
				.offers[0]?.enabled,
		).toBe(false);
		expect(await bridge.accept(JSON.stringify(recovered))).toEqual({
			changed: true,
			revision: 4,
		});
		account = (await t.store.configuration())?.configuration?.accounts[0];
		if (!account) throw new Error("missing account");
		expect(
			effectiveCiAccount(account, parseCiPolicy(JSON.stringify(policy)))
				.offers[0]?.enabled,
		).toBe(true);
		expect(await bridge.accept(JSON.stringify(crossed))).toEqual({
			changed: false,
			revision: 4,
		});
		await expect(admin.getSignalState()).rejects.toMatchObject({ status: 403 });
		await expect(observer.getPolicy()).rejects.toMatchObject({ status: 403 });
	});
});

it("allows only account operators to inspect and replay their quarantined deliveries", async () => {
	const t = setup();
	const listing = [
		{
			deliveryId: "delivery-a",
			event: "workflow_job",
			installationId: 10,
			repositoryId: 101,
			receivedAt: NOW,
			attempts: 8,
		},
	];
	const requests: Array<[string, number, string]> = [];
	t.store.quarantinedWebhooks = async (account, rev) => {
		expect(rev).toBe(1);
		return account === "account-a" ? listing : [];
	};
	t.store.retryQuarantinedWebhook = async (account, rev, id) => {
		requests.push([account, rev, id]);
		return account === "account-a" && rev === 1 && id === "delivery-a";
	};
	const path = "/v2/accounts/self/inbox/quarantined";
	expect((await t.request(path, "GET", "neighbor")).status).toBe(403);
	const mine = await t.request(path);
	expect(mine.status).toBe(200);
	expect(await mine.json()).toEqual({ deliveries: listing });
	expect(await (await t.request(path, "GET", "ops-b")).json()).toEqual({
		deliveries: [],
	});
	expect(
		(
			await t.request(
				"/v2/accounts/self/inbox/delivery-a/retry",
				"POST",
				"ops-b",
			)
		).status,
	).toBe(404);
	expect(
		(await t.request("/v2/accounts/self/inbox/delivery-a/retry", "POST"))
			.status,
	).toBe(200);
	expect(requests).toEqual([
		["account-b", 1, "delivery-a"],
		["account-a", 1, "delivery-a"],
	]);
});
