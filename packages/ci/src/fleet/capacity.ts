/**
 * Live fleet capacity published for workflow routing before jobs queue.
 *
 * The route job on GitHub-hosted runners cannot read the box's memory directly.
 * The worker measures MemAvailable, subtracts reservations and a volatility
 * margin, and writes this snapshot to a repository variable.
 */

/** Repository variable workflows and `route-runner.mts` read. */
// public-contract: route job uses this for headroom-aware fleet admission.
export const FLEET_CAPACITY_VARIABLE = "HOBO_CI_FLEET_CAPACITY";

export type FleetLabelCapacity = Readonly<{
	/** Free slots this host believes it can launch right now. */
	freeSlots: number;
	/** MiB the class's representative job needs (container limit). */
	requiredMb: number;
	/** MiB reserved for the host (daemon, page cache, Docker). */
	reserveMb: number;
	/** Extra MiB margin for allocation volatility. */
	volatilityMb: number;
	/** OS-reported MemAvailable when sampled. */
	availableMb?: number;
	/** Whether a job of `requiredMb` can be admitted on this host now. */
	admit: boolean;
}>;

export type FleetCapacitySnapshot = Readonly<{
	atMs: number;
	hobo: FleetLabelCapacity;
	"hobo-trunk": FleetLabelCapacity;
}>;

type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

const tagOf = Object.prototype.toString;

function asObject(
	value: JsonValue | undefined,
): { readonly [key: string]: JsonValue } | undefined {
	// SAFETY: the tag check proves a plain object from JSON.parse.
	return tagOf.call(value) === "[object Object]"
		? (value as { readonly [key: string]: JsonValue })
		: undefined;
}

function asNumber(value: JsonValue | undefined): number | undefined {
	// SAFETY: the tag check proves a number primitive from JSON.parse.
	return tagOf.call(value) === "[object Number]"
		? (value as number)
		: undefined;
}

function asBoolean(value: JsonValue | undefined): boolean | undefined {
	// SAFETY: the tag check proves a boolean primitive from JSON.parse.
	return tagOf.call(value) === "[object Boolean]"
		? (value as boolean)
		: undefined;
}

function parseLabelCapacity(
	value: JsonValue | undefined,
): FleetLabelCapacity | undefined {
	const row = asObject(value);
	if (!row) return undefined;
	const freeSlots = asNumber(row.freeSlots);
	const requiredMb = asNumber(row.requiredMb);
	const reserveMb = asNumber(row.reserveMb);
	const volatilityMb = asNumber(row.volatilityMb);
	const admit = asBoolean(row.admit);
	if (
		freeSlots === undefined ||
		requiredMb === undefined ||
		reserveMb === undefined ||
		volatilityMb === undefined ||
		admit === undefined
	)
		return undefined;
	const availableMb = asNumber(row.availableMb);
	const base: FleetLabelCapacity = {
		freeSlots,
		requiredMb,
		reserveMb,
		volatilityMb,
		admit,
	};
	if (availableMb === undefined) return base;
	return { ...base, availableMb };
}

export function memoryAdmitHeadroom(
	availableMb: number | undefined,
	requiredMb: number,
	reserveMb: number,
	volatilityMb: number,
	committedMb = 0,
): boolean {
	if (availableMb === undefined) return true;
	const safeCommitted =
		Number.isFinite(committedMb) && committedMb > 0
			? Math.floor(committedMb)
			: 0;
	return availableMb - safeCommitted - requiredMb >= reserveMb + volatilityMb;
}

/** How many `requiredMb` jobs fit with one host reserve + volatility margin. */
export function memoryAdmitParallelCount(
	availableMb: number | undefined,
	requiredMb: number,
	reserveMb: number,
	volatilityMb: number,
	cap: number,
): number {
	if (!Number.isInteger(cap) || cap <= 0) return 0;
	if (availableMb === undefined) return cap;
	let count = 0;
	while (
		count < cap &&
		memoryAdmitHeadroom(
			availableMb,
			requiredMb,
			reserveMb,
			volatilityMb,
			count * requiredMb,
		)
	)
		count += 1;
	return count;
}

export function buildFleetCapacitySnapshot(input: {
	atMs: number;
	availableMb?: number;
	reserveMb: number;
	volatilityMb: number;
	freeSlotsHobo: number;
	freeSlotsTrunk: number;
	requiredMbHobo: number;
	requiredMbTrunk: number;
}): FleetCapacitySnapshot {
	const label = (freeSlots: number, requiredMb: number): FleetLabelCapacity => {
		const admit =
			freeSlots > 0 &&
			memoryAdmitHeadroom(
				input.availableMb,
				requiredMb,
				input.reserveMb,
				input.volatilityMb,
			);
		const capacity: FleetLabelCapacity = {
			freeSlots: Math.max(0, Math.floor(freeSlots)),
			requiredMb,
			reserveMb: input.reserveMb,
			volatilityMb: input.volatilityMb,
			admit,
		};
		if (input.availableMb === undefined) return capacity;
		return { ...capacity, availableMb: input.availableMb };
	};
	return {
		atMs: input.atMs,
		hobo: label(input.freeSlotsHobo, input.requiredMbHobo),
		"hobo-trunk": label(input.freeSlotsTrunk, input.requiredMbTrunk),
	};
}

export function fleetCapacityVariableValue(
	snapshot: FleetCapacitySnapshot,
): string {
	return JSON.stringify(snapshot);
}

export function parseFleetCapacityVariable(
	value: string | undefined,
): FleetCapacitySnapshot | undefined {
	if (!value?.trim()) return undefined;
	let parsed: JsonValue;
	try {
		// SAFETY: JSON.parse returns JsonValue-shaped data; fields are vetted below.
		parsed = JSON.parse(value) as JsonValue;
	} catch {
		return undefined;
	}
	const root = asObject(parsed);
	if (!root) return undefined;
	const atMs = asNumber(root.atMs);
	const hobo = parseLabelCapacity(root.hobo);
	const trunk = parseLabelCapacity(root["hobo-trunk"]);
	if (atMs === undefined || !hobo || !trunk) return undefined;
	return { atMs, hobo, "hobo-trunk": trunk };
}

export function fleetLabelCapacity(
	snapshot: FleetCapacitySnapshot,
	label: string,
): FleetLabelCapacity | undefined {
	if (label === "hobo-trunk") return snapshot["hobo-trunk"];
	if (label === "hobo") return snapshot.hobo;
	return undefined;
}
