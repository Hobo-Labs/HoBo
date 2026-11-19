import {
	type AuthorityFlip,
	admitAuthorityMove,
	type CopyMigrationOptions,
	CrashInjector,
	type CrashMode,
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

export {
	CRASH_MODES,
	type CrashMode,
	crashingBinding as chaotic,
	crashingJournal as chaoticJournal,
	InjectedCrash as Crash,
} from "../../src/index.js";

export class Chaos extends CrashInjector {
	constructor(crashAt?: number, mode: CrashMode = "before") {
		super(crashAt === undefined ? undefined : { occurrence: crashAt, mode });
	}
}

export class Authority {
	side: "source" | "target" = "source";
	everOnTarget = false;
	readonly flips: AuthorityFlip["direction"][] = [];
	readonly refused: AuthorityFlip[] = [];
	private readonly applied = new Map<string, number>();

	readonly flip = (flip: AuthorityFlip): void => {
		try {
			admitAuthorityMove(this.applied, flip);
		} catch (error) {
			this.refused.push(flip);
			throw error;
		}
		this.flips.push(flip.direction);
		this.side = flip.direction === "to-target" ? "target" : "source";
		if (this.side === "target") this.everOnTarget = true;
	};
}
