// Shared staging for the executor hardening tests: a small dataset, a verdict
// that covers every custody role, pairs of reference engines for either
// realization, and a way to kill a run at an exact side effect.
import {
	type AuthorityFlip,
	type CopyMigrationOptions,
	CUSTODY_ROLES,
	createMemoryMigrationJournal,
	createReferenceEngine,
	createReferenceNativeLink,
	type DatasetSchema,
	deleteMutation,
	type EngineBinding,
	encodeRecordKey,
	evaluateCustodyPath,
	type MigrationFact,
	type MigrationJournal,
	type MigrationRuntime,
	type PolicyVerdict,
	parseCanonicalRecord,
	parseCustodyPath,
	parseDatasetSchema,
	REFERENCE_NATIVE_PROFILE,
	type RecordMutation,
	type ReferenceNativeLink,
	requirePort,
	type SpiPortName,
	scopeOf,
	upsertMutation,
} from "../../src/index.js";

export const NOW = "2026-11-10T00:00:00.000Z";

export const ORDERS: DatasetSchema = parseDatasetSchema({
	name: "orders",
	keyFields: ["id"],
	fields: [
		{ name: "id", type: "string", nullable: false },
		{ name: "total", type: "decimal", nullable: false },
	],
});

/** One point per role, so no copy a run creates is off the path. */
export const EVERY_ROLE_PATH = parseCustodyPath({
	points: CUSTODY_ROLES.map((role) => ({
		id: role,
		role,
		region: "eu-west-1",
		protections: [],
		...(role === "source" || role === "target" || role === "event-log"
			? undefined
			: { retainUntil: "2026-11-17T00:00:00.000Z" }),
	})),
});

export const ALLOW: PolicyVerdict = evaluateCustodyPath({
	path: EVERY_ROLE_PATH,
	policy: { classification: "public" },
	now: NOW,
});

export function order(id: string, total: string, tenant = ""): RecordMutation {
	const record = parseCanonicalRecord(ORDERS, { id, total });
	return upsertMutation(tenant, encodeRecordKey(ORDERS, record), record);
}

export function keyOf(id: string): string {
	return encodeRecordKey(
		ORDERS,
		parseCanonicalRecord(ORDERS, { id, total: "0" }),
	);
}

export function erase(id: string, tenant = ""): RecordMutation {
	return deleteMutation(tenant, keyOf(id));
}

export const REALIZATIONS = ["hub", "native"] as const;
export type Realization = (typeof REALIZATIONS)[number];

export interface Stage {
	readonly realization: Realization;
	readonly source: EngineBinding;
	readonly target: EngineBinding;
	readonly journal: MigrationJournal;
	readonly link?: ReferenceNativeLink;
}

export interface StageOptions {
	readonly rows?: number;
	readonly sourceOmit?: readonly SpiPortName[];
	readonly targetOmit?: readonly SpiPortName[];
}

/**
 * A seeded source and an empty target. A native pair is linked and stripped
 * of the ports the hub would need, so a native run that completes cannot have
 * gone through the hub.
 */
export async function stage(
	realization: Realization,
	options: StageOptions = {},
): Promise<Stage> {
	const hubless: readonly SpiPortName[] = ["snapshot", "capture", "apply"];
	const link =
		realization === "native" ? createReferenceNativeLink() : undefined;
	const source = createReferenceEngine({
		engine: "source",
		omit: [
			...(link === undefined ? [] : hubless),
			...(options.sourceOmit ?? []),
		],
		...(link === undefined ? undefined : { native: link }),
	});
	const target = createReferenceEngine({
		// A native fast path exists only within one engine.
		engine: link === undefined ? "target" : "source",
		omit: [
			...(link === undefined ? [] : hubless),
			...(options.targetOmit ?? []),
		],
		...(link === undefined ? undefined : { native: link }),
	});
	await source.datasets.ensureDataset(ORDERS);
	await source.records.write({
		dataset: "orders",
		mutations: Array.from({ length: options.rows ?? 5 }, (_, index) =>
			order(`o-${index}`, String(index)),
		),
	});
	return {
		realization,
		source,
		target,
		journal: createMemoryMigrationJournal(),
		...(link === undefined ? undefined : { link }),
	};
}

