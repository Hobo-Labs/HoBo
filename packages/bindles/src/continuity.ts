/**
 * The continuity trait (ADR-0145): how much of a stateful resource's data a
 * failure may lose, how fast HoBo moves it to another backend, how many
 * copies it keeps, and whether it keeps migrating to the cheapest backend
 * that still meets all of that.
 *
 * It declares intent only; nothing here names a provider. The fleet runtime
 * (`continuityFleetPlan` in `@hobo/backend-fleet`) turns it into the policy
 * the fleet decides with, the standbys placement asks for, and the cadence
 * the copy runs at. Every copy and every move is a step the next tick resumes
 * or undoes, so an interrupted migration continues instead of starting over
 * or stopping the workload.
 *
 * ```ts
 * const journal = b.data().with(continuity({ tier: "standard" }));
 * const cache = b.kv().with(continuity({ tier: "rebuildable" }));
 * ```
 *
 * Tiers are cost-balanced starting points; any field may be overridden:
 *
 * | tier          | loses at most | fails over after | standbys | backups      |
 * | ------------- | ------------- | ---------------- | -------- | ------------ |
 * | `rebuildable` | everything    | 1 min            | 0        | none         |
 * | `standard`    | 5 min         | 1 min            | 1        | daily, 7     |
 * | `critical`    | 30 s          | 15 s             | 2        | hourly, 48   |
 *
 * `rebuildable` is for state the workload can rebuild from its sources (a
 * cache, a lease table): it keeps no copy, and a move starts the new backend
 * cold. The other tiers keep standbys on other vendors where one is
 * configured, so one vendor's outage is a failover rather than a stop.
 */
import { isJsonObject, type JsonObject } from "./json.js";
import type { BindleDefinition, ProviderAnnotation } from "./types.js";

// public-contract: platform annotation option for the continuity trait.
export const CONTINUITY_OPTION = "continuity" as const;

export const CONTINUITY_TIERS = [
	"rebuildable",
	"standard",
	"critical",
] as const;
export type ContinuityTier = (typeof CONTINUITY_TIERS)[number];

/** `rebuild`: the workload rebuilds lost state. `restore`: HoBo restores it. */
export const CONTINUITY_ON_LOSS = ["rebuild", "restore"] as const;
export type ContinuityOnLoss = (typeof CONTINUITY_ON_LOSS)[number];

/**
 * `continuous`: move to a cheaper (or healthier) configured backend whenever
 * the rest of the policy still holds. `on-failure`: move only when the
 * writer fails.
 */
export const CONTINUITY_MIGRATION = ["continuous", "on-failure"] as const;
export type ContinuityMigration = (typeof CONTINUITY_MIGRATION)[number];

/** Resource kinds that hold state, and so can carry the trait. */
export const CONTINUITY_KINDS: ReadonlySet<string> = new Set([
	"data",
	"kv",
	"bucket",
	"queue",
	"topic",
	"secret",
]);

export type ContinuityPolicy = Readonly<{
	tier: ContinuityTier;
	onLoss: ContinuityOnLoss;
	/** Most recent writes a failure may lose (RPO), ms. 0 with `rebuild`. */
	recoveryPointMs: number;
	/** How long the writer must fail before HoBo moves (drives RTO), ms. */
	failoverAfterMs: number;
	/** Copies beside the writer, on other vendors where one is configured. */
	standbys: number;
	migration: ContinuityMigration;
	/** Logical backups off the fleet: every this many ms; 0 for none. */
	backupEveryMs: number;
	/** How many backups are kept. */
	backupsKept: number;
	/** Ceiling on the fleet's monthly spend, millionths of a US dollar. */
	monthlyBudgetMicros?: number;
}>;

