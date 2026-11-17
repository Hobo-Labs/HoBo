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
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "hobo-alchemy-composite-"));
	dirs.push(dir);
	process.env.ALCHEMY_HOME = join(dir, "auth");
	let plans = 0;
	let ran = 0;
	let applied = 0;
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
						expect(news.artifact).toBe("HELLO");
						return { id: "widget" };
					}),
				delete: () => Effect.void,
			}),
			state: inMemoryState(),
		},
		Effect.gen(function* () {
			const artifact = yield* Build("build", { name: "hello" });
			const upper = Output.map(artifact.name, (name) => name.toUpperCase());
			yield* Widget("widget", { artifact: upper });
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
			}),
			uncertain: (id) => {
				uncertain.push(id);
			},
		},
		composite: {
			proofRef: "host:attestation-1",
			environmentDigest: `sha256:${"e".repeat(64)}`,
			verifyEnvironment: ({ phase }) => {
				observed.push(`environment:${phase}`);
				return options.denyEnvironment !== true;
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
		program: {
			programId: "p",
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

	it("does not run the action twice after a completed execution", async () => {
		const f = fixture();
		await f.provider.preview(f.program);
		await f.provider.applyWithAdmission(f.program, "attempt");
		await expect(
			f.provider.applyWithAdmission(f.program, "other-attempt"),
		).rejects.toMatchObject({
			code: "EXECUTION_ALREADY_CLAIMED",
			requiresReconciliation: true,
		});
		expect(f.ran()).toBe(1);
		expect(f.applied()).toBe(1);
	});
});