export function runtimeOf(
	journal: MigrationJournal,
	extra: Partial<MigrationRuntime> = {},
): MigrationRuntime {
	return {
		migrationId: "m1",
		journal,
		clock: () => NOW,
		policy: () => ALLOW,
		...extra,
	};
}

export function copyOptions(
	staged: Stage,
	extra: Partial<CopyMigrationOptions> = {},
	run: Partial<MigrationRuntime> = {},
): CopyMigrationOptions {
	return {
		runtime: runtimeOf(staged.journal, run),
		source: staged.source,
		target: staged.target,
		schema: ORDERS,
		scope: scopeOf("orders"),
		maxTailRounds: 4,
		buckets: 4,
		flipAuthority: () => {},
		...(staged.realization === "native"
			? { realization: "native", profile: REFERENCE_NATIVE_PROFILE }
			: undefined),
		...extra,
	};
}

export async function count(binding: EngineBinding): Promise<number> {
	const digest = await requirePort(binding, "verify").digest({
		scope: scopeOf("orders"),
		buckets: 4,
	});
	return digest.count;
}

export async function fenced(binding: EngineBinding): Promise<boolean> {
	// A store the migration has not provisioned yet has nothing to fence.
	if ((await binding.datasets.describeDataset("orders")) === undefined) {
		return false;
	}
	const status = await requirePort(binding, "fence").status(scopeOf("orders"));
	return status.fenced;
}

export async function totalOf(
	binding: EngineBinding,
	id: string,
): Promise<string | undefined> {
	const record = await binding.records.read({
		dataset: "orders",
		tenant: "",
		key: keyOf(id),
	});
	return record === undefined ? undefined : String(record.total);
}

/** Whether a plain write — no fence token — is accepted. Leaves no record. */
export async function writable(binding: EngineBinding): Promise<boolean> {
	try {
		await binding.records.write({
			dataset: "orders",
			mutations: [erase("probe-that-never-existed")],
		});
		return true;
	} catch {
		return false;
	}
}

export function types(facts: readonly MigrationFact[]): string[] {
	return facts.map((fact) => fact.type.replace("migration.", ""));
}

// ── killing a run at an exact side effect ───────────────────────────────────

/** The process died. Everything it tries afterwards fails the same way. */
export class Crash extends Error {
	constructor(at: string) {
		super(`process died at ${at}`);
		this.name = "Crash";
	}
}

export const CRASH_MODES = ["before", "after"] as const;
/** `before`: the call never ran. `after`: it ran, and nobody heard back. */
export type CrashMode = (typeof CRASH_MODES)[number];

/**
 * Counts side effects and kills the run at the Nth. Once dead, every further
 * call through a wrapped port, journal or callback throws: a dead process
 * does not run its `catch` blocks against the stores either.
 */
export class Chaos {
	calls = 0;
	dead = false;
	readonly trace: string[] = [];

	constructor(
		private readonly crashAt?: number,
		private readonly mode: CrashMode = "before",
	) {}

	/** A side effect: counted, and the place a crash can fall. */
	async effect<T>(name: string, action: () => T | Promise<T>): Promise<T> {
		if (this.dead) throw new Crash(name);
		this.calls += 1;
		this.trace.push(name);
		if (this.calls !== this.crashAt) return action();
		if (this.mode === "before") {
			this.dead = true;
			throw new Crash(name);
		}
		await action();
		this.dead = true;
		throw new Crash(name);
	}

	/** A read: not counted, but a dead process cannot make it. */
	async read<T>(name: string, action: () => T | Promise<T>): Promise<T> {
		if (this.dead) throw new Crash(name);
		return action();
	}
}

