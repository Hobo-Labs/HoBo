import type { FanoutGroup, FanoutPlan } from "./policy.js";

export type SlotState =
	| "pending"
	| "in-flight"
	| "succeeded"
	| "failed"
	| "deferred";

export type SlotView = Readonly<{ campId: string; state: SlotState }>;

export type Schedule = Readonly<{
	candidates: readonly string[];
	free: number;
	groupIndex: number;
	complete: boolean;
	atGroupBoundary: boolean;
	mandatoryFailed: boolean;
	mandatoryGate: boolean;
}>;

function count(
	slots: ReadonlyMap<string, SlotView>,
	campIds: readonly string[],
	state: SlotState,
): number {
	let n = 0;
	for (const campId of campIds) if (stateOf(slots, campId) === state) n += 1;
	return n;
}

function stateOf(
	slots: ReadonlyMap<string, SlotView>,
	campId: string,
): SlotState {
	return slots.get(campId)?.state ?? "pending";
}

function busy(
	slots: ReadonlyMap<string, SlotView>,
	group: FanoutGroup,
): boolean {
	return group.campIds.some((campId) => {
		const state = stateOf(slots, campId);
		return state === "pending" || state === "in-flight";
	});
}

export function failuresAgainstBudget(
	slots: ReadonlyMap<string, SlotView>,
	baseline: number,
): number {
	let failed = 0;
	for (const slot of slots.values()) if (slot.state === "failed") failed += 1;
	return Math.max(0, failed - baseline);
}

export function budgetExceeded(
	plan: FanoutPlan,
	slots: ReadonlyMap<string, SlotView>,
	baseline: number,
): boolean {
	return failuresAgainstBudget(slots, baseline) > plan.maxFailures;
}

export function schedule(
	plan: FanoutPlan,
	slots: ReadonlyMap<string, SlotView>,
	options: Readonly<{ halted: boolean; catchUp: boolean }>,
): Schedule {
	const all = plan.campIds;
	const inFlight = count(slots, all, "in-flight");
	const pending = count(slots, all, "pending");
	const free = Math.max(0, plan.maxConcurrency - inFlight);
	const complete = pending === 0 && inFlight === 0;
	const mandatory = plan.groups.filter((group) => group.mandatory);
	const mandatoryCamps = mandatory.flatMap((group) => group.campIds);
	const mandatoryFailed = count(slots, mandatoryCamps, "failed") > 0;
	const mandatoryGate =
		count(slots, mandatoryCamps, "succeeded") < mandatoryCamps.length;
	const scope = mandatoryGate ? mandatory : plan.groups;
	const activeIndex = scope.findIndex((group) => busy(slots, group));
	const activeGroup = activeIndex < 0 ? undefined : scope[activeIndex];
	const groupIndex = activeGroup
		? plan.groups.indexOf(activeGroup)
		: Math.max(0, plan.groups.length - 1);
	const base = {
		free,
		groupIndex,
		complete,
		atGroupBoundary: inFlight === 0,
		mandatoryFailed,
		mandatoryGate,
	};
	if (options.halted || free === 0 || mandatoryFailed)
		return { ...base, candidates: [] };

	if (options.catchUp) {
		return {
			...base,
			candidates: (mandatoryGate ? mandatoryCamps : all).filter(
				(campId) => stateOf(slots, campId) === "deferred",
			),
		};
	}

	let window: readonly FanoutGroup[];
	if (plan.strategy === "PROGRESSIVE_PER_GROUP") {
		window = activeIndex < 0 ? scope : scope.slice(0, activeIndex + 1);
	} else {
		window = scope;
	}
	const windowCamps = window.flatMap((group) => group.campIds);
	const pendingCamps =
		plan.strategy === "PROGRESSIVE_PER_GROUP"
			? (activeGroup?.campIds ?? []).filter(
					(campId) => stateOf(slots, campId) === "pending",
				)
			: windowCamps.filter((campId) => stateOf(slots, campId) === "pending");
	const deferredCamps = windowCamps.filter(
		(campId) => stateOf(slots, campId) === "deferred",
	);
	return { ...base, candidates: [...pendingCamps, ...deferredCamps] };
}
