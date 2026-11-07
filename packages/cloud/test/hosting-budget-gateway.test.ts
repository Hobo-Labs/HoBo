import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest } from "@hobo/bindles";
import { createInMemoryActorHost } from "@hobo/data";
import {
	createManualClock,
	createRuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import { deploy, type GatewayDeps } from "../src/gateway/gateway.js";
import type { SharedHostingBudgetAuthority } from "../src/hosting-transition/budget-authority.js";
import type { HostingPlanningInput } from "../src/planner/hosting-budget.js";

const close: (() => void)[] = [];
afterEach(() => {
	while (close.length) close.pop()?.();
});
const actor = { kind: "user", id: "operator" } as const;
const context = { tenant: "tenant", actor };
const manifest = parseManifest({
	schema: "hobo.manifest/v1",
	componentHost: { kind: "wasm", version: "1" },
	resources: {
		app: {
			type: "component.v1",
			image: "oci://example/app",
			runtime: "wasm",
			exports: ["wasi:http/incoming-handler"],
		},
	},
});
function evidence(): HostingPlanningInput {
	return {
		nowMs: 1000,
		horizonEndMs: 3_601_000,
		maxObservationAgeMs: 1000,
		budget: {
			budgetId: "hosting",
			tenantId: "tenant",
			scopeId: "camp:prod",
			periodId: "month",
			policyRevision: "r1",
			ledgerSeq: 1,
			currency: "USD",
			periodStartMs: 0,
			periodEndMs: 100_000_000,
			capMicros: 1000,
			settledMicros: 0,
			committedMicros: 0,
			unresolvedMicros: 0,
			recoveryReserveMicros: 0,
			observedAtMs: 1000,
			validUntilMs: 100_000_000,
			providerAccountId: "",
		},
		quotes: [
			{
				id: "q",
				resourceName: "app",
				definitionId: "host",
				providerId: "host",
				providerAccountId: "account:host",
				currency: "USD",
				rateMicros: 600,
				billingUnit: "hour",
				billingPeriodMs: 0,
				source: "https://example.test/quote",
				observedAtMs: 1000,
				validUntilMs: 100_000_000,
				liabilityEndsAtMs: 3_601_000,
				entitlementId: "",
				minimumQuantity: 0,
				roundUpQuantity: false,
				fixedCostMicros: 0,
				transitionCostMicros: 0,
			},
		],
		usages: [
			{
				resourceName: "app",
				unit: "time-ms",
				expectedQuantity: 3_600_000,
				boundedQuantity: 3_600_000,
			},
		],
		entitlements: [],
		providerBudgets: [],
	};
}
function fixtures(input = evidence(), deny = false) {
	const directory = mkdtempSync(join(tmpdir(), "hosting-gateway-"));
	const store = createRuntimeLocalEventStore({
		dataDir: directory,
		clock: createManualClock(),
	});
	close.push(() => {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	});
	let reserved = 0;
	let calls = 0;
	// Contract provider: admission is authoritative; the gateway never fabricates approval.
	const authority: SharedHostingBudgetAuthority = {
		persistence: "durable-cas",
		claimExecution: async () => ({ ok: true }),
		resolve: async () => input,
		reserve: async (request) => {
			calls++;
			if (
				deny ||
				reserved + request.commitment.reservedMicros > input.budget.capMicros
			)
				return {
					ok: false,
					reason: "another deployment reserved the remaining allowance",
				};
			reserved += request.commitment.reservedMicros;
			return { ok: true, reservationId: request.reservationId };
		},
		lookup: async () => ({ status: "held", reservedMicros: reserved }),
		uncertain: async () => {},
		settle: async () => ({ ok: true }),
	};
	const definition = {
		id: "host",
		providerId: "host",
		port: "compute",
		features: ["http"],
		regions: ["us"],
		specificity: 1,
		priority: 0,
		cost: { sku: "host", unit: "hour", marginalPrice: "0.0006" },
		satisfies: () => ({ kind: "full" as const }),
	};
	const deps: GatewayDeps = {
		store,
		actorHost: createInMemoryActorHost(),
		registry: {
			catalogHash: "sha256:test",
			definitions: () => [definition],
			providers: () => [definition.providerId],
		},
		hostingBudgetAuthority: authority,
	};
	return { deps, calls: () => calls, reserved: () => reserved };
}
const command = (deploymentId: string) => ({
	deploymentId,
	bindle: manifest,
	config: { budgetId: "hosting", objective: "maximize-credits" },
});

describe("gateway financial admission boundary", () => {
	it.each([
		{ policy: { budget: null } },
		{ policy: { budget: [] } },
		{ policy: { budget: "monthly" } },
		{ policy: { costAvailabilityProfile: null } },
		{ policy: { costAvailabilityProfile: [] } },
		{ policy: { costAvailabilityProfile: "cheap" } },
	])("rejects malformed financial declarations before reserving: %j", async ({
		policy,
	}) => {
		const fx = fixtures();
		const result = await deploy(
			fx.deps,
			{
				...command("malformed"),
				bindle: parseManifest({ ...manifest.value, policy }),
			},
			context,
		);
		expect(result.status).toBe("rejected");
		expect(fx.calls()).toBe(0);
	});
	it("enforces authored ceilings, accounting periods and per-action caps before reservation", async () => {
		for (const policy of [
			{ budget: { hardLimitUsd: 0.0005 } },
			{ budget: { hardLimitUsd: 0.001, period: "monthly" } },
			{ spendCapUsd: 0.0005 },
		]) {
			const fx = fixtures();
			const result = await deploy(
				fx.deps,
				{
					...command("policy"),
					bindle: parseManifest({ ...manifest.value, policy }),
				},
				context,
			);
			expect(result.status).toBe("rejected");
			expect(fx.calls()).toBe(0);
		}
	});
	it("does not erase an authored budget when no budget ID was supplied", async () => {
		const fx = fixtures();
		const result = await deploy(
			fx.deps,
			{
				deploymentId: "no-budget-id",
				bindle: parseManifest({
					...manifest.value,
					policy: { budget: { hardLimitUsd: 1 } },
				}),
			},
			context,
		);
		expect(result.status).toBe("rejected");
		expect(fx.calls()).toBe(0);
	});
	it("reserves the complete plan before publishing deployment.Planned", async () => {
		const fx = fixtures();
		const result = await deploy(fx.deps, command("one"), context);
		expect(result.status).toBe("planned");
		expect(fx.reserved()).toBe(600);
		const facts = [];
		for await (const event of fx.deps.store.read("deployment:one"))
			facts.push(event.type);
		expect(facts.indexOf("hosting.BudgetReserved")).toBeLessThan(
			facts.indexOf("deployment.Planned"),
		);
	});
	it("honours a reservation race loser even though its pure plan was affordable", async () => {
		const fx = fixtures();
		const results = await Promise.all([
			deploy(fx.deps, command("one"), context),
			deploy(fx.deps, command("two"), context),
		]);
		expect(results.map((result) => result.status).sort()).toEqual([
			"planned",
			"rejected",
		]);
		expect(fx.reserved()).toBe(600);
	});
	it("replays a completed identical request without consuming the budget again", async () => {
		const fx = fixtures();
		const first = await deploy(fx.deps, command("one"), context),
			replay = await deploy(fx.deps, command("one"), context);
		expect(replay).toEqual(first);
		expect(fx.calls()).toBe(1);
		await expect(
			deploy(
				fx.deps,
				{
					...command("one"),
					config: { budgetId: "another", objective: "maximize-credits" },
				},
				context,
			),
		).rejects.toThrow("different input");
	});
	it("rejects a foreign tenant snapshot before any reservation", async () => {
		const input = evidence();
		const fx = fixtures({
			...input,
			budget: { ...input.budget, tenantId: "foreign" },
		});
		expect((await deploy(fx.deps, command("one"), context)).status).toBe(
			"rejected",
		);
		expect(fx.calls()).toBe(0);
	});
	it("refuses cross-tenant replay of the same deployment ID", async () => {
		const fx = fixtures();
		await deploy(fx.deps, command("one"), context);
		await expect(
			deploy(fx.deps, command("one"), { tenant: "foreign", actor }),
		).rejects.toThrow("different tenant");
	});
	it("refuses budget admission when no durable authority was configured", async () => {
		const fx = fixtures();
		delete fx.deps.hostingBudgetAuthority;
		const result = await deploy(fx.deps, command("one"), context);
		expect(result.status).toBe("rejected");
		if (result.status === "rejected")
			expect(result.remediations[0]?.code).toBe("budget.authority-required");
	});
	it("never publishes a planned fact when financial admission is denied", async () => {
		const fx = fixtures(evidence(), true);
		expect((await deploy(fx.deps, command("one"), context)).status).toBe(
			"rejected",
		);
		const facts = [];
		for await (const event of fx.deps.store.read("deployment:one"))
			facts.push(event.type);
		expect(facts).toEqual(["deployment.Requested", "deployment.PlanRejected"]);
	});
});