/** A binding whose every port goes through `chaos`. */
export function chaotic(
	binding: EngineBinding,
	side: string,
	chaos: Chaos,
): EngineBinding {
	const { snapshot, capture, apply, verify, fence, retire, nativeTransfer } =
		binding;
	const at = (name: string) => `${side}.${name}`;
	return {
		declaration: binding.declaration,
		datasets: {
			ensureDataset: (schema) =>
				chaos.effect(at("datasets.ensure"), () =>
					binding.datasets.ensureDataset(schema),
				),
			describeDataset: (name) =>
				chaos.read(at("datasets.describe"), () =>
					binding.datasets.describeDataset(name),
				),
		},
		records: {
			write: (request) =>
				chaos.effect(at("records.write"), () => binding.records.write(request)),
			read: (request) =>
				chaos.read(at("records.read"), () => binding.records.read(request)),
		},
		...(snapshot === undefined
			? undefined
			: {
					snapshot: {
						openSnapshot: (request) =>
							chaos.read(at("snapshot.open"), () =>
								snapshot.openSnapshot(request),
							),
					},
				}),
		...(capture === undefined
			? undefined
			: {
					capture: {
						start: (request) =>
							chaos.effect(at("capture.start"), () => capture.start(request)),
						read: (request) =>
							chaos.read(at("capture.read"), () => capture.read(request)),
						acknowledge: (request) =>
							chaos.read(at("capture.acknowledge"), () =>
								capture.acknowledge(request),
							),
						stop: (subscription) =>
							chaos.effect(at("capture.stop"), () =>
								capture.stop(subscription),
							),
					},
				}),
		...(apply === undefined
			? undefined
			: {
					apply: {
						apply: (request) =>
							chaos.effect(at("apply"), () => apply.apply(request)),
						watermark: (request) =>
							chaos.read(at("apply.watermark"), () => apply.watermark(request)),
					},
				}),
		...(verify === undefined
			? undefined
			: {
					verify: {
						digest: (request) =>
							chaos.read(at("verify.digest"), () => verify.digest(request)),
					},
				}),
		...(fence === undefined
			? undefined
			: {
					fence: {
						raise: (request) =>
							chaos.effect(at("fence.raise"), () => fence.raise(request)),
						release: (request) =>
							chaos.effect(at("fence.release"), () => fence.release(request)),
						status: (scope) =>
							chaos.read(at("fence.status"), () => fence.status(scope)),
					},
				}),
		...(retire === undefined
			? undefined
			: {
					retire: {
						retire: (request) =>
							chaos.effect(at("retire"), () => retire.retire(request)),
					},
				}),
		...(nativeTransfer === undefined
			? undefined
			: {
					nativeTransfer: {
						profiles: nativeTransfer.profiles,
						publish: (request) =>
							chaos.effect(at("native.publish"), () =>
								nativeTransfer.publish(request),
							),
						subscribe: (request) =>
							chaos.effect(at("native.subscribe"), () =>
								nativeTransfer.subscribe(request),
							),
						seeded: (request) =>
							chaos.read(at("native.seeded"), () =>
								nativeTransfer.seeded(request),
							),
						mark: (request) =>
							chaos.read(at("native.mark"), () => nativeTransfer.mark(request)),
						reached: (request) =>
							chaos.read(at("native.reached"), () =>
								nativeTransfer.reached(request),
							),
						stop: (request) =>
							chaos.effect(at("native.stop"), () =>
								nativeTransfer.stop(request),
							),
					},
				}),
		close: () => binding.close(),
	};
}

export function chaoticJournal(
	journal: MigrationJournal,
	chaos: Chaos,
): MigrationJournal {
	return {
		load: (migrationId) =>
			chaos.read("journal.load", () => journal.load(migrationId)),
		append: (migrationId, fact, expectedCount) =>
			chaos.effect(
				`journal.append ${fact.type.replace("migration.", "")}`,
				() => journal.append(migrationId, fact, expectedCount),
			),
	};
}

/** Where write authority is, as the application's router sees it. */
export class Authority {
	side: "source" | "target" = "source";
	/** Authority has been on the target at some point. */
	everOnTarget = false;
	readonly flips: AuthorityFlip["direction"][] = [];

	readonly flip = (flip: AuthorityFlip): void => {
		this.flips.push(flip.direction);
		this.side = flip.direction === "to-target" ? "target" : "source";
		if (this.side === "target") this.everOnTarget = true;
	};
}
