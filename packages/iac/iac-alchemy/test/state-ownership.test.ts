import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inMemoryState, Resource, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AlchemyStateOwnershipCheck,
	alchemyTarget,
	captureAlchemyProgram,
	createAlchemyIacProvider,
} from "../src/index.js";
import { routeFixture, testOperation } from "./route-fixture.js";

type Widget = Resource<"Spec.Widget", { value: string }, { id: string }>;
const Widget = Resource<Widget>("Spec.Widget");
const dirs: string[] = [];
const previousAlchemyHome = process.env.ALCHEMY_HOME;
const program = {
	programId: "deployment:app",
	deploymentId: "deployment",
	resourceId: "app",
	provider: "sandbox",
	driver: "external",
	action: "apply" as const,
	stackName: "tenant/deployment/app",
	operationGeneration: "generation-1",
};

afterEach(() => {
	if (previousAlchemyHome === undefined) delete process.env.ALCHEMY_HOME;
	else process.env.ALCHEMY_HOME = previousAlchemyHome;
	for (const directory of dirs.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function fixture(
	options: {
		stackName?: string;
		tenantId?: string;
		ownershipEpoch?: string;
		missingOwnership?: boolean;
		mutateDuringOwnership?: boolean;
		mutateAfterPlan?: boolean;
		verify?: (input: AlchemyStateOwnershipCheck) => boolean | Promise<boolean>;
		onAdmission?: () => void;
		onApply?: () => void;
	} = {},
) {
	const directory = mkdtempSync(join(tmpdir(), "hobo-state-owner-"));
	dirs.push(directory);
	process.env.ALCHEMY_HOME = join(directory, "auth");
	let planned = 0;
	let applied = 0;
	let current: Widget | undefined;
	let planVerifications = 0;
	const uncertain: string[] = [];
	const stackName = options.stackName ?? "Physical-App";
	const stack = Stack(
		stackName,
		{
			providers: Provider.succeed(Widget, {
				reconcile: () =>
					Effect.sync(() => {
						applied++;
						options.onApply?.();
						return { id: "ok" };
					}),
				delete: () => Effect.void,
			}),
			state: inMemoryState(),
		},
		Effect.gen(function* () {
			planned++;
			current = yield* Widget("widget", { value: "approved" });
			return {};
		}),
	);
	const seen: AlchemyStateOwnershipCheck[] = [];
	const provider = createAlchemyIacProvider({
		stack,
		runtimeLayer: Alchemist.layer(),
		runtimeDirectory: join(directory, "runtime"),
		// SAFETY: this branch deliberately exercises a malformed JavaScript caller.
		stateOwnership: options.missingOwnership
			? (undefined as never)
			: {
					backendRef: "host:state-1",
					ownershipEpoch: options.ownershipEpoch ?? "epoch-1",
					verify: (input) => {
						seen.push(input);
						if (input.phase === "plan") planVerifications++;
						if (
							input.phase === "plan" &&
							options.mutateAfterPlan &&
							planVerifications === 2 &&
							current !== undefined
						)
							Object.assign(current.Props, {
								value: "tampered after inspection",
							});
						if (
							input.phase === "apply" &&
							options.mutateDuringOwnership &&
							current !== undefined
						)
							Object.assign(current.Props, { value: "tampered" });
						return options.verify?.(input) ?? true;
					},
				},
		composite: {
			proofRef: "host:fixture",
			environmentDigest: `sha256:${"e".repeat(64)}`,
			sourceRequirements: [],
			verifyEnvironment: () => true,
			verifyPlan: ({ effects, sourceClaims }) =>
				effects.length === 0 && sourceClaims.length === 0,
		},
		route: routeFixture().port,
		resolveRoute: ({ requestId }) => ({
			requestId: requestId ?? "attempt",
			operation: testOperation,
		}),
		target: alchemyTarget({
			targetId: "target",
			tenantId: options.tenantId ?? "tenant",
			stackName,
			stage: "Test",
			programResourceId: "app",
			sourceDigest: `sha256:${"a".repeat(64)}`,
			inventoryEvidenceRef: "inventory:1",
			resources: [
				{
					resourceId: "widget",
					resourceType: "Spec.Widget",
					providerId: "sandbox",
					providerAccountRef: "account",
					productId: "widget",
				},
			],
		}),
		financial: {
			assess: (plan) => ({ plan }),
			admit: async (requestId) => {
				options.onAdmission?.();
				return {
					requestId,
					targetId: "target",
					status: "admitted",
					code: "",
					message: "",
					budget: { evaluation: "allowed", reservation: "held" },
					reservation: { reservationId: `iac:${requestId}` },
					requestDigest: `sha256:${"b".repeat(64)}`,
					inventoryHash: `sha256:${"c".repeat(64)}`,
					modelHash: `sha256:${"d".repeat(64)}`,
					quoteHash: `sha256:${"e".repeat(64)}`,
				};
			},
			revalidate: () => true,
			uncertain: (id) => {
				uncertain.push(id);
			},
		},
	});
	return {
		provider,
		seen,
		uncertain,
		planned: () => planned,
		applied: () => applied,
	};
}

describe("host-authenticated Alchemy state ownership", () => {
	it("requires an independently supplied ownership verifier", () => {
		expect(() => fixture({ missingOwnership: true })).toThrow(
			"STATE_SCOPE_UNVERIFIED",
		);
	});

	it("rejects unsafe physical state names before running the stack", () => {
		expect(() => fixture({ stackName: "../escape" })).toThrow(
			"STATE_IDENTITY_INVALID",
		);
	});

	it("fails closed before planning when the ownership verifier is unavailable", async () => {
		const f = fixture({
			verify: () => {
				throw new Error("unavailable");
			},
		});
		await expect(f.provider.preview(program)).rejects.toMatchObject({
			code: "STATE_SCOPE_UNVERIFIED",
		});
		expect(f.planned()).toBe(0);
	});

	it("does not return an assessment if ownership is revoked during planning", async () => {
		let verifications = 0;
		const f = fixture({ verify: () => ++verifications === 1 });
		await expect(f.provider.assessPricing(program)).rejects.toMatchObject({
			code: "STATE_SCOPE_UNVERIFIED",
		});
		expect(f.planned()).toBe(1);
		expect(f.applied()).toBe(0);
	});

	it("rejects a plan changed by the post-inspection ownership verifier", async () => {
		const f = fixture({ mutateAfterPlan: true });
		await expect(f.provider.assessPricing(program)).rejects.toMatchObject({
			code: "PLAN_CHANGED",
		});
		expect(f.applied()).toBe(0);
	});

	it("binds an opaque logical HoBo stack to the safe physical scope", async () => {
		const f = fixture();
		await expect(f.provider.preview(program)).resolves.toMatchObject({
			changes: 1,
		});
		expect(f.seen[0]).toMatchObject({
			phase: "plan",
			operationGeneration: "generation-1",
			tenantId: "tenant",
			targetId: "target",
			sourceDigest: `sha256:${"a".repeat(64)}`,
			resources: [
				{
					resourceId: "widget",
					resourceType: "Spec.Widget",
					providerId: "sandbox",
					providerAccountRef: "account",
					productId: "widget",
				},
			],
			program: {
				programId: "deployment:app",
				deploymentId: "deployment",
				resourceId: "app",
				logicalStackName: "tenant/deployment/app",
			},
			state: {
				backendRef: "host:state-1",
				ownershipEpoch: "epoch-1",
				stackName: "Physical-App",
				stage: "Test",
				scopeKey: "physical-app/test",
			},
		});
		expect(Object.isFrozen(f.seen[0]?.program)).toBe(true);
		expect(Object.isFrozen(f.seen[0]?.state)).toBe(true);
	});

	it("binds exact logical identity and ownership epoch into the financial plan", async () => {
		const first = fixture();
		const next = fixture({ ownershipEpoch: "epoch-2" });
		const a = await first.provider.assessPricing(program);
		const b = await first.provider.assessPricing({
			...program,
			stackName: "tenant/deployment/APP",
		});
		const c = await next.provider.assessPricing(program);
		expect(a.plan.planDigest).not.toBe(b.plan.planDigest);
		expect(a.plan.planDigest).not.toBe(c.plan.planDigest);
		await expect(
			first.provider.applyWithAdmission(
				{ ...program, stackName: "other-logical" },
				"attempt",
			),
		).rejects.toMatchObject({ code: "PREVIEW_REQUIRED" });
		expect(first.applied()).toBe(0);
	});

	it("requires host authorization of the exact desired resource declaration", async () => {
		const resource = {
			name: "app",
			port: "compute",
			provider: "sandbox",
			deps: [],
			region: "east",
		};
		const requested = { ...program, resource };
		const expected = captureAlchemyProgram(requested).declarationDigest;
		const f = fixture({
			verify: ({ program: logical }) =>
				logical.declarationPresence === "present" &&
				logical.declarationDigest === expected &&
				JSON.stringify(logical.resource) === JSON.stringify(resource),
		});
		const first = await f.provider.assessPricing(requested);
		expect(first.plan.planDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
		await expect(
			f.provider.preview({
				...requested,
				resource: { ...resource, region: "west" },
			}),
		).rejects.toMatchObject({ code: "STATE_SCOPE_UNVERIFIED" });
		expect(f.planned()).toBe(1);
	});

	it("allows an independently approved declaration update for the same durable owner", async () => {
		const resource = {
			name: "app",
			port: "compute",
			provider: "sandbox",
			deps: [],
			region: "east",
		};
		const first = { ...program, resource };
		const next = {
			...program,
			operationGeneration: "generation-2",
			resource: { ...resource, region: "west" },
		};
		const approved = new Set([
			`generation-1:${captureAlchemyProgram(first).declarationDigest}`,
		]);
		let owner: string | undefined;
		const f = fixture({
			verify: ({ tenantId, program: logical, operationGeneration, state }) => {
				const identity = JSON.stringify({
					tenantId,
					programId: logical.programId,
					deploymentId: logical.deploymentId,
					resourceId: logical.resourceId,
					logicalStackName: logical.logicalStackName,
					backendRef: state.backendRef,
					scopeKey: state.scopeKey,
					epoch: state.ownershipEpoch,
				});
				if (owner !== undefined && owner !== identity) return false;
				if (
					!approved.has(`${operationGeneration}:${logical.declarationDigest}`)
				)
					return false;
				owner = identity;
				return true;
			},
		});
		const before = await f.provider.assessPricing(first);
		await expect(f.provider.assessPricing(next)).rejects.toMatchObject({
			code: "STATE_SCOPE_UNVERIFIED",
		});
		expect(f.planned()).toBe(1);
		approved.add(
			`generation-2:${captureAlchemyProgram(next).declarationDigest}`,
		);
		const after = await f.provider.assessPricing(next);
		expect(before.plan.planDigest).not.toBe(after.plan.planDigest);
		expect(f.planned()).toBe(2);
	});

	it("binds different desired declarations into distinct financial plans", async () => {
		const f = fixture();
		const resource = {
			name: "app",
			port: "compute",
			provider: "sandbox",
			deps: [],
			region: "east",
		};
		const first = await f.provider.assessPricing({ ...program, resource });
		const second = await f.provider.assessPricing({
			...program,
			resource: { ...resource, region: "west" },
		});
		expect(first.plan.planDigest).not.toBe(second.plan.planDigest);
	});

	it("binds the operation generation, including its absence, into financial plans", async () => {
		const f = fixture();
		const first = await f.provider.assessPricing(program);
		const next = { ...program, operationGeneration: "generation-2" };
		await expect(
			f.provider.applyWithAdmission(next, "next"),
		).rejects.toMatchObject({ code: "PREVIEW_REQUIRED" });
		const second = await f.provider.assessPricing(next);
		const { operationGeneration, ...withoutGeneration } = program;
		expect(operationGeneration).toBe("generation-1");
		const ungenerated = await f.provider.assessPricing(withoutGeneration);
		expect(first.plan.planDigest).not.toBe(second.plan.planDigest);
		expect(first.plan.planDigest).not.toBe(ungenerated.plan.planDigest);
		expect(second.plan.planDigest).not.toBe(ungenerated.plan.planDigest);
		expect(f.applied()).toBe(0);
	});

	it("keeps a caller's changing declaration outside the verified snapshot", async () => {
		const resource = {
			name: "app",
			port: "compute",
			provider: "sandbox",
			deps: [],
			region: "east",
		};
		const expected = captureAlchemyProgram({
			...program,
			resource,
		}).declarationDigest;
		const f = fixture({
			verify: async ({ program: logical }) => {
				resource.region = "west";
				return (
					logical.declarationDigest === expected &&
					JSON.stringify(logical.resource) ===
						JSON.stringify({ ...resource, region: "east" })
				);
			},
		});
		await expect(
			f.provider.assessPricing({ ...program, resource }),
		).resolves.toMatchObject({ diff: { changes: 1 } });
		expect(resource.region).toBe("west");
	});

	it("bounds opaque logical identities independently of physical state segments", async () => {
		const f = fixture();
		const maximum = {
			...program,
			programId: "p".repeat(401),
			stackName: "s".repeat(602),
		};
		await expect(f.provider.preview(maximum)).resolves.toMatchObject({
			changes: 1,
		});
		await expect(
			f.provider.preview({ ...maximum, stackName: "s".repeat(603) }),
		).rejects.toMatchObject({ code: "PROGRAM_INVALID" });
		await expect(
			f.provider.preview({ ...maximum, programId: "p".repeat(402) }),
		).rejects.toMatchObject({ code: "PROGRAM_INVALID" });
	});

	it.each([
		"tenant",
		"deployment",
		"resource",
		"logical-stack",
	] as const)("refuses a spoofed %s before running the stack", async (spoof) => {
		const f = fixture({
			tenantId: spoof === "tenant" ? "foreign" : "tenant",
			verify: ({ tenantId, program: logical }) =>
				tenantId === "tenant" &&
				logical.deploymentId === "deployment" &&
				logical.resourceId === "app" &&
				logical.logicalStackName === "tenant/deployment/app",
		});
		const candidate = {
			...program,
			...(spoof === "deployment" ? { deploymentId: "other" } : undefined),
			...(spoof === "resource" ? { resourceId: "other" } : undefined),
			...(spoof === "logical-stack"
				? { stackName: "tenant/other/app" }
				: undefined),
		};
		await expect(f.provider.preview(candidate)).rejects.toThrow();
		expect(f.planned()).toBe(0);
	});

	it("refuses case-folded physical aliases and unverified migration", async () => {
		const owners = new Map<string, string>();
		const verify = ({
			tenantId,
			program: logical,
			state,
		}: AlchemyStateOwnershipCheck) => {
			const owner = JSON.stringify({
				tenantId,
				logical,
				epoch: state.ownershipEpoch,
			});
			const existing = owners.get(state.scopeKey);
			if (existing === undefined) {
				if (state.scopeKey !== "physical-app/test") return false;
				owners.set(state.scopeKey, owner);
				return true;
			}
			return existing === owner;
		};
		const first = fixture({ verify });
		await first.provider.preview(program);
		const alias = fixture({
			stackName: "physical-app",
			tenantId: "other",
			verify,
		});
		await expect(alias.provider.preview(program)).rejects.toMatchObject({
			code: "STATE_SCOPE_UNVERIFIED",
		});
		const renamedLogical = fixture({ stackName: "physical-app", verify });
		await expect(
			renamedLogical.provider.preview({
				...program,
				stackName: "tenant/deployment/other",
			}),
		).rejects.toMatchObject({ code: "STATE_SCOPE_UNVERIFIED" });
		const migrated = fixture({ stackName: "new-physical", verify });
		await expect(migrated.provider.preview(program)).rejects.toMatchObject({
			code: "STATE_SCOPE_UNVERIFIED",
		});
		expect(alias.planned()).toBe(0);
		expect(renamedLogical.planned()).toBe(0);
		expect(migrated.planned()).toBe(0);
	});

	it("retains the hold when ownership is revoked after admission", async () => {
		let valid = true;
		const f = fixture({
			verify: () => valid,
			onAdmission: () => {
				valid = false;
			},
		});
		await f.provider.preview(program);
		await expect(
			f.provider.applyWithAdmission(program, "attempt"),
		).rejects.toMatchObject({
			code: "STATE_SCOPE_UNVERIFIED",
			requiresReconciliation: true,
			executionOutcome: "not-started",
		});
		expect(f.applied()).toBe(0);
		expect(f.uncertain).toContain("iac:attempt");
	});

	it("rechecks the plan after the asynchronous ownership callback", async () => {
		const f = fixture({ mutateDuringOwnership: true });
		await f.provider.preview(program);
		await expect(
			f.provider.applyWithAdmission(program, "attempt"),
		).rejects.toMatchObject({
			code: "PLAN_CHANGED_AFTER_ADMISSION",
			requiresReconciliation: true,
			executionOutcome: "not-started",
		});
		expect(f.applied()).toBe(0);
		expect(f.uncertain).toContain("iac:attempt");
	});

	it("does not admit an operation when ownership is revoked after preview", async () => {
		let valid = true;
		let admissions = 0;
		const f = fixture({
			verify: () => valid,
			onAdmission: () => {
				admissions++;
			},
		});
		await f.provider.preview(program);
		valid = false;
		await expect(
			f.provider.applyWithAdmission(program, "attempt"),
		).rejects.toMatchObject({
			code: "STATE_SCOPE_UNVERIFIED",
			executionOutcome: "not-started",
			requiresReconciliation: false,
		});
		expect(admissions).toBe(0);
		expect(f.applied()).toBe(0);
	});

	it("retains the hold when ownership is revoked during provider execution", async () => {
		let valid = true;
		const f = fixture({
			verify: () => valid,
			onApply: () => {
				valid = false;
			},
		});
		await f.provider.preview(program);
		await expect(
			f.provider.applyWithAdmission(program, "attempt"),
		).rejects.toMatchObject({
			code: "STATE_SCOPE_UNCERTAIN",
			requiresReconciliation: true,
			executionOutcome: "completed",
		});
		expect(f.applied()).toBe(1);
		expect(f.uncertain).toContain("iac:attempt");
	});
});
