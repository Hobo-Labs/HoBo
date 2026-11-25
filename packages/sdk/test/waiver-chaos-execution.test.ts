import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	evaluatePolicyPack,
	type PolicyDecisionRequest,
} from "@hobo/contracts";
import {
	createManualClock,
	createRuntimeLocalEventStore,
	type RuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import { chaos } from "../src/chaos.js";
import { policyPack, rule } from "../src/policy.js";
import { waiver } from "../src/waiver.js";
import {
	type ChaosExecutionOptions,
	createCampChaosTarget,
	createFetchChaosTarget,
	createWaiverService,
	executeChaosExperiment,
	replayChaosExecution,
} from "../src/waiver-chaos-execution.js";

const stores: RuntimeLocalEventStore[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const store of stores.splice(0)) store.close();
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true });
});
async function context() {
	const dataDir = await mkdtemp(join(tmpdir(), "sdk-operator-execution-"));
	dirs.push(dataDir);
	const clock = createManualClock("2026-07-01T00:00:00.000Z");
	const store = createRuntimeLocalEventStore({ dataDir, clock });
	stores.push(store);
	return {
		store,
		clock,
		tenant: "acme",
		actor: { kind: "user" as const, id: "alice" },
		actorScopes: ["resource.delete"],
		now: clock.now,
		dataDir,
	};
}
const request: PolicyDecisionRequest = {
	subject: { kind: "user", id: "alice", scopes: ["resource.delete"] },
	action: "resource.delete",
	resource: { kind: "resource", id: "db" },
	phase: "apply",
};
const pack = policyPack("default-deny", {}, [
	rule("deny-delete", {
		phase: "apply",
		when: { action: "resource.delete" },
		effect: "deny",
	}),
]);
const approver = {
	kind: "user" as const,
	id: "bob",
	roles: ["security-admin"],
};
function declaration() {
	return waiver(evaluatePolicyPack({ request, pack }).event.id, {
		reason: "controlled maintenance",
		approver: "role:security-admin",
		expires: "2026-07-01T00:01:00.000Z",
	});
}

