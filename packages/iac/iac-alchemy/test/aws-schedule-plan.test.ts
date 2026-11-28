import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Providers } from "@alchemy.run/aws/Providers";
import { Schedule } from "@alchemy.run/aws/Scheduler";
import { Queue } from "@alchemy.run/aws/SQS";
import { inMemoryState, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import type { ResourceClass, ResourceLike } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, it } from "vitest";
import { bindle } from "../../../bindles/src/bindle.js";
import { cadence } from "../../../bindles/src/cadence.js";
import {
	createIacFinancialServices,
	type IacFinancialServicesOptions,
} from "../../../broker/src/iac-financial-services.js";
import {
	makeScenario,
	perUnitCharge,
	usage,
	workload,
} from "../../../pricing/test/fixtures.js";
import { awsBindleMappers } from "../src/aws.js";
import { awsStaticScheduleMappers } from "../src/aws-schedule.js";
import { mapBindleToAlchemy } from "../src/bindle.js";
import {
	alchemyTarget,
	createAlchemyIacProvider,
	type FinancialPlan,
} from "../src/index.js";
import { testStateOwnership } from "./route-fixture.js";

function stub<R extends ResourceLike>(resource: ResourceClass<R>) {
	return Provider.succeed(resource, {
		precreate: () => Effect.die(new Error("unexpected provider effect")),
		reconcile: () => Effect.die(new Error("unexpected provider effect")),
		delete: () => Effect.void,
	});
}

it("requires pricing coverage for the mapped schedule and queue", async () => {
	const dir = mkdtempSync(join(tmpdir(), "hobo-schedule-plan-"));
	const prior = process.env.ALCHEMY_HOME;
	process.env.ALCHEMY_HOME = join(dir, "auth");
	try {
		const app = bindle("shop", (b) => {
			const queue = b.queue();
			return {
				queue,
				tick: b.schedule().dependsOn(queue).with(cadence("* * * * *")),
			};
		});
		const mappers = awsStaticScheduleMappers(awsBindleMappers(), {
			tick: {
				roleArn: "arn:aws:iam::123456789012:role/scheduler-send",
				input: "tick",
			},
		});
		const program = mapBindleToAlchemy(app, mappers, {
			assessRequirements: () => ({ status: "supported" }),
		});
		const providers = Layer.effect(
			Providers,
			Provider.collection([Queue, Schedule]),
		).pipe(Layer.provide(Layer.mergeAll(stub(Queue), stub(Schedule))));
		const stack = Stack(
			"Demo",
			{ providers, state: inMemoryState() },
			program.pipe(Effect.map(() => ({}))),
		);
		const observed: FinancialPlan[] = [];
		const provider = createAlchemyIacProvider({
			stack,
			stateOwnership: testStateOwnership,
			runtimeLayer: Alchemist.layer(),
			runtimeDirectory: join(dir, "runtime"),
			target: alchemyTarget({
				targetId: "yard",
				tenantId: "tenant-a",
				stackName: "Demo",
				stage: "test",
				programResourceId: "app",
				sourceDigest: `sha256:${"a".repeat(64)}`,
				inventoryEvidenceRef: "inventory:1",
				resources: [
					{
						resourceId: "queue",
						resourceType: Queue.Type,
						providerId: "sandbox",
						providerAccountRef: "account-a",
						productId: "sandbox",
					},
					{
						resourceId: "tick",
						resourceType: Schedule.Type,
						providerId: "sandbox",
						providerAccountRef: "account-a",
						productId: "sandbox",
					},
				],
			}),
			composite: {
				proofRef: "host:test",
				environmentDigest: `sha256:${"b".repeat(64)}`,
				sourceRequirements: [],
				verifyEnvironment: () => true,
				verifyPlan: ({ scope, effects, sourceClaims }) =>
					scope.length === 2 &&
					effects.length === 0 &&
					sourceClaims.length === 0,
			},
			financial: {
				assess: (inventory) => {
					observed.push(inventory);
					return { inventory };
				},
				admit: async () => {
					throw new Error("unexpected admission");
				},
				revalidate: () => false,
				uncertain: () => {},
			},
		});
		const diff = await provider.preview({
			programId: "p",
			deploymentId: "d",
			resourceId: "app",
			provider: "aws",
			driver: "external",
			action: "apply",
			stackName: "Demo",
		});
		expect(diff.changes).toBe(2);
		const plan = observed[0];
		if (!plan) throw new Error("financial preview missing");
		expect(
			plan.resources.map((resource) => resource.resourceId).sort(),
		).toEqual(["queue", "tick"]);
		const scenario = makeScenario({
			charges: [perUnitCharge("runtime", "minute", "0.25")],
			candidate: [
				workload("agreement-a", [usage("minute", "4", "minute")]),
				workload("agreement-a", [usage("minute", "4", "minute")]),
			],
		});
		// SAFETY: assessment does not call the authority or admission callbacks.
		const authority = {} as IacFinancialServicesOptions["authority"];
		const base = {
			authority,
			now: () => "2026-01-02T00:00:00Z",
			verifyLiability: () => false,
			authorize: () => {
				throw new Error("unexpected authorization");
			},
			issueLiability: () => {
				throw new Error("unexpected liability request");
			},
		};
		const unpriced = createIacFinancialServices(base).assess(plan);
		expect(unpriced).toMatchObject({
			quote: { ok: false, code: "PRICING_MODEL_UNAVAILABLE" },
			budget: { evaluation: "not-evaluated" },
		});
		const permittedUnpriced = createIacFinancialServices({
			...base,
			unpriced: {
				authorize: () => {
					throw new Error("unexpected unpriced authorization");
				},
			},
		}).assess(plan);
		expect(permittedUnpriced).toMatchObject({
			admissionPath: {
				kind: "unpriced-policy",
				budget: "bypassed-if-authorized",
			},
			budget: { evaluation: "not-evaluated", reservation: "not-created" },
		});
		const partial = createIacFinancialServices({
			...base,
			unpriced: {
				authorize: () => {
					throw new Error("unexpected unpriced authorization");
				},
			},
			pricing: {
				modelId: "terms",
				revision: "1",
				scenario,
				bindings: [{ resourceId: "queue", candidateIndex: 0 }],
			},
		}).assess(plan);
		expect(partial.quote).toMatchObject({
			ok: false,
			code: "TARGET_PRICING_INCOMPLETE",
		});
		expect(partial.admissionPath).toEqual({
			kind: "unavailable",
			code: "TARGET_PRICING_INCOMPLETE",
		});
		const complete = createIacFinancialServices({
			...base,
			pricing: {
				modelId: "terms",
				revision: "1",
				scenario,
				bindings: [
					{ resourceId: "queue", candidateIndex: 0 },
					{ resourceId: "tick", candidateIndex: 1 },
				],
			},
		}).assess(plan);
		if (!complete.quote.ok) throw new Error(JSON.stringify(complete.quote));
		expect(complete).toMatchObject({
			quote: { ok: true },
			admissionPath: { kind: "bounded-budget", budget: "evaluation-required" },
			budget: { evaluation: "not-evaluated" },
		});
	} finally {
		if (prior === undefined) delete process.env.ALCHEMY_HOME;
		else process.env.ALCHEMY_HOME = prior;
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);
