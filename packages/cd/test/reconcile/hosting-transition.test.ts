// Hosting-transition realizer (adapters/hosting-transition.ts): versions go
// through the hosting-transition coordinator; convergence only from SETTLED
// with the destination owning writes; restore/block are typed refusals.

import {
	HostingTransitionAction,
	HostingTransitionPhase,
	type HostingTransitionPlanInput,
	type HostingTransitionProvider,
	type HostingTransitionState,
	type SharedHostingBudgetAuthority,
} from "@hobo/cloud";
import {
	createEffectSpec,
	createResilienceProfile,
	pureEffects,
} from "@hobo/contracts";
import type { FenceToken } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { ReconcileStatus } from "../../src/_generated/cd_pb.js";
import {
	createHostingTransitionRealizer,
	type HostingCoordinator,
	transitionStatus,
} from "../../src/adapters/hosting-transition.js";
import type { RealizeInput } from "../../src/ports.js";
import {
	asCamp,
	asReconciler,
	createClock,
	createFakeStore,
	ctxAt,
	resolvedFor,
	setFor,
} from "./fakes.js";

const CAMP = asCamp("camp-web");

function state(
	fields: Partial<Record<string, unknown>>,
): HostingTransitionState {
	return {
		phase: HostingTransitionPhase.PROPOSED,
		version: 1,
		destinationOwnsWrites: false,
		restorationConfirmed: false,
		blockedReason: "",
		plan: { transitionId: "tr-1" },
		...fields,
	} as unknown as HostingTransitionState;
}

/** A scripted coordinator walking PROPOSED → … → SETTLED, one step per call. */
function scripted(script: readonly HostingTransitionState[]) {
	let index = 0;
	const calls: string[] = [];
	let fence: bigint | undefined;
	const coordinator: HostingCoordinator = {
		async propose() {
			calls.push("propose");
			return script[index] ?? state({});
		},
		async reserve() {
			calls.push("reserve");
			index = Math.min(index + 1, script.length - 1);
			return script[index] ?? state({});
		},
		async dispatch() {
			calls.push("dispatch");
			index = Math.min(index + 1, script.length - 1);
			return script[index] ?? state({});
		},
		async observe() {
			calls.push("observe");
			index = Math.min(index + 1, script.length - 1);
			return script[index] ?? state({});
		},
		async load() {
			calls.push("load");
			return index === 0 ? undefined : script[index];
		},
	};
	return {
		calls,
		fence: () => fence,
		factory: (options: { context: { fenceToken: bigint } }) => {
			fence = options.context.fenceToken;
			return coordinator;
		},
	};
}

const provider: HostingTransitionProvider = {
	contractId: "test-provider",
	executionGuarantee: "idempotent-operation",
	effects: createEffectSpec(pureEffects()),
	resilience: createResilienceProfile({}),
	async execute() {},
	async observe() {
		return {};
	},
};

const budget = {
	persistence: "memory",
} as unknown as SharedHostingBudgetAuthority;

function harness(
	planFor: (input: RealizeInput) => HostingTransitionPlanInput | undefined,
	coordinator?: ReturnType<typeof scripted>,
) {
	const clock = createClock();
	const store = createFakeStore(clock);
	const realizer = createHostingTransitionRealizer({
		store,
		budget,
		provider,
		tenant: "acme",
		now: clock.now,
		authorize: async () => ({ allowed: true }),
		planFor,
		...(coordinator ? { coordinator: coordinator.factory as never } : {}),
	});
	const resolved = resolvedFor(CAMP, [
		{ name: "web", port: "hosting", version: "2" },
	]);
	const input: RealizeInput = {
		campId: CAMP,
		desired: setFor(CAMP, resolved, 2),
		resolved,
		reconcilerId: asReconciler("r1"),
		fence: 7n as FenceToken,
		signal: new AbortController().signal,
	};
	return { realizer, input, ctx: ctxAt(clock) };
}

const PLAN = {
	transitionId: "tr-1",
	deploymentId: "web",
} as unknown as HostingTransitionPlanInput;

describe("createHostingTransitionRealizer", () => {
	it("drives propose → reserve → dispatch → observe and converges only from SETTLED with the destination owning writes", async () => {
		const script = scripted([
			state({ phase: HostingTransitionPhase.PROPOSED, version: 1 }),
			state({
				phase: HostingTransitionPhase.PREPARING,
				version: 2,
				operation: {
					action: HostingTransitionAction.PREPARE,
					mutationDispatched: false,
				},
			}),
			state({
				phase: HostingTransitionPhase.PREPARING,
				version: 3,
				operation: {
					action: HostingTransitionAction.PREPARE,
					mutationDispatched: true,
				},
			}),
			state({
				phase: HostingTransitionPhase.SETTLED,
				version: 4,
				destinationOwnsWrites: true,
			}),
		]);
		const h = harness(() => PLAN, script);
		const obs = await h.realizer.converge(h.input, h.ctx);
		expect(script.calls).toEqual(["propose", "reserve", "dispatch", "observe"]);
		expect(obs.status).toBe(ReconcileStatus.CONVERGED);
		expect(obs.setId).toBe(h.input.desired.setId);
		expect(obs.resources[0]?.kind).toBe("hosting-transition");
		// The reconciler's lease fence is the coordinator's writer fence (I4).
		expect(script.fence()).toBe(7n);
	});

	it("stops without progress and reports converging: advancement needs independent observation (I5)", async () => {
		const waiting = state({
			phase: HostingTransitionPhase.VERIFYING,
			version: 5,
			operation: {
				action: HostingTransitionAction.VERIFY,
				mutationDispatched: false,
			},
		});
		const script = scripted([waiting, waiting]);
		const h = harness(() => PLAN, script);
		const obs = await h.realizer.converge(h.input, h.ctx);
		expect(obs.status).toBe(ReconcileStatus.CONVERGING);
		expect(script.calls).toEqual(["propose", "observe"]);
	});

	it("a restored or blocked transition is a blocked observation with the coordinator's reason", () => {
		const restored = transitionStatus(
			state({
				phase: HostingTransitionPhase.RESTORED,
				blockedReason: "verification failed",
			}),
		);
		expect(restored.status).toBe(ReconcileStatus.BLOCKED);
		expect(restored.reasons[0]?.message).toBe("verification failed");
		const settledBack = transitionStatus(
			state({
				phase: HostingTransitionPhase.SETTLED,
				restorationConfirmed: true,
			}),
		);
		expect(settledBack.status).toBe(ReconcileStatus.BLOCKED);
	});

	it("a Set with no version change converges without touching the coordinator", async () => {
		const script = scripted([state({})]);
		const h = harness(() => undefined, script);
		const obs = await h.realizer.converge(h.input, h.ctx);
		expect(obs.status).toBe(ReconcileStatus.CONVERGED);
		expect(script.calls).toEqual([]);
	});

	it("the real coordinator refuses a non-durable budget authority and the pass blocks with that reason", async () => {
		const h = harness(() => PLAN);
		const obs = await h.realizer.converge(h.input, h.ctx);
		expect(obs.status).toBe(ReconcileStatus.BLOCKED);
		expect(obs.reasons[0]?.code).toBe("realize-failed");
		expect(obs.reasons[0]?.message).toMatch(
			/durable shared financial authority/u,
		);
	});
});