export type ContinuityInput = Partial<Omit<ContinuityPolicy, "tier">> & {
	readonly tier?: ContinuityTier;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const CONTINUITY_TIER_DEFAULTS: Readonly<
	Record<ContinuityTier, ContinuityPolicy>
> = Object.freeze({
	rebuildable: Object.freeze({
		tier: "rebuildable",
		onLoss: "rebuild",
		recoveryPointMs: 0,
		failoverAfterMs: MINUTE,
		standbys: 0,
		migration: "continuous",
		backupEveryMs: 0,
		backupsKept: 0,
	}),
	standard: Object.freeze({
		tier: "standard",
		onLoss: "restore",
		recoveryPointMs: 5 * MINUTE,
		failoverAfterMs: MINUTE,
		standbys: 1,
		migration: "continuous",
		backupEveryMs: 24 * HOUR,
		backupsKept: 7,
	}),
	critical: Object.freeze({
		tier: "critical",
		onLoss: "restore",
		recoveryPointMs: 30_000,
		failoverAfterMs: 15_000,
		standbys: 2,
		migration: "continuous",
		backupEveryMs: HOUR,
		backupsKept: 48,
	}),
});

export class ContinuityError extends TypeError {
	readonly field: string;
	constructor(field: string, message: string) {
		super(`continuity ${field}: ${message}`);
		this.name = "ContinuityError";
		this.field = field;
	}
}

function count(field: string, value: number, min = 0): number {
	if (!Number.isSafeInteger(value) || value < min)
		throw new ContinuityError(field, `must be an integer of at least ${min}`);
	return value;
}

function oneOf<T extends string>(
	field: string,
	value: string,
	allowed: readonly T[],
): T {
	const found = allowed.find((candidate) => candidate === value);
	if (found === undefined)
		throw new ContinuityError(field, `must be one of ${allowed.join(", ")}`);
	return found;
}

/** Parse a continuity request into a whole, consistent policy. */
export function parseContinuityPolicy(
	input: ContinuityInput,
): ContinuityPolicy {
	const tier = oneOf("tier", input.tier ?? "standard", CONTINUITY_TIERS);
	const base = CONTINUITY_TIER_DEFAULTS[tier];
	const onLoss = oneOf(
		"onLoss",
		input.onLoss ?? base.onLoss,
		CONTINUITY_ON_LOSS,
	);
	const standbys = count("standbys", input.standbys ?? base.standbys);
	const recoveryPointMs = count(
		"recoveryPointMs",
		input.recoveryPointMs ?? base.recoveryPointMs,
	);
	const failoverAfterMs = count(
		"failoverAfterMs",
		input.failoverAfterMs ?? base.failoverAfterMs,
		1_000,
	);
	const backupEveryMs = count(
		"backupEveryMs",
		input.backupEveryMs ?? base.backupEveryMs,
	);
	const backupsKept = count(
		"backupsKept",
		input.backupsKept ?? base.backupsKept,
	);
	if (onLoss === "restore" && standbys === 0 && backupEveryMs === 0)
		throw new ContinuityError(
			"standbys",
			"restore needs a standby or a backup to restore from; use onLoss rebuild for state the workload rebuilds",
		);
	if (onLoss === "restore" && standbys > 0 && recoveryPointMs < 1_000)
		throw new ContinuityError(
			"recoveryPointMs",
			"a standby is a copy made on a schedule; allow at least 1000 ms of loss",
		);
	if (backupEveryMs > 0 && backupsKept === 0)
		throw new ContinuityError("backupsKept", "keep at least one backup");
	const budget = input.monthlyBudgetMicros;
	return Object.freeze({
		tier,
		onLoss,
		recoveryPointMs: onLoss === "rebuild" ? 0 : recoveryPointMs,
		failoverAfterMs,
		standbys,
		migration: oneOf(
			"migration",
			input.migration ?? base.migration,
			CONTINUITY_MIGRATION,
		),
		backupEveryMs,
		backupsKept,
		...(budget !== undefined
			? { monthlyBudgetMicros: count("monthlyBudgetMicros", budget) }
			: undefined),
	});
}

/** The trait, for `.with(continuity({ tier: "standard" }))`. */
export function continuity(input: ContinuityInput = {}): ProviderAnnotation {
	const policy = parseContinuityPolicy(input);
	return Object.freeze({
		provider: "hobo",
		option: CONTINUITY_OPTION,
		config: Object.freeze({ ...policy }),
	});
}

export function isContinuityAnnotation(
	annotation: ProviderAnnotation,
): boolean {
	return annotation.option === CONTINUITY_OPTION;
}

function numberAt(config: JsonObject, key: string): number | undefined {
	const value = config[key];
	return Number.isFinite(value) ? Number(value) : undefined;
}

function stringAt(config: JsonObject, key: string): string | undefined {
	const value = config[key];
	return value === undefined || value === null ? undefined : String(value);
}

/** The first continuity annotation's policy, parsed again; `null` when none. */
export function readContinuity(
	annotations: readonly ProviderAnnotation[],
): ContinuityPolicy | null {
	const found = annotations.find(isContinuityAnnotation);
	if (found === undefined || !isJsonObject(found.config)) return null;
	const config = found.config;
	const tier = stringAt(config, "tier");
	const onLoss = stringAt(config, "onLoss");
	const migration = stringAt(config, "migration");
	const budget = numberAt(config, "monthlyBudgetMicros");
	const standbys = numberAt(config, "standbys");
	const recoveryPointMs = numberAt(config, "recoveryPointMs");
	const failoverAfterMs = numberAt(config, "failoverAfterMs");
	const backupEveryMs = numberAt(config, "backupEveryMs");
	const backupsKept = numberAt(config, "backupsKept");
	return parseContinuityPolicy({
		...(tier !== undefined
			? { tier: oneOf("tier", tier, CONTINUITY_TIERS) }
			: undefined),
		...(onLoss !== undefined
			? { onLoss: oneOf("onLoss", onLoss, CONTINUITY_ON_LOSS) }
			: undefined),
		...(migration !== undefined
			? { migration: oneOf("migration", migration, CONTINUITY_MIGRATION) }
			: undefined),
		...(standbys !== undefined ? { standbys } : undefined),
		...(recoveryPointMs !== undefined ? { recoveryPointMs } : undefined),
		...(failoverAfterMs !== undefined ? { failoverAfterMs } : undefined),
		...(backupEveryMs !== undefined ? { backupEveryMs } : undefined),
		...(backupsKept !== undefined ? { backupsKept } : undefined),
		...(budget !== undefined ? { monthlyBudgetMicros: budget } : undefined),
	});
}

export type ContinuityViolation = Readonly<{
	code: "CONTINUITY_ON_STATELESS";
	resource: string;
	kind: string;
	message: string;
}>;

/** A continuity trait on a resource that holds no state is a mistake. */
export function continuityViolations(
	definition: BindleDefinition,
): readonly ContinuityViolation[] {
	return Object.freeze(
		Object.values(definition.resources).flatMap((resource) =>
			resource.annotations.some(isContinuityAnnotation) &&
			!CONTINUITY_KINDS.has(resource.kind)
				? [
						Object.freeze({
							code: "CONTINUITY_ON_STATELESS" as const,
							resource: resource.name,
							kind: resource.kind,
							message: `${resource.name} is a ${resource.kind}, which holds no state; put continuity on the data it keeps.`,
						}),
					]
				: [],
		),
	);
}

/** Every resource's declared continuity, by resource name. */
export function continuityPolicies(
	definition: BindleDefinition,
): ReadonlyMap<string, ContinuityPolicy> {
	const policies = new Map<string, ContinuityPolicy>();
	for (const resource of Object.values(definition.resources)) {
		const policy = readContinuity(resource.annotations);
		if (policy !== null) policies.set(resource.name, policy);
	}
	return policies;
}
