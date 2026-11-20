import { createSecretKey } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Resource, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import { localState } from "alchemy/State";
import { reviveState } from "alchemy/State/StateEncoding";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { expect, it } from "vitest";
import {
	alchemyTarget,
	createAlchemyIacProvider,
	hashAlchemyPriorState,
} from "../src/index.js";
import { registerAlchemySource } from "../src/source-fence.js";
import {
	routeFixture,
	testOperation,
	testStateOwnership,
} from "./route-fixture.js";

type Widget = Resource<
	"Spec.Widget",
	{ token: Redacted.Redacted<string> },
	{ id: string }
>;
const Widget = Resource<Widget>("Spec.Widget");
const key = () => ({
	key: createSecretKey(Buffer.alloc(32, 23)),
	epoch: "stable-key-1",
	proofRef: "host:key-proof",
	verify: () => true,
});
const scope = {
	tenantId: "tenant",
	targetId: "target",
	stackName: "App",
	stage: "test",
};
const program = {
	programId: "p",
	deploymentId: "d",
	resourceId: "app",
	provider: "test",
	driver: "external",
	action: "apply" as const,
	stackName: "App",
	operationGeneration: "apply-1",
};

it("pins actual decoded Alchemy state through labeled create, reload, update and delete", async () => {
	const dir = mkdtempSync(join(tmpdir(), "hobo-alchemy-secret-"));
	const oldHome = process.env.ALCHEMY_HOME;
	process.env.ALCHEMY_HOME = join(dir, "auth");
	let updates = 0;
	let deletions = 0;
	const observations: string[] = [];
	const sourceRequirement = {
		resourceId: "widget",
		resourceType: "Spec.Widget",
		bindleName: "app",
		applicationName: "widget",
		sourceKind: "test",
		sourcePath: "/source/widget",
	};
	const prior = () => ({
		scope,
		fingerprint: key(),
		resourceId: "widget",
		resourceType: "Spec.Widget",
	});
	const makeProvider = (
		token: string,
		revokeKeyAtAdmission = false,
		revokeKeyAtProvider = false,
		failPlanning = false,
	) => {
		let keyAllowed = true;
		const stack = Stack(
			"App",
			{
				providers: Provider.succeed(Widget, {
					reconcile: () =>
						Effect.sync(() => {
							updates++;
							if (revokeKeyAtProvider) keyAllowed = false;
							return { id: "widget" };
						}),
					delete: () =>
						Effect.sync(() => {
							deletions++;
						}),
				}),
				state: localState(),
			},
			Effect.gen(function* () {
				if (failPlanning) return yield* Effect.die(new Error(token));
				const widget = yield* Widget("widget", {
					token: Redacted.make(token, { label: "diagnostic-only" }),
				});
				registerAlchemySource(widget, {
					claim: {
						...sourceRequirement,
						sourceDigest: `sha256:${"a".repeat(64)}`,
						environmentDigest: `sha256:${"b".repeat(64)}`,
						proofRef: "host",
					},
					verify: () => true,
				});
				return {};
			}),
		);
		return createAlchemyIacProvider({
			stack,
			stateOwnership: testStateOwnership,
			route: routeFixture().port,
			resolveRoute: ({ requestId }) => ({
				requestId: requestId ?? "logical",
				operation: testOperation,
			}),
			runtimeLayer: Alchemist.layer(),
			runtimeDirectory: dir,
			target: alchemyTarget({
				...scope,
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
			financial: {
				assess: (plan) => ({ plan }),
				admit: async (id) => {
					if (revokeKeyAtAdmission) keyAllowed = false;
					return {
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
					};
				},
				revalidate: () => true,
				uncertain: () => {},
			},
			composite: {
				proofRef: "host",
				environmentDigest: `sha256:${"b".repeat(64)}`,
				sourceRequirements: [sourceRequirement],
				secretFingerprint: { ...key(), verify: () => keyAllowed },
				verifyEnvironment: () => true,
				verifyPlan: ({ historicalResources }) => {
					for (const resource of historicalResources)
						observations.push(resource.priorStateDigest);
					return true;
				},
			},
		});
	};
	try {
		const first = makeProvider("secret-one");
		await first.preview(program);
		await first.applyWithAdmission(program, "first");
		expect(updates).toBe(1);
		const path = join(dir, "state", "App", "test", "widget.json");
		const persisted = readFileSync(path, "utf8");
		expect(persisted).toContain("secret-one");
		const state = JSON.parse(persisted, reviveState);
		expect(state.props.token.label).toBeUndefined();
		const expected = hashAlchemyPriorState(state, prior());
		const second = makeProvider("secret-two");
		await second.preview({ ...program, operationGeneration: "apply-2" });
		expect(observations).toContain(expected);
		await second.applyWithAdmission(
			{ ...program, operationGeneration: "apply-2" },
			"second",
		);
		expect(updates).toBe(2);
		const updated = readFileSync(path, "utf8");
		expect(updated).toContain("secret-two");
		const deletionState = JSON.parse(updated, reviveState);
		const deletionDigest = hashAlchemyPriorState(deletionState, prior());
		const third = makeProvider("secret-two");
		const destroy = {
			...program,
			action: "destroy" as const,
			operationGeneration: "destroy-1",
		};
		await third.preview(destroy);
		await third.destroyWithAdmission(destroy, "third");
		expect(observations).toContain(deletionDigest);
		expect(deletions).toBe(1);
		const revoked = makeProvider("secret-three", true);
		const revokedProgram = { ...program, operationGeneration: "apply-revoked" };
		await revoked.preview(revokedProgram);
		await expect(
			revoked.applyWithAdmission(revokedProgram, "revoked"),
		).rejects.toMatchObject({
			code: "PLAN_UNINSPECTABLE_AFTER_ADMISSION",
			requiresReconciliation: true,
		});
		expect(updates).toBe(2);
		const completed = makeProvider("secret-four", false, true);
		const completedProgram = {
			...program,
			operationGeneration: "apply-completed",
		};
		await completed.preview(completedProgram);
		await expect(
			completed.applyWithAdmission(completedProgram, "completed"),
		).rejects.toMatchObject({
			code: "SOURCE_FENCE_UNCERTAIN",
			requiresReconciliation: true,
			executionOutcome: "completed",
		});
		expect(updates).toBe(3);
		const failing = makeProvider("private-planning-error", false, false, true);
		try {
			await failing.preview({ ...program, operationGeneration: "failing" });
			throw new Error("planning unexpectedly passed");
		} catch (error) {
			expect(String(error)).not.toContain("private-planning-error");
		}
	} finally {
		if (oldHome === undefined) delete process.env.ALCHEMY_HOME;
		else process.env.ALCHEMY_HOME = oldHome;
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);
