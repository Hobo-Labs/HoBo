import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inMemoryState, Resource, Stack } from "alchemy";
import { Action } from "alchemy/Action";
import * as Alchemist from "alchemy/Alchemist";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";
import { alchemyTarget, createAlchemyIacProvider } from "../src/index.js";
import { registerAlchemySource } from "../src/source-fence.js";
import {
	routeFixture,
	testOperation,
	testStateOwnership,
} from "./route-fixture.js";

type Widget = Resource<"Spec.Widget", { artifact: string }, { id: string }>;
const Widget = Resource<Widget>("Spec.Widget");
const dirs: string[] = [];
const priorHome = process.env.ALCHEMY_HOME;

afterEach(() => {
	if (priorHome === undefined) delete process.env.ALCHEMY_HOME;
	else process.env.ALCHEMY_HOME = priorHome;
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function fixture(
	options: {
		denyAtPlan?: number;
		denyEnvironment?: boolean;
		includeActionScope?: boolean;
		sourceRevokesAtApply?: boolean;
		guardRevokesAtApply?: boolean;
		sourceRevokesDuringDrift?: boolean;
		guardRevokesDuringDrift?: boolean;
		guardThrowsDuringDrift?: boolean;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "hobo-alchemy-composite-"));
	dirs.push(dir);
	process.env.ALCHEMY_HOME = join(dir, "auth");
	let plans = 0;
	let ran = 0;
	let applied = 0;
	let sourceAllowed = true;
	let guardAllowed = true;
	let guardUnavailable = false;
	let refreshing = false;
	let refreshEnvironmentChecks = 0;
	let driftReads = 0;
	const sourceRequirement = {
		resourceId: "widget",
		resourceType: "Spec.Widget",
		bindleName: "app",
		applicationName: "widget",
		sourceKind: "test",
		sourcePath: "/source/widget",
	};
	const uncertain: string[] = [];
	const observed: string[] = [];
	const Build = Action("Spec.Build", (input: { name: string }) =>
		Effect.sync(() => {
			ran++;
			return { name: input.name };
		}),
	);
	const stack = Stack(
		"App",
		{
			providers: Provider.succeed(Widget, {
				reconcile: ({ news }) =>
					Effect.sync(() => {
						applied++;
						if (options.sourceRevokesAtApply) sourceAllowed = false;
						if (options.guardRevokesAtApply) guardAllowed = false;
						expect(news.artifact).toBe("HELLO");
						return { id: "widget" };
					}),
				delete: () => Effect.void,
				read: () =>
					Effect.sync(() => {
						if (refreshing && refreshEnvironmentChecks >= 2) {
							driftReads++;
							if (options.sourceRevokesDuringDrift) sourceAllowed = false;
							if (options.guardRevokesDuringDrift) guardAllowed = false;
							if (options.guardThrowsDuringDrift) guardUnavailable = true;
						}
						return { id: "widget" };
					}),
			}),
			state: inMemoryState(),
		},
		Effect.gen(function* () {
			const artifact = yield* Build("build", { name: "hello" });
			const upper = Output.map(artifact.name, (name) => name.toUpperCase());
			const widget = yield* Widget("widget", { artifact: upper });
			if (options.sourceRevokesAtApply || options.sourceRevokesDuringDrift)
				registerAlchemySource(widget, {
					claim: {
						...sourceRequirement,
						sourceDigest: `sha256:${"a".repeat(64)}`,
						environmentDigest: `sha256:${"e".repeat(64)}`,
						proofRef: "host:attestation-1",
					},
					verify: () => sourceAllowed,
				});
			return { output: "ok" };
		}),
	);
	const scopes = [
		{
			resourceId: "widget",
			resourceType: "Spec.Widget",
			providerId: "test",
			providerAccountRef: "account",
			productId: "widget",
		},
	];
	if (options.includeActionScope !== false)
		scopes.push({
			resourceId: "build",
			resourceType: "alchemy:action:Spec.Build",
			providerId: "sandbox",
			providerAccountRef: "build-account",
			productId: "build",
		});
	const provider = createAlchemyIacProvider({
		stack,
		stateOwnership: testStateOwnership,
		route: routeFixture().port,
		resolveRoute: ({ requestId }) => ({
			requestId: requestId ?? "logical-attempt",
			operation: testOperation,
		}),
		runtimeLayer: Alchemist.layer(),
		runtimeDirectory: join(dir, "runtime"),
		target: alchemyTarget({
			targetId: "target",
			tenantId: "tenant",
			stackName: "App",
			stage: "test",
			programResourceId: "app",
			sourceDigest: `sha256:${"a".repeat(64)}`,
			inventoryEvidenceRef: "inventory:1",
			resources: scopes,
		}),
		financial: {
			assess: (plan) => ({ plan }),
			admit: async (id) => ({
				requestId: id,
				targetId: "target",
				status: "admitted",
				code: "",
				message: "",
				budget: { evaluation: "allowed", reservation: "held" },
				reservation: { reservationId: `iac:${id}` },
				requestDigest: `sha256:${"b".repeat(64)}`,
				inventoryHash: `sha256:${"c".repeat(64)}`,
				modelHash: `sha256:${"d".repeat(64)}`,
				quoteHash: `sha256:${"e".repeat(64)}`,
			}),
			revalidate: () => true,
			uncertain: (id) => {
				uncertain.push(id);
			},
		},
		composite: {
			proofRef: "host:attestation-1",
			environmentDigest: `sha256:${"e".repeat(64)}`,
			sourceRequirements:
				options.sourceRevokesAtApply || options.sourceRevokesDuringDrift
					? [sourceRequirement]
					: [],
			verifyEnvironment: ({ phase }) => {
				observed.push(`environment:${phase}`);
				if (refreshing) refreshEnvironmentChecks++;
				if (guardUnavailable) throw new Error("host verification unavailable");
				return options.denyEnvironment !== true && guardAllowed;
			},
			verifyPlan: ({ effects, scope, structuralDigest }) => {
				plans++;
				observed.push(`plan:${plans}`);
				expect(structuralDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
				expect(scope.map((row) => row.resourceId).sort()).toEqual([
					"build",
					"widget",
				]);
				expect(
					effects.some(
						(effect) =>
							effect.kind === "action" && effect.type === "Spec.Build",
					),
				).toBe(true);
				expect(effects.some((effect) => effect.kind === "expression")).toBe(
					true,
				);
				return plans !== options.denyAtPlan;
			},
		},
	});
	return {
		provider,
		uncertain,
		observed,
		ran: () => ran,
		applied: () => applied,
		beginRefresh: () => {
			refreshing = true;
			refreshEnvironmentChecks = 0;
		},
		driftReads: () => driftReads,
		program: {
			programId: "p",
			operationGeneration: "generation-1",
			deploymentId: "d",
			resourceId: "app",
			provider: "test",
			driver: "external",
			action: "apply" as const,
			stackName: "App",
		},
	};
}

describe("host-authorized Alchemy composite effects", () => {
	it.each([
		["source", { sourceRevokesDuringDrift: true }, "COMPOSITE_PLAN_UNVERIFIED"],
		[
			"environment",
			{ guardRevokesDuringDrift: true },
			"COMPOSITE_ENVIRONMENT_UNVERIFIED",
		],
		[
			"unavailable environment",
			{ guardThrowsDuringDrift: true },
			"COMPOSITE_ENVIRONMENT_UNVERIFIED",
		],
	] as const)("fails closed when %s verification changes during the drift scan", async (_kind, options, code) => {
		const f = fixture(options);
		await f.provider.assessPricing(f.program);
		await f.provider.applyWithAdmission(f.program, "attempt");
		f.beginRefresh();
		await expect(f.provider.refresh(f.program)).rejects.toMatchObject({ code });
		expect(f.driftReads()).toBeGreaterThan(0);
	});
	it("retains a completed-but-uncertain hold if a no-source host authorization is revoked during apply", async () => {
		const f = fixture({ guardRevokesAtApply: true });
		await f.provider.assessPricing(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "COMPOSITE_AUTHORIZATION_UNCERTAIN",
			requiresReconciliation: true,
			executionOutcome: "completed",
		});
		expect(f.applied()).toBe(1);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});
	it("retains an uncertain hold if the source fence is revoked during provider apply", async () => {
		const f = fixture({ sourceRevokesAtApply: true });
		await f.provider.assessPricing(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "SOURCE_FENCE_UNCERTAIN",
			requiresReconciliation: true,
			executionOutcome: "completed",
		});
		expect(f.applied()).toBe(1);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});
	it("plans and applies a real Action and mapped Output with complete financial scope", async () => {
		const f = fixture();
		const assessment = await f.provider.assessPricing(f.program);
		expect(
			assessment.plan.resources.map((row) => row.resourceId).sort(),
		).toEqual(["build", "widget"]);
		const result = await f.provider.applyWithAdmission(f.program, "attempt");
		expect(result.outputs).toEqual({ output: "ok" });
		expect(f.ran()).toBe(1);
		expect(f.applied()).toBe(1);
		expect(f.observed).toEqual([
			"environment:plan",
			"plan:1",
			"environment:plan",
			"plan:2",
			"environment:apply",
			"plan:3",
			"environment:apply",
			"plan:4",
		]);
	});

	it("rejects an action omitted from the financial scope", async () => {
		const f = fixture({ includeActionScope: false });
		await expect(f.provider.preview(f.program)).rejects.toMatchObject({
			code: "TARGET_INVENTORY_INCOMPLETE",
		});
		expect(f.ran()).toBe(0);
	});

	it("refuses planning when the host cannot verify the sandbox", async () => {
		const f = fixture({ denyEnvironment: true });
		await expect(f.provider.preview(f.program)).rejects.toMatchObject({
			code: "COMPOSITE_ENVIRONMENT_UNVERIFIED",
		});
		expect(f.ran()).toBe(0);
	});

	it("retains the reservation when host authorization expires before apply", async () => {
		const f = fixture({ denyAtPlan: 3 });
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "PLAN_UNINSPECTABLE_AFTER_ADMISSION",
			reservationId: "iac:attempt",
			requiresReconciliation: true,
		});
		expect(f.uncertain).toEqual(["iac:attempt"]);
		expect(f.ran()).toBe(0);
		expect(f.applied()).toBe(0);
	});

	it("requires a fresh preview after a completed execution", async () => {
		const f = fixture();
		await f.provider.preview(f.program);
		await f.provider.applyWithAdmission(f.program, "attempt");
		await expect(
			f.provider.applyWithAdmission(f.program, "other-attempt"),
		).rejects.toMatchObject({
			code: "PREVIEW_REQUIRED",
			requiresReconciliation: false,
		});
		expect(f.ran()).toBe(1);
		expect(f.applied()).toBe(1);
	});
});