describe("durable waiver execution", () => {
	it("fences concurrent approval and revocation against the state that authorized each command", async () => {
		const ctx = await context();
		const requester = createWaiverService(ctx);
		const approval = createWaiverService({
			...ctx,
			actor: approver,
			actorRoles: approver.roles,
		});
		await requester.request(declaration(), request, pack);
		const results = await Promise.allSettled([
			approval.approve(declaration().decisionId, approver),
			requester.revoke(declaration().decisionId),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			results.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		const final = await requester.status(declaration().decisionId);
		expect(final.revision).toBe(2);
		expect(final.status).toBe(
			results[0]?.status === "fulfilled" ? "approved" : "revoked",
		);
	});

	it("requires host-verified base grants and cannot impersonate a request subject", async () => {
		const ctx = await context();
		const missing = createWaiverService({ ...ctx, actorScopes: undefined });
		await expect(missing.request(declaration(), request, pack)).rejects.toThrow(
			/base access/,
		);
		const denied = createWaiverService({ ...ctx, actorScopes: [] });
		// The request body already claims resource.delete; host metadata deliberately grants nothing.
		await expect(denied.request(declaration(), request, pack)).rejects.toThrow(
			/base access/,
		);
		const authorized = createWaiverService(ctx);
		await authorized.request(declaration(), request, pack);
		await createWaiverService({
			...ctx,
			actor: approver,
			actorRoles: approver.roles,
		}).approve(declaration().decisionId, approver);
		expect((await authorized.evaluate(request, pack)).effect).toBe("allow");
		expect((await denied.evaluate(request, pack)).effect).toBe("deny");
		expect(
			(
				await createWaiverService({ ...ctx, actor: approver }).evaluate(
					request,
					pack,
				)
			).effect,
		).toBe("deny");
	});

	it("keeps the same policy decision independent across tenants in one durable store", async () => {
		const ctx = await context();
		const first = createWaiverService({ ...ctx, tenant: "acme:team" });
		const second = createWaiverService({ ...ctx, tenant: "acme" });
		await first.request(declaration(), request, pack);
		await second.request(declaration(), request, pack);
		await createWaiverService({
			...ctx,
			tenant: "acme:team",
			actor: approver,
			actorRoles: approver.roles,
		}).approve(declaration().decisionId, approver);
		expect((await first.evaluate(request, pack)).effect).toBe("allow");
		expect((await second.evaluate(request, pack)).effect).toBe("deny");
		expect((await second.status(declaration().decisionId)).status).toBe(
			"requested",
		);
		await createWaiverService({
			...ctx,
			tenant: "acme",
			actor: approver,
			actorRoles: approver.roles,
		}).approve(declaration().decisionId, approver);
		await second.revoke(declaration().decisionId);
		expect((await first.status(declaration().decisionId)).status).toBe(
			"approved",
		);
		expect((await second.status(declaration().decisionId)).status).toBe(
			"revoked",
		);
	});

	it("changes a real policy denial only after independent approval and expires after restart", async () => {
		const ctx = await context();
		const service = createWaiverService(ctx);
		expect((await service.evaluate(request, pack)).effect).toBe("deny");
		await service.request(declaration(), request, pack);
		await expect(
			service.approve(declaration().decisionId, { ...approver, id: "alice" }),
		).rejects.toThrow(/separation/);
		await expect(
			createWaiverService({ ...ctx, actor: approver, actorRoles: [] }).approve(
				declaration().decisionId,
				{ ...approver, roles: ["security-admin"] },
			),
		).rejects.toThrow(/not authorized/);
		await expect(
			service.approve(declaration().decisionId, approver),
		).rejects.toThrow(/authenticated service actor/);
		await createWaiverService({
			...ctx,
			actor: approver,
			actorRoles: approver.roles,
		}).approve(declaration().decisionId, approver);
		expect((await service.evaluate(request, pack)).effect).toBe("allow");
		expect(
			(await service.evaluate(request, { ...pack, version: "2.0.0" })).effect,
		).toBe("deny");
		expect(
			(
				await service.evaluate(
					{ ...request, resource: { kind: "resource", id: "other-db" } },
					pack,
				)
			).effect,
		).toBe("deny");
		ctx.store.close();
		stores.pop();
		const reopened = createRuntimeLocalEventStore({
			dataDir: ctx.dataDir,
			clock: ctx.clock,
		});
		stores.push(reopened);
		const resumed = createWaiverService({ ...ctx, store: reopened });
		expect((await resumed.evaluate(request, pack)).effect).toBe("allow");
		ctx.clock.advance(60_000);
		expect((await resumed.evaluate(request, pack)).effect).toBe("deny");
		expect((await resumed.status(declaration().decisionId)).status).toBe(
			"expired",
		);
		const events = [];
		for await (const event of reopened.read(
			`sdk-waiver:${JSON.stringify(["acme", declaration().decisionId])}`,
		))
			events.push(event.type);
		expect(events).toEqual([
			"policy.WaiverRequested",
			"policy.WaiverApproved",
			"policy.WaiverExpired",
		]);
	});
	it("refuses mandatory ceilings and missing base authorization, and applies revocation", async () => {
		const ctx = await context();
		const service = createWaiverService(ctx);
		await expect(
			service.request(declaration(), request, { ...pack, mandatory: true }),
		).rejects.toThrow(/default policy/);
		const noAccess = {
			...request,
			subject: { ...request.subject, scopes: [] },
		};
		const noAccessWaiver = waiver(
			evaluatePolicyPack({ request: noAccess, pack }).event.id,
			declaration(),
		);
		await expect(
			createWaiverService({ ...ctx, actorScopes: [] }).request(
				noAccessWaiver,
				noAccess,
				pack,
			),
		).rejects.toThrow(/base access/);
		await service.request(declaration(), request, pack);
		await expect(
			service.approve(declaration().decisionId, approver),
		).rejects.toThrow(/authenticated service actor/);
		await createWaiverService({
			...ctx,
			actor: approver,
			actorRoles: approver.roles,
		}).approve(declaration().decisionId, approver);
		expect(
			(await service.evaluate(request, { ...pack, mandatory: true })).effect,
		).toBe("deny");
		await service.revoke(declaration().decisionId);
		expect((await service.evaluate(request, pack)).effect).toBe("deny");
	});
});

async function chaosOptions() {
	const ctx = await context();
	const target = createFetchChaosTarget(
		"private-api",
		() => new Response("healthy", { status: 200 }),
	);
	const options: ChaosExecutionOptions = {
		...ctx,
		actorScopes: ["chaos.execute"],
		executionId: "chaos-1",
		target,
		pack: policyPack("chaos-budget", {}, []),
		authorization: {
			subject: { kind: "user", id: "alice" },
			action: "chaos.execute",
			resource: { kind: "service", id: target.id },
			phase: "apply",
		},
		checks: {
			healthy: {
				request: new Request("http://private-api/health"),
				expectedStatus: 200,
			},
			unhealthy: {
				request: new Request("http://private-api/health"),
				expectedStatus: 503,
			},
		},
	};
	return options;
}
function experiment(fault: string) {
	return chaos("api-fault", {
		steadyState: "healthy",
		inject: { fault, target: "private-api" },
		blastRadius: "1 target",
		abortIf: "unhealthy",
	});
}

describe("isolated chaos execution", () => {
	it("reserves an execution id before fault effects when identical submissions race", async () => {
		const options = await chaosOptions();
		const results = await Promise.allSettled([
			executeChaosExperiment(experiment("latency:1"), options),
			executeChaosExperiment(experiment("latency:1"), options),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			results.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		const recorded = await replayChaosExecution(options, options.executionId);
		expect(recorded.status).toBe("completed");
		expect(
			recorded.events.filter((event) => event.type === "chaos.FaultInjected"),
		).toHaveLength(1);
	});

	it("refuses chaos without host-verified action grants despite claimed body scopes", async () => {
		const options = await chaosOptions();
		await expect(
			executeChaosExperiment(experiment("latency:1"), {
				...options,
				actorScopes: [],
				authorization: {
					...options.authorization,
					subject: {
						...options.authorization.subject,
						scopes: ["chaos.execute"],
					},
				},
			}),
		).rejects.toThrow(/authorization does not match/);
		expect(
			(await replayChaosExecution(options, options.executionId)).events,
		).toEqual([]);
	});

	it.each([
		{ leftTenant: "acme", leftId: "run", rightTenant: "beta", rightId: "run" },
		{
			leftTenant: "acme:team",
			leftId: "run",
			rightTenant: "acme",
			rightId: "team:run",
		},
	])("isolates durable executions for $leftTenant/$leftId and $rightTenant/$rightId", async ({
		leftTenant,
		leftId,
		rightTenant,
		rightId,
	}) => {
		const options = await chaosOptions();
		const left = { ...options, tenant: leftTenant, executionId: leftId };
		const right = { ...options, tenant: rightTenant, executionId: rightId };
		expect(
			await executeChaosExperiment(experiment("unavailable"), left),
		).toMatchObject({ status: "aborted" });
		expect(
			await executeChaosExperiment(experiment("latency:1"), right),
		).toMatchObject({ status: "completed" });
		expect((await replayChaosExecution(left, leftId)).status).toBe("aborted");
		expect((await replayChaosExecution(right, rightId)).status).toBe(
			"completed",
		);
	});

	it("injects an observed fault, aborts a breached invariant and restores the actual handler", async () => {
		const options = await chaosOptions();
		expect(
			await executeChaosExperiment(experiment("unavailable"), options),
		).toMatchObject({ status: "aborted" });
		expect(
			(await options.target.fetch(new Request("http://private-api/health")))
				.status,
		).toBe(200);
		const replayed = await replayChaosExecution(options, options.executionId);
		expect(replayed.status).toBe("aborted");
		expect(replayed.events.map((event) => event.type)).toEqual([
			"policy.Decided",
			"chaos.ExperimentStarted",
			"chaos.FaultInjected",
			"chaos.SteadyStateChecked",
			"chaos.FaultRemoved",
			"chaos.Aborted",
		]);
	});
	it("completes only after a faulted request was observed and cleanup health passed", async () => {
		const options = await chaosOptions();
		expect(
			await executeChaosExperiment(experiment("latency:1"), options),
		).toMatchObject({ status: "completed" });
		expect(
			(await replayChaosExecution(options, options.executionId)).status,
		).toBe("completed");
		await expect(
			executeChaosExperiment(experiment("latency:1"), options),
		).rejects.toThrow(/already been used/);
	});
	it("does not execute denied experiments or missing invariant checks", async () => {
		const options = await chaosOptions();
		const denied = policyPack("deny-chaos", { mandatory: true }, [
			rule("no-chaos", {
				phase: "apply",
				when: { action: "chaos.execute" },
				effect: "deny",
			}),
		]);
		await expect(
			executeChaosExperiment(experiment("error"), { ...options, pack: denied }),
		).rejects.toThrow(/did not allow/);
		expect(
			(await replayChaosExecution(options, options.executionId)).events.map(
				(event) => event.type,
			),
		).toEqual(["policy.Decided"]);
		await expect(
			executeChaosExperiment(experiment("error"), {
				...options,
				executionId: "chaos-missing",
				checks: {},
			}),
		).rejects.toThrow(/no executable check/);
	});
	it("removes faults when the fault makes the probe throw", async () => {
		const options = await chaosOptions();
		expect(
			await executeChaosExperiment(experiment("error"), options),
		).toMatchObject({ status: "aborted" });
		expect(
			(await options.target.fetch(new Request("http://private-api/health")))
				.status,
		).toBe(200);
		expect(
			(await replayChaosExecution(options, options.executionId)).events.some(
				(event) => event.type === "chaos.FaultRemoved",
			),
		).toBe(true);
	});
	it("executes the declared 1 camp radius on an isolated multi-target membrane", async () => {
		const options = await chaosOptions();
		const api = createFetchChaosTarget(
			"api",
			() => new Response("api", { status: 200 }),
		);
		const worker = createFetchChaosTarget(
			"worker",
			() => new Response("worker", { status: 200 }),
		);
		const camp = createCampChaosTarget("camp-staging", [api, worker]);
		const lease = await camp.inject("unavailable");
		expect((await camp.fetch(new Request("http://api/health"))).status).toBe(
			503,
		);
		expect((await camp.fetch(new Request("http://worker/health"))).status).toBe(
			503,
		);
		expect(lease.observedCalls()).toBe(2);
		await lease.remove();
		const declaration = chaos("camp-degradation", {
			steadyState: "healthy",
			inject: { fault: "provider-degraded", target: camp.id },
			blastRadius: "1 camp",
		});
		const scoped = {
			...options,
			target: camp,
			checks: {
				healthy: {
					request: new Request("http://api/health"),
					expectedStatus: 200,
				},
			},
			authorization: {
				...options.authorization,
				resource: { kind: "camp", id: camp.id },
			},
		};
		expect(await executeChaosExperiment(declaration, scoped)).toMatchObject({
			status: "aborted",
		});
		expect((await camp.fetch(new Request("http://api/health"))).status).toBe(
			200,
		);
		expect((await camp.fetch(new Request("http://worker/health"))).status).toBe(
			200,
		);
		await expect(
			camp.fetch(new Request("http://production/health")),
		).rejects.toThrow(/undeclared/);
		const recorded = await replayChaosExecution(options, options.executionId);
		expect(recorded.events[0]?.data).toMatchObject({
			effect: "allow",
			evidence: { engine: "hobo.contracts/policy-pack@0.1.0" },
		});
	});
});
