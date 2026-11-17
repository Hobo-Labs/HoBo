import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inMemoryState, Resource, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import { State, type StateService } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, it } from "vitest";
import {
	alchemyTarget,
	createAlchemyIacProvider,
	type FinancialPlan,
} from "../src/index.js";
import { registerAlchemySource } from "../src/source-fence.js";
import { routeFixture, testOperation } from "./route-fixture.js";

type Widget = Resource<"Spec.Widget", { value: string }, { id: string }>;
const Widget = Resource<Widget>("Spec.Widget");
const program = {
	programId: "p",
	deploymentId: "d",
	resourceId: "app",
	provider: "test",
	driver: "external",
	action: "apply" as const,
	stackName: "App",
	operationGeneration: "generation",
};

function fixture(
	directory: string,
	mutate: false | "change" | "uninspectable",
	source = false,
) {
	let current: Widget | undefined;
	let armed = false;
	let providerStarted = false;
	let mutations = 0;
	let callbacksAfterFinalScan = 0;
	const uncertain: string[] = [];
	const callback = () => {
		if (mutations > 0 && !providerStarted) callbacksAfterFinalScan++;
		return true;
	};
	const requirement = {
		resourceId: "widget",
		resourceType: "Spec.Widget",
		bindleName: "app",
		applicationName: "widget",
		sourceKind: "test",
		sourcePath: "/source/widget",
	};
	const state = Layer.effect(
		State,
		Effect.map(State, (effect) =>
			Effect.map(effect, (service) => {
				const guarded: StateService = Object.assign(Object.create(service), {
					list: (request: Parameters<StateService["list"]>[0]) => {
						if (armed) {
							armed = false;
							if (mutate === "change" && current !== undefined)
								Object.assign(current.Props, {
									value: "changed during state scan",
								});
							if (mutate === "uninspectable" && current !== undefined)
								Object.defineProperty(current.Props, "uninspectable", {
									enumerable: true,
									get() {
										throw new Error("must not run");
									},
								});
							mutations++;
						}
						return service.list(request);
					},
				});
				return guarded;
			}),
		),
	).pipe(Layer.provide(inMemoryState()));
	const stack = Stack(
		"App",
		{
			providers: Provider.succeed(Widget, {
				reconcile: () =>
					Effect.sync(() => {
						providerStarted = true;
						return { id: "widget" };
					}),
				delete: () => Effect.void,
			}),
			state,
		},
		Effect.gen(function* () {
			current = yield* Widget("widget", { value: "approved" });
			if (source)
				registerAlchemySource(current, {
					claim: {
						...requirement,
						sourceDigest: `sha256:${"a".repeat(64)}`,
						environmentDigest: `sha256:${"b".repeat(64)}`,
						proofRef: "host",
					},
					verify: callback,
				});
			return {};
		}),
	);
	const provider = createAlchemyIacProvider({
		stack,
		stateOwnership: {
			backendRef: "test:state",
			ownershipEpoch: "test:epoch",
			verify: callback,
		},
		route: routeFixture().port,
		resolveRoute: ({ requestId }) => ({
			requestId: requestId ?? "request",
			operation: testOperation,
		}),
		runtimeLayer: Alchemist.layer(),
		runtimeDirectory: directory,
		target: alchemyTarget({
			targetId: "t",
			tenantId: "tenant",
			stackName: "App",
			stage: "test",
			programResourceId: "app",
			sourceDigest: `sha256:${"a".repeat(64)}`,
			inventoryEvidenceRef: "inventory",
			resources: [
				{
					resourceId: "widget",
					resourceType: "Spec.Widget",
					providerId: "test",
					providerAccountRef: "account",
					productId: "widget",
				},
			],
		}),
		composite: {
			proofRef: "host",
			environmentDigest: `sha256:${"b".repeat(64)}`,
			sourceRequirements: source ? [requirement] : [],
			verifyEnvironment: callback,
			verifyPlan: callback,
		},
		financial: {
			assess: (plan: FinancialPlan) => ({ plan }),
			admit: async (requestId) => ({
				requestId,
				targetId: "t",
				status: "admitted",
				code: "",
				message: "",
				budget: { evaluation: "allowed", reservation: "held" },
				reservation: { reservationId: `iac:${requestId}` },
				requestDigest: `sha256:${"b".repeat(64)}`,
				inventoryHash: `sha256:${"c".repeat(64)}`,
				modelHash: `sha256:${"d".repeat(64)}`,
				quoteHash: `sha256:${"e".repeat(64)}`,
			}),
			revalidate: () => {
				armed = true;
				return true;
			},
			uncertain: (id) => {
				uncertain.push(id);
			},
		},
	});
	return {
		provider,
		uncertain,
		observed: () => ({ mutations, providerStarted, callbacksAfterFinalScan }),
	};
}

it("rejects a native plan changed while the final state scan awaits", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-plan-race-"));
	const oldHome = process.env.ALCHEMY_HOME;
	process.env.ALCHEMY_HOME = join(directory, "home");
	try {
		const f = fixture(directory, "change");
		await f.provider.preview(program);
		await expect(
			f.provider.applyWithAdmission(program, "request"),
		).rejects.toMatchObject({
			code: "PLAN_CHANGED_AFTER_ADMISSION",
			executionOutcome: "not-started",
			requiresReconciliation: true,
			reservationId: "iac:request",
		});
		expect(f.uncertain).toEqual(["iac:request"]);
		expect(f.observed()).toEqual({
			mutations: 1,
			providerStarted: false,
			callbacksAfterFinalScan: 0,
		});
	} finally {
		if (oldHome === undefined) delete process.env.ALCHEMY_HOME;
		else process.env.ALCHEMY_HOME = oldHome;
		rmSync(directory, { recursive: true, force: true });
	}
});

it("retains the hold and reports not-started if the final plan cannot be inspected", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-plan-race-"));
	const oldHome = process.env.ALCHEMY_HOME;
	process.env.ALCHEMY_HOME = join(directory, "home");
	try {
		const f = fixture(directory, "uninspectable");
		await f.provider.preview(program);
		await expect(
			f.provider.applyWithAdmission(program, "request"),
		).rejects.toMatchObject({
			code: "PLAN_UNINSPECTABLE_AFTER_ADMISSION",
			executionOutcome: "not-started",
			requiresReconciliation: true,
			reservationId: "iac:request",
		});
		expect(f.uncertain).toEqual(["iac:request"]);
		expect(f.observed()).toEqual({
			mutations: 1,
			providerStarted: false,
			callbacksAfterFinalScan: 0,
		});
	} finally {
		if (oldHome === undefined) delete process.env.ALCHEMY_HOME;
		else process.env.ALCHEMY_HOME = oldHome;
		rmSync(directory, { recursive: true, force: true });
	}
});

it("runs no host authorization callbacks between the final scan and provider start", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-plan-race-"));
	const oldHome = process.env.ALCHEMY_HOME;
	process.env.ALCHEMY_HOME = join(directory, "home");
	try {
		const f = fixture(directory, false, true);
		await f.provider.preview(program);
		await f.provider.applyWithAdmission(program, "request");
		expect(f.observed()).toEqual({
			mutations: 1,
			providerStarted: true,
			callbacksAfterFinalScan: 0,
		});
	} finally {
		if (oldHome === undefined) delete process.env.ALCHEMY_HOME;
		else process.env.ALCHEMY_HOME = oldHome;
		rmSync(directory, { recursive: true, force: true });
	}
});
