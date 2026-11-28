import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Table } from "@alchemy.run/aws/DynamoDB";
import { Providers } from "@alchemy.run/aws/Providers";
import { inMemoryState, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import type { ResourceClass, ResourceLike } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, it } from "vitest";
import { bindle } from "../../../bindles/src/bindle.js";
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
import {
	awsDynamoDurableQueueMappers,
	withAwsDynamoDurableQueue,
} from "../src/aws-queue-mapper.js";
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

it("requires explicit pricing coverage for the mapped durable queue table", async () => {
	const dir = mkdtempSync(join(tmpdir(), "hobo-queue-plan-"));
	const prior = process.env.ALCHEMY_HOME;
	process.env.ALCHEMY_HOME = join(dir, "auth");
	try {
		const app = bindle("jobs-app", (b) => ({
			jobs: b.queue().allow("enqueue", "dequeue"),
		}));
		const program = mapBindleToAlchemy(
			withAwsDynamoDurableQueue(app, { jobs: true }),
			awsDynamoDurableQueueMappers(),
			{ assessRequirements: () => ({ status: "supported" }) },
		);
		const providers = Layer.effect(
			Providers,
			Provider.collection([Table]),
		).pipe(Layer.provide(stub(Table)));
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
						resourceId: "jobs",
						resourceType: Table.Type,
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
					scope.length === 1 &&
					effects.length === 0 &&
					sourceClaims.length === 0,
			},
			financial: {
				assess: (inventory) => {
					observed[observed.length] = inventory;
					return { inventory };
				},
				admit: async () => {
					throw new Error("unexpected admission");
				},
				revalidate: () => false,
				uncertain: () => {},
			},
		});
		const preview = await provider.preview({
			programId: "p",
			deploymentId: "d",
			resourceId: "app",
			provider: "aws",
			driver: "external",
			action: "apply",
			stackName: "Demo",
		});
		expect(preview.changes).toBe(1);
		const plan = observed[0];
		if (!plan) throw Error("financial preview missing");
		expect(plan.resources.map((resource) => resource.resourceId)).toEqual([
			"jobs",
		]);
		// SAFETY: assessment does not call the authority or admission callbacks.
		const authority = {} as IacFinancialServicesOptions["authority"];
		const base = {
			authority,
			now: () => "2026-01-02T00:00:00Z",
			verifyLiability: () => false,
			authorize: () => {
				throw Error("unexpected authorization");
			},
			issueLiability: () => {
				throw Error("unexpected liability");
			},
		};
		expect(createIacFinancialServices(base).assess(plan)).toMatchObject({
			quote: { ok: false, code: "PRICING_MODEL_UNAVAILABLE" },
			budget: { evaluation: "not-evaluated" },
		});
		expect(
			createIacFinancialServices({
				...base,
				unpriced: {
					authorize: () => {
						throw Error("unexpected authorization");
					},
				},
			}).assess(plan),
		).toMatchObject({
			admissionPath: {
				kind: "unpriced-policy",
				budget: "bypassed-if-authorized",
			},
			budget: { evaluation: "not-evaluated", reservation: "not-created" },
		});
		const scenario = makeScenario({
			charges: [perUnitCharge("runtime", "minute", "0.25")],
			candidate: [workload("agreement-a", [usage("minute", "4", "minute")])],
		});
		const incomplete = createIacFinancialServices({
			...base,
			unpriced: {
				authorize: () => {
					throw Error("unexpected authorization");
				},
			},
			pricing: { modelId: "terms", revision: "1", scenario, bindings: [] },
		}).assess(plan);
		expect(incomplete).toMatchObject({
			quote: { ok: false, code: "TARGET_PRICING_INCOMPLETE" },
			admissionPath: { kind: "unavailable", code: "TARGET_PRICING_INCOMPLETE" },
		});
		const priced = createIacFinancialServices({
			...base,
			pricing: {
				modelId: "terms",
				revision: "1",
				scenario,
				bindings: [{ resourceId: "jobs", candidateIndex: 0 }],
			},
		}).assess(plan);
		expect(priced).toMatchObject({
			quote: { ok: true },
			admissionPath: { kind: "bounded-budget", budget: "evaluation-required" },
			budget: { evaluation: "not-evaluated" },
		});
	} finally {
		if (prior === undefined) delete process.env.ALCHEMY_HOME;
		else process.env.ALCHEMY_HOME = prior;
		rmSync(dir, { recursive: true, force: true });
	}
}, 30000);
