/**
 * The engine conformance kit (ADR-0177 §9 of the design note).
 *
 * One suite, run against any `EngineBinding` through a harness that creates
 * fresh bindings. It proves the ports mean what the SPI says they mean, and
 * then proves the patterns built on them: zero loss under load, a single
 * write authority, resume at every phase boundary, a lossless soak, and a
 * rollback that cannot resurrect an erased subject.
 *
 * The fold is pessimistic on purpose. A case that fails is `fail`; a case
 * whose port the engine declares but whose check could not run is `not-run`,
 * which makes the outcome `unknown`; and `unknown` is as non-selectable as
 * `fail`. The only way to be selected is to have actually run the checks.
 */
import { inspect } from "node:util";
import type { DataClassification } from "@hobo/core";
import {
	type CanonicalRecord,
	type DatasetSchema,
	encodeRecordKey,
	parseCanonicalRecord,
	parseDatasetSchema,
	schemaDigest,
} from "./canonical.js";
import {
	CrashInjector,
	type CrashMode,
	type CrashPoint,
	crashingBinding,
	crashingJournal,
} from "./crash-injection.js";
import {
	CUSTODY_ROLES,
	type CustodyPath,
	evaluateCustodyPath,
	type PolicyVerdict,
	parseCustodyPath,
} from "./custody.js";
import { compareDigests, DatasetDigestBuilder } from "./digest.js";
import {
	deleteMutation,
	type RecordMutation,
	upsertMutation,
} from "./envelope.js";
import { DataCoreError, FencedWriteError, StaleApplyError } from "./errors.js";
import {
	type AuthorityFlip,
	type CopyMigrationOptions,
	runOfflineCopy,
	runSnapshotAndTail,
} from "./executors/copy.js";
import {
	type InPlaceEvolvePlan,
	runInPlaceEvolve,
} from "./executors/in-place.js";
import {
	admitAuthorityMove,
	type MigrationRunResult,
	type MigrationRuntime,
} from "./executors/runtime.js";
import {
	createMemoryMigrationJournal,
	MIGRATION_EVENTS,
	type MigrationJournal,
} from "./facts.js";
import {
	canonicalEncode,
	type JsonObject,
	type JsonValue,
	sha256Hex,
} from "./json.js";
import type { MigrationPatternId, MigrationPhase } from "./patterns.js";
import {
	createReferenceEngine,
	type ReferenceEngineOptions,
	referencePositionPastHead,
	withoutPorts,
} from "./reference-engine.js";
import type { ConformanceOutcome } from "./selector.js";
import {
	type Awaitable,
	assertBindingMatchesDeclaration,
	type DatasetScope,
	type EngineBinding,
	type EngineDeclaration,
	requirePort,
	type SpiPortName,
	scopeOf,
	sharedNativeProfile,
} from "./spi.js";

// public-contract: reference id of the engine conformance suite; recorded with every report.
export const ENGINE_CONFORMANCE_SUITE = "hobo.data-engine-conformance/v1";

export const CONFORMANCE_STATUSES = [
	"pass",
	"fail",
	"blocked",
	"not-run",
	// The engine does not hold the property and its declaration says so, in an
	// impedance code. Not a pass: the case ran and the property is not there.
	"declared-limit",
] as const;
export type ConformanceStatus = (typeof CONFORMANCE_STATUSES)[number];

// domain-view: recorded result; wire form is EngineConformanceResult in data-models/data_core.proto.
export interface EngineConformanceResult {
	readonly caseId: string;
	readonly status: ConformanceStatus;
	/** Operator-facing detail. Never contains record payload or credentials. */
	readonly detail: string;
}

// domain-view: recorded report; wire form is EngineConformanceReport in data-models/data_core.proto.
export interface EngineConformanceReport {
	readonly suite: typeof ENGINE_CONFORMANCE_SUITE;
	readonly engine: string;
	readonly outcome: ConformanceOutcome;
	readonly results: readonly EngineConformanceResult[];
	/** Cases skipped because the engine does not declare the port. */
	readonly skipped: readonly string[];
	/**
	 * The case ids the run was restricted to; empty when the whole suite ran.
	 * A restricted run proves what it ran and nothing else, so it never folds
	 * to `pass`.
	 */
	readonly only: readonly string[];
	readonly checkedAt: string;
}

/**
 * Fold case results into one outcome. Any failure is `fail`; anything
 * unproven is `unknown`. Shared by every engine package so "passes
 * conformance" means the same thing everywhere.
 *
 * A `declared-limit` is neither: like a port an engine does not declare, it is
 * a stated fact about the engine, recorded in the report for whoever selects
 * it, and it does not make the outcome worse.
 *
 * `only` is the filter the run was restricted to. A restricted run can fail,
 * but it cannot pass: the cases it left out are unproven, so the best it
 * folds to is `unknown` — which is as non-selectable as `fail`. One case run
 * on its own can therefore never be presented as conformance.
 */
export function foldConformance(
	results: readonly EngineConformanceResult[],
	only: readonly string[] = [],
): ConformanceOutcome {
	if (
		results.some(
			(result) => result.status === "fail" || result.status === "blocked",
		)
	) {
		return "fail";
	}
	if (only.length > 0) return "unknown";
	return results.some((result) => result.status === "not-run")
		? "unknown"
		: "pass";
}

/** SQL an engine with a `schema` port supplies so in-place-evolve can be proven. */
export interface SchemaFixture {
	/** Statements that create and populate the starting table. */
	readonly setup: readonly string[];
	readonly plan: InPlaceEvolvePlan;
	/** A violations query that must return rows once the contract phase ran. */
	readonly provesContractApplied: string;
	/** A statement that must fail, to prove a failed phase rolls back. */
	readonly failingStatement: string;
	/**
	 * Two statements with separate, visible effects, for the probes that put
	 * more than one statement where one belongs. Without them those cases
	 * apply but cannot run.
	 */
	readonly probes?: SchemaStatementProbes;
}

/** Two independent statements, and a query that shows each one ran. */
export interface SchemaStatementProbes {
	readonly first: string;
	readonly second: string;
	/** A violations query that returns rows once `first` has run, and none before. */
	readonly provesFirst: string;
	/** A violations query that returns rows once `second` has run, and none before. */
	readonly provesSecond: string;
}

/** Two fresh bindings an engine's native profile can transfer between. */
export interface NativePair {
	readonly source: EngineBinding;
	readonly target: EngineBinding;
}

export interface EngineHarness {
	/** A fresh, empty binding. `label` distinguishes several within one case. */
	create(label: string): Awaitable<EngineBinding>;
	dispose?(binding: EngineBinding): Awaitable<void>;
	readonly schemaFixture?: SchemaFixture;
	/**
	 * A source and a target, both fresh and empty, placed so the engine's
	 * native profile can run between them — the same schema name in two
	 * databases, say, with the target told how to reach the source. Only an
	 * engine that declares a native profile needs it, and only when two
	 * bindings from `create` would not already do.
	 */
	createNativePair?(label: string): Awaitable<NativePair>;
	/**
	 * Names the engine keeps for its own bookkeeping, tried as dataset names
	 * in addition to the ones the kit already knows engines to use.
	 */
	readonly reservedDatasetNames?: readonly string[];
	/**
	 * Properties this engine does not hold, and says it does not: case id to
	 * the impedance code in its declaration that states the limit. Honoured
	 * only for the cases the kit allows a limit on, and only for a code the
	 * declaration really lists — anything else is refused before a case runs.
	 *
	 * The case still runs. Failing its expectations, it is reported
	 * `declared-limit` instead of `fail`. Passing, it is a failure: the
	 * declaration then states a limit the engine does not have.
	 */
	readonly declaredLimits?: Readonly<Record<string, string>>;
	/**
	 * A second binding over the same store as `binding`: another connection to
	 * the same database, another handle on the same file. Needed to prove what
	 * two bindings do to each other; a harness for an engine with a `schema`
	 * port supplies it, or those cases apply but cannot run.
	 */
	attach?(binding: EngineBinding, label: string): Awaitable<EngineBinding>;
	/**
	 * A well-formed capture position past `head`, the position a caught-up
	 * read just answered: one the engine could mint later and has not minted
	 * yet. Positions are opaque to the kit, so only the harness can make one.
	 * An engine with a `capture` port supplies it, or the case that proves a
	 * position past the head is refused applies but cannot run.
	 */
	positionPastHead?(head: string): string;
}

export interface RunEngineConformanceInput {
	readonly engine: EngineHarness;
	/**
	 * The other side of the pattern cases. Defaults to `engine`, which proves a
	 * same-engine move; pass another engine's harness to prove a cross-engine one.
	 */
	readonly peer?: EngineHarness;
	/** Injected instant, RFC 3339. */
	readonly now: string;
	/**
	 * Restrict to these case ids; absent runs every case. The report records
	 * the restriction and never folds to `pass` under one.
	 */
	readonly only?: readonly string[];
	/**
	 * Diagnostics for whoever runs the kit: the raw error of a case that
	 * failed, as thrown. It may carry a connection string or a record, which is
	 * why the report keeps only its class — what this receives must stay out of
	 * evidence too.
	 */
	readonly onFailure?: (caseId: string, error: Error) => void;
}

/**
 * A harness for the reference engine: fresh in-memory engines, plus what the
 * kit cannot derive for itself. Useful as the `peer` of a cross-engine run.
 */
export function referenceEngineHarness(
	options: ReferenceEngineOptions = {},
): EngineHarness {
	return {
		create: () => createReferenceEngine(options),
		positionPastHead: referencePositionPastHead,
	};
}

interface CaseContext {
	readonly input: RunEngineConformanceInput;
	/** The native profile engine and peer share for the case's pattern. */
	readonly nativeProfile: string | undefined;
	open(label: string): Promise<EngineBinding>;
	openPeer(label: string): Promise<EngineBinding>;
	openNativePair(label: string): Promise<NativePair>;
	/** A second binding on the store behind one `open` returned. */
	attach(binding: EngineBinding, label: string): Promise<EngineBinding>;
}

interface ConformanceCase {
	readonly id: string;
	/** Ports the engine under test must declare for the case to apply. */
	readonly requires: readonly SpiPortName[];
	/**
	 * Set on a case that proves a `native` realization of this pattern. It
	 * applies only when engine and peer declare a shared native profile for
	 * the pattern; otherwise it is skipped, exactly as a case whose port the
	 * engine does not declare is skipped.
	 */
	readonly native?: MigrationPatternId;
	/**
	 * True when an engine may declare this property a limit instead of holding
	 * it (`EngineHarness.declaredLimits`). False for everything a migration's
	 * safety rests on: no declaration excuses a fence that lets a write past.
	 */
	readonly limitable?: boolean;
	/**
	 * Something the declaration must state, beyond its ports, for the case to
	 * apply — a size bound, say. An engine that does not state it is skipped,
	 * like one that does not declare a port: the kit never invents the value.
	 */
	readonly declares?: (declaration: EngineDeclaration) => boolean;
	/** Ports the peer must declare; a peer without them makes the case `not-run`. */
	readonly peerRequires?: readonly SpiPortName[];
	readonly dependsOn?: readonly string[];
	run(context: CaseContext): Promise<void>;
}

/** A failed expectation inside a case. Its message is the recorded detail. */
class Expectation extends Error {
	constructor(message: string) {
		super(message);
		this.name = "Expectation";
	}
}

function expect(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Expectation(message);
}

// ── fixtures ────────────────────────────────────────────────────────────────

// public-contract: dataset name every conformance case provisions; engines isolate by store, not by name.
export const CONFORMANCE_DATASET = "hobo_conformance_orders";

/**
 * One field of every canonical type. An engine that cannot carry a type says
 * so in its annex and the kit leaves that field out of the schema it uses.
 */
const ALL_FIELDS: readonly JsonObject[] = Object.freeze([
	{ name: "id", type: "string", nullable: false },
	{ name: "qty", type: "int64", nullable: false },
	{ name: "price", type: "decimal", nullable: false },
	{ name: "weight", type: "float64", nullable: false },
	{ name: "active", type: "bool", nullable: false },
	{ name: "note", type: "string", nullable: true },
	{ name: "blob", type: "bytes", nullable: false },
	{ name: "placed_at", type: "timestamp", nullable: false },
	{ name: "due", type: "date", nullable: false },
	{ name: "ref", type: "uuid", nullable: false },
	{ name: "attrs", type: "json", nullable: false },
	{ name: "card", type: "encrypted", nullable: true },
]);

/** The conformance schema restricted to types every given engine can carry. */
export function conformanceSchema(
	bindings: readonly EngineBinding[],
): DatasetSchema {
	const fields = ALL_FIELDS.filter((field) =>
		bindings.every((binding) =>
			binding.declaration.typeMapping.edges.some(
				(edge) =>
					edge.canonical === field.type &&
					edge.write !== "lossy" &&
					edge.read !== "lossy",
			),
		),
	);
	return parseDatasetSchema({
		name: CONFORMANCE_DATASET,
		version: 1,
		keyFields: ["id"],
		fields: [...fields],
	});
}

/** The sentinel appears in a payload and must never appear in evidence. */
const PAYLOAD_SENTINEL = "hobo-conformance-payload-sentinel";

const RAW_RECORD: JsonObject = Object.freeze({
	qty: "9007199254740993",
	price: "001234.5600",
	weight: 0.1,
	active: true,
	note: `quote ' "double" and ünïcödé — ${PAYLOAD_SENTINEL}`,
	blob: "AAECA/8=",
	placed_at: "2026-01-02T05:04:05.678+02:00",
	due: "2026-02-28",
	ref: "0F8FAD5B-D9CB-469F-A165-70867728950E",
	attrs: { z: [1, 2, { nested: null }], a: "b" },
	card: {
		alg: "AES-256-GCM",
		keyRef: "key://subject/1",
		ciphertext: "3q2+7w==",
	},
});

function recordFor(
	schema: DatasetSchema,
	id: string,
	overrides: JsonObject = {},
): CanonicalRecord {
	const raw: { [key: string]: JsonValue } = {};
	raw.id = id;
	for (const field of schema.fields) {
		if (field.name === "id") continue;
		// An override is taken as given — `null` and `""` included. Falling
		// through on `null` would mean no probe ever stored one.
		raw[field.name] = Object.hasOwn(overrides, field.name)
			? (overrides[field.name] ?? null)
			: (RAW_RECORD[field.name] ?? null);
	}
	return parseCanonicalRecord(schema, raw);
}

function upsert(
	schema: DatasetSchema,
	tenant: string,
	id: string,
	overrides: JsonObject = {},
): RecordMutation {
	const record = recordFor(schema, id, overrides);
	return upsertMutation(tenant, encodeRecordKey(schema, record), record);
}

function keyOf(schema: DatasetSchema, id: string): string {
	return encodeRecordKey(schema, recordFor(schema, id));
}

async function write(
	binding: EngineBinding,
	mutations: readonly RecordMutation[],
	fenceToken?: string,
): Promise<void> {
	await binding.records.write({
		dataset: CONFORMANCE_DATASET,
		mutations,
		...(fenceToken === undefined ? undefined : { fenceToken }),
	});
}

async function refuses(
	action: () => Awaitable<void>,
): Promise<Error | undefined> {
	try {
		await action();
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
	return undefined;
}

const RETENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A custody path the kit's migrations are allowed over: one point for every
 * role, so whichever pattern and realization a case runs, no copy it creates
 * is off the path. A bounded copy is retained for a week past `now`.
 */
function allowingPath(now: string): CustodyPath {
	const retainUntil = new Date(
		Date.parse(now) + RETENTION_WINDOW_MS,
	).toISOString();
	return parseCustodyPath({
		points: CUSTODY_ROLES.map((role) => ({
			id: role,
			role,
			region: "eu-west-1",
			protections: [],
			...(role === "source" || role === "target" || role === "event-log"
				? undefined
				: { retainUntil }),
		})),
	});
}

function allow(now: string): () => PolicyVerdict {
	const classification: DataClassification = "public";
	const path = allowingPath(now);
	return () => evaluateCustodyPath({ path, policy: { classification }, now });
}

function runtime(
	id: string,
	now: string,
	journal: MigrationJournal,
	extra: Partial<MigrationRuntime> = {},
): MigrationRuntime {
	return {
		migrationId: id,
		journal,
		clock: () => now,
		policy: allow(now),
		...extra,
	};
}

async function digestsEqual(
	source: EngineBinding,
	target: EngineBinding,
	tenant = "",
): Promise<boolean> {
	const scope = scopeOf(CONFORMANCE_DATASET, tenant);
	const left = await requirePort(source, "verify").digest({
		scope,
		buckets: 8,
	});
	const right = await requirePort(target, "verify").digest({
		scope,
		buckets: 8,
	});
	return compareDigests(left, right).equal;
}

const COPY_SOURCE: readonly SpiPortName[] = [
	"snapshot",
	"capture",
	"verify",
	"fence",
	"retire",
];
const COPY_TARGET: readonly SpiPortName[] = ["apply", "verify"];

interface Pair {
	readonly source: EngineBinding;
	readonly target: EngineBinding;
	readonly schema: DatasetSchema;
}

async function seededPair(context: CaseContext, rows: number): Promise<Pair> {
	const source = await context.open("source");
	const target = await context.openPeer("target");
	const schema = conformanceSchema([source, target]);
	await source.datasets.ensureDataset(schema);
	const mutations: RecordMutation[] = [];
	for (let index = 0; index < rows; index += 1) {
		mutations.push(
			upsert(schema, "", `order-${index}`, { qty: String(index) }),
		);
	}
	await write(source, mutations);
	return { source, target, schema };
}

function copyOptions(
	pair: Pair,
	run: MigrationRuntime,
	extra: Partial<CopyMigrationOptions> = {},
): CopyMigrationOptions {
	return {
		runtime: run,
		source: pair.source,
		target: pair.target,
		schema: pair.schema,
		scope: scopeOf(CONFORMANCE_DATASET),
		chunkSize: 7,
		tailBatch: 5,
		buckets: 8,
		flipAuthority: () => {},
		...extra,
	};
}

/** The token of a raised fence: raising a raised fence answers it. */
async function raisedToken(binding: EngineBinding): Promise<string> {
	const grant = await requirePort(binding, "fence").raise({
		scope: scopeOf(CONFORMANCE_DATASET),
		reason: "conformance",
	});
	return grant.fenceToken;
}

/**
 * Names engines are known to keep for their own bookkeeping. A dataset given
 * one of them must be refused, or must be harmless: the engine's own tables
 * are not a place a caller's schema may land.
 */
const KNOWN_METADATA_NAMES: readonly string[] = Object.freeze([
	"hobo_data_datasets",
	"hobo_data_fences",
	"hobo_data_watermarks",
	"hobo_data_subscriptions",
	"hobo_data_journal",
	"hobo_data_journal_scope",
	"hobo_data_schema_snapshots",
	"hobo_dual_run_pin",
]);

/** A long key no engine can compress away: 2,500 characters of digest text. */
const LARGE_KEY = Array.from({ length: 40 }, (_, index) =>
	sha256Hex(`hobo-conformance-large-key-${index}`),
)
	.join("")
	.slice(0, 2500);

/** Not a position any engine mints. */
const GARBAGE_POSITION = "hobo-conformance-not-a-position";

// public-contract: dataset name of the open-schema conformance probe.
export const CONFORMANCE_OPEN_DATASET = "hobo_conformance_open";

const NATIVE_SOURCE: readonly SpiPortName[] = ["verify", "fence", "retire"];
const NATIVE_TARGET: readonly SpiPortName[] = ["verify"];

async function seededNativePair(
	context: CaseContext,
	rows: number,
): Promise<Pair> {
	const { source, target } = await context.openNativePair("native");
	const schema = conformanceSchema([source, target]);
	await source.datasets.ensureDataset(schema);
	const mutations: RecordMutation[] = [];
	for (let index = 0; index < rows; index += 1) {
		mutations.push(
			upsert(schema, "", `order-${index}`, { qty: String(index) }),
		);
	}
	await write(source, mutations);
	return { source, target, schema };
}

function nativeOptions(context: CaseContext): Partial<CopyMigrationOptions> {
	if (context.nativeProfile === undefined) {
		throw new NotRun("engine and peer share no native profile");
	}
	return { realization: "native", profile: context.nativeProfile };
}

interface WriterTally {
	/** Ids of writes the source acknowledged, in order. */
	readonly acknowledged: string[];
	/** Anything other than "landed" or "refused by the fence". */
	readonly problems: string[];
}

/**
 * A writer that keeps writing to the source until it is told to stop or the
 * fence refuses it. Every write is its own transaction; some revisit a record
 * the same writer wrote earlier, so the tail carries updates as well.
 */
async function keepWriting(
	pair: Pair,
	name: string,
	tally: WriterTally,
	stopped: () => boolean,
): Promise<void> {
	for (let round = 0; round < 400 && !stopped(); round += 1) {
		const id = `${name}-${round}`;
		const mutations = [upsert(pair.schema, "", id, { qty: String(round) })];
		if (round % 4 === 3) {
			mutations.push(
				upsert(pair.schema, "", `${name}-${round - 2}`, { qty: "-1" }),
			);
		}
		const refused = await refuses(() => write(pair.source, mutations));
		if (refused instanceof FencedWriteError) return;
		if (refused !== undefined) {
			tally.problems.push(`${id} threw ${refused.name}`);
			return;
		}
		tally.acknowledged.push(id);
	}
}

/** Well-formed text that is no fence's token. */
const FOREIGN_TOKEN = "hobo-conformance-not-a-fence-token";

// public-contract: dataset name of the uuid-keyed conformance probe.
export const CONFORMANCE_REFS_DATASET = "hobo_conformance_refs";

// public-contract: dataset name of the second dataset a capture probe binds a subscription name against.
export const CONFORMANCE_SECOND_DATASET = "hobo_conformance_second";

/** The largest declared record bound the kit will build a record past. */
const LARGEST_PROBED_RECORD_BYTES = 256 * 1024 * 1024;

async function recordOf(
	binding: EngineBinding,
	schema: DatasetSchema,
	tenant: string,
	id: string,
): Promise<CanonicalRecord | undefined> {
	return binding.records.read({
		dataset: schema.name,
		tenant,
		key: keyOf(schema, id),
	});
}

async function countIn(binding: EngineBinding, tenant = ""): Promise<number> {
	const digest = await requirePort(binding, "verify").digest({
		scope: scopeOf(CONFORMANCE_DATASET, tenant),
		buckets: 8,
	});
	return digest.count;
}

/**
 * Everything an error shows someone who logs it: its message and stack, every
 * property it carries, enumerable or not, and every cause beneath it.
 */
function exposureOf(error: Error): string {
	const shown = [inspect(error, { depth: null, showHidden: true })];
	try {
		shown.push(JSON.stringify(error) ?? "");
	} catch {
		// A cyclic error has no JSON form; `inspect` above already walked it.
	}
	shown.push(String(error));
	return shown.join("\n");
}

// ── crash windows ───────────────────────────────────────────────────────────

/** Where write authority is, as the application's router sees it. */
interface AuthorityTrace {
	side: "source" | "target";
	/** Authority has been on the target at some point. */
	everOnTarget: boolean;
	readonly flips: AuthorityFlip["direction"][];
	/**
	 * The highest journal head the router has applied, per migration: a flip
	 * decided at a lower one is refused, as a real router must refuse it.
	 */
	readonly applied: Map<string, number>;
}

/** One staged migration a crash is injected into. */
interface CrashWorld {
	readonly migrationId: string;
	readonly pair: Pair;
	readonly journal: MigrationJournal;
	readonly authority: AuthorityTrace;
}

interface CrashScenario {
	readonly name: string;
	/** Side effects a crash is injected at, by name; each before it ran and after. */
	readonly windows: readonly string[];
	/** Windows the crash-free run must pass through, or the scenario proves nothing. */
	readonly required: readonly string[];
	/** A fresh, seeded source and target. */
	stage(): Promise<Pair>;
	/** Options every run of the scenario carries — the realization, say. */
	readonly base?: Partial<CopyMigrationOptions>;
	/** Bring a fresh world to where the crashing run starts. */
	prepare?(world: CrashWorld): Promise<void>;
	/** The run crashes are injected into. */
	readonly crashing: Partial<CopyMigrationOptions>;
	/** What the supervisor asks for on every resume. */
	readonly resuming: Partial<CopyMigrationOptions>;
	/** What the crash-free run must have come to. */
	baseline(world: CrashWorld, result: MigrationRunResult): Promise<void>;
	/** Runs between the crash and the first resume. */
	repair?(world: CrashWorld): Promise<void>;
	settled(
		world: CrashWorld,
		result: MigrationRunResult,
		where: string,
	): Promise<void>;
}

async function fencedAt(binding: EngineBinding): Promise<boolean> {
	// A store the migration has not provisioned yet has nothing to fence, and
	// one without the port cannot be fenced at all.
	if (binding.fence === undefined) return false;
	if (
		(await binding.datasets.describeDataset(CONFORMANCE_DATASET)) === undefined
	) {
		return false;
	}
	const status = await binding.fence.status(scopeOf(CONFORMANCE_DATASET));
	return status.fenced;
}

/**
 * What must hold at every moment, crashed or not: once authority has moved,
 * the two stores are never both taking writes. With authority on the target
 * the source is fenced; back on the source, the target is.
 */
async function expectNeverTwoWriters(
	world: CrashWorld,
	where: string,
): Promise<void> {
	const { pair, authority } = world;
	if (authority.side === "target") {
		expect(
			await fencedAt(pair.source),
			`${where}: authority is on the target and the source is not fenced`,
		);
	} else if (authority.everOnTarget && pair.target.fence !== undefined) {
		expect(
			await fencedAt(pair.target),
			`${where}: authority went back to the source and the target is not fenced`,
		);
	}
}

async function crashWorld(
	scenario: CrashScenario,
	label: string,
): Promise<CrashWorld> {
	const world: CrashWorld = {
		migrationId: `crash-${label}`,
		pair: await scenario.stage(),
		journal: createMemoryMigrationJournal(),
		authority: {
			side: "source",
			everOnTarget: false,
			flips: [],
			applied: new Map(),
		},
	};
	await scenario.prepare?.(world);
	return world;
}

/** One run of the migration; with an injector, every side effect goes through it. */
function attemptRun(
	context: CaseContext,
	world: CrashWorld,
	injector: CrashInjector | undefined,
	extra: Partial<CopyMigrationOptions>,
	run: Partial<MigrationRuntime> = {},
): Promise<MigrationRunResult> {
	const { pair, journal, authority } = world;
	const move = (flip: AuthorityFlip): void => {
		// Compare-and-set on the head the flip was decided at, in the same
		// step that moves authority: a stale flip throws and moves nothing.
		admitAuthorityMove(authority.applied, flip);
		authority.flips.push(flip.direction);
		authority.side = flip.direction === "to-target" ? "target" : "source";
		if (authority.side === "target") authority.everOnTarget = true;
	};
	const through: Pair =
		injector === undefined
			? pair
			: {
					...pair,
					source: crashingBinding(pair.source, "source", injector),
					target: crashingBinding(pair.target, "target", injector),
				};
	return runSnapshotAndTail(
		copyOptions(
			through,
			runtime(
				world.migrationId,
				context.input.now,
				injector === undefined ? journal : crashingJournal(journal, injector),
				run,
			),
			{
				flipAuthority:
					injector === undefined
						? move
						: (flip) =>
								injector.effect(`flip ${flip.direction}`, () => move(flip)),
				...extra,
			},
		),
	);
}

/**
 * Kill the scenario at each of its windows in turn — before the side effect
 * ran, and after it ran but before anyone heard back — and hold every resumed
 * run to one consistent outcome.
 */
async function sweepCrashWindows(
	context: CaseContext,
	scenario: CrashScenario,
): Promise<void> {
	// A crash-free run first: which windows the scenario passes through on
	// this engine, and how often.
	const clean = await crashWorld(scenario, "baseline");
	const tracer = new CrashInjector();
	const crashing = { ...scenario.base, ...scenario.crashing };
	const resuming = { ...scenario.base, ...scenario.resuming };
	const result = await attemptRun(context, clean, tracer, crashing);
	await scenario.baseline(clean, result);
	const counts = tracer.counts();
	for (const effect of scenario.required) {
		expect(
			(counts.get(effect) ?? 0) > 0,
			`${scenario.name}: the run never reached ${effect}, so its crash window is unproven`,
		);
	}
	const modes: readonly CrashMode[] = ["before", "after"];
	let label = 0;
	for (const effect of scenario.windows) {
		const occurrences = counts.get(effect) ?? 0;
		for (let occurrence = 1; occurrence <= occurrences; occurrence += 1) {
			for (const mode of modes) {
				label += 1;
				const point: CrashPoint = { effect, occurrence, mode };
				const where = `${scenario.name}, crash ${mode} ${effect}${occurrences > 1 ? ` #${occurrence}` : ""}`;
				const world = await crashWorld(scenario, String(label));
				const injector = new CrashInjector(point);
				const died = await refuses(async () => {
					await attemptRun(context, world, injector, crashing);
				});
				expect(
					died !== undefined && injector.dead,
					`${where}: the injected crash must surface, and the run must not report a result once the process is dead`,
				);
				await expectNeverTwoWriters(world, `${where}, after the crash`);
				await scenario.repair?.(world);
				// Run until the migration leaves its hold, as a supervisor would.
				let resumed: MigrationRunResult | undefined;
				for (let round = 0; round < 6; round += 1) {
					resumed = await attemptRun(context, world, undefined, resuming);
					await expectNeverTwoWriters(world, `${where}, resume ${round}`);
					if (resumed.status !== "held") break;
				}
				expect(
					resumed !== undefined && resumed.status !== "held",
					`${where}: still held after six resumes: ${resumed?.reason ?? ""}`,
				);
				await scenario.settled(world, resumed, where);
			}
		}
	}
}

/** The forward path ended: the target is the only writer, the source retired. */
async function expectCutOverCompleted(
	world: CrashWorld,
	result: MigrationRunResult,
	where: string,
	rows: number,
): Promise<void> {
	const { pair, authority, journal, migrationId } = world;
	expect(
		result.status === "completed",
		`${where}: the resumed run must complete, got ${result.status}: ${result.reason ?? ""}`,
	);
	expect(
		authority.side === "target" &&
			authority.flips.every((direction) => direction === "to-target"),
		`${where}: write authority must end on the target and never go back, flips were ${authority.flips.join(",")}`,
	);
	expect(
		(await countIn(pair.target)) === rows,
		`${where}: the target must hold every record, once`,
	);
	expect(
		(await countIn(pair.source)) === 0,
		`${where}: a completed migration retires the source`,
	);
	expect(
		await fencedAt(pair.source),
		`${where}: the retired source must stay fenced`,
	);
	expect(
		!(await fencedAt(pair.target)),
		`${where}: the new authority must be writable`,
	);
	const facts = await journal.load(migrationId);
	const times = (type: string): number =>
		facts.filter((fact) => fact.type === type).length;
	expect(
		times(MIGRATION_EVENTS.CutOver) === 1 &&
			times(MIGRATION_EVENTS.Completed) === 1,
		`${where}: the cutover is decided once and the run completes once`,
	);
}

// ── cases ───────────────────────────────────────────────────────────────────

const CASES: readonly ConformanceCase[] = Object.freeze([
	{
		id: "declaration.matches-binding",
		requires: [],
		async run(context) {
			assertBindingMatchesDeclaration(await context.open("a"));
		},
	},
	{
		id: "datasets.ensure-idempotent",
		requires: ["datasets"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			const first = await binding.datasets.ensureDataset(schema);
			const second = await binding.datasets.ensureDataset(schema);
			expect(first.created, "the first ensureDataset must report created");
			expect(!second.created, "a second ensureDataset must be a no-op");
			const described = await binding.datasets.describeDataset(schema.name);
			expect(
				described !== undefined &&
					schemaDigest(described) === schemaDigest(schema),
				"describeDataset must return the schema that was ensured",
			);
			expect(
				(await binding.datasets.describeDataset("hobo_conformance_absent")) ===
					undefined,
				"an absent dataset describes as undefined",
			);
		},
	},
	{
		id: "records.round-trip-canonical",
		requires: ["records"],
		dependsOn: ["datasets.ensure-idempotent"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const mutation = upsert(schema, "", "order-1");
			await write(binding, [mutation]);
			const read = await binding.records.read({
				dataset: schema.name,
				tenant: "",
				key: mutation.key,
			});
			expect(read !== undefined, "a written record must be readable");
			expect(
				canonicalEncode(read) === canonicalEncode(mutation.record ?? null),
				"a record must read back in the same canonical form it was written in",
			);
			await write(binding, [deleteMutation("", mutation.key)]);
			expect(
				(await binding.records.read({
					dataset: schema.name,
					tenant: "",
					key: mutation.key,
				})) === undefined,
				"a deleted record must read as undefined",
			);
		},
	},
	{
		id: "records.tenants-are-isolated",
		requires: ["records"],
		dependsOn: ["records.round-trip-canonical"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			await write(binding, [
				upsert(schema, "tenant-a", "order-1", { qty: "1" }),
				upsert(schema, "tenant-b", "order-1", { qty: "2" }),
			]);
			const key = keyOf(schema, "order-1");
			const a = await binding.records.read({
				dataset: schema.name,
				tenant: "tenant-a",
				key,
			});
			const b = await binding.records.read({
				dataset: schema.name,
				tenant: "tenant-b",
				key,
			});
			expect(
				a?.qty === "1" && b?.qty === "2",
				"the same key in two tenants is two records",
			);
		},
	},
	{
		id: "mapping.constrained-never-silent",
		requires: ["records"],
		dependsOn: ["records.round-trip-canonical"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			// Values at the edge of what an engine may store. Each must either
			// round-trip exactly or be refused; storing it altered is the failure.
			const probes: readonly JsonObject[] = [
				{ placed_at: "2026-01-02T03:04:05.678901Z" },
				{ price: "1234567890123456789012345678901234567890.123456789" },
				{ qty: "-9223372036854775808" },
				{ weight: 1.7976931348623157e308 },
				// U+0000 in text, and JSON keys some engines reserve.
				{ note: "nul \u0000 inside" },
				{ attrs: { $reserved: 1, "dotted.key": 2 } },
			];
			for (const [index, probe] of probes.entries()) {
				const field = Object.keys(probe)[0] ?? "";
				if (!schema.fields.some((entry) => entry.name === field)) continue;
				const mutation = upsert(schema, "", `probe-${index}`, probe);
				const refused = await refuses(() => write(binding, [mutation]));
				if (refused !== undefined) continue;
				const read = await binding.records.read({
					dataset: schema.name,
					tenant: "",
					key: mutation.key,
				});
				expect(
					read !== undefined &&
						canonicalEncode(read) === canonicalEncode(mutation.record ?? null),
					`${field} was stored altered instead of being refused`,
				);
			}
		},
	},
	{
		id: "mapping.early-years-never-unreadable",
		requires: ["records"],
		dependsOn: ["records.round-trip-canonical"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			// Years before 0100 are where engines and their drivers disagree
			// (two-digit-year rules, a missing year zero). Each value must
			// round-trip exactly or be refused when it is written. What may
			// never happen is the third thing: accepted on write, and then
			// every read of the dataset fails.
			const probes: readonly JsonObject[] = [
				{ placed_at: "0001-01-01T00:00:00Z" },
				{ placed_at: "0099-12-31T23:59:59.999999Z" },
				{ placed_at: "0000-06-15T12:00:00Z" },
				{ due: "0001-01-01" },
				{ due: "0099-12-31" },
				{ due: "0000-03-01" },
			];
			const scope = scopeOf(schema.name);
			for (const [index, probe] of probes.entries()) {
				const field = Object.keys(probe)[0] ?? "";
				if (!schema.fields.some((entry) => entry.name === field)) continue;
				const mutation = upsert(schema, "", `early-${index}`, probe);
				const refused = await refuses(() => write(binding, [mutation]));
				if (refused !== undefined) continue;
				const unreadable = await refuses(async () => {
					const read = await binding.records.read({
						dataset: schema.name,
						tenant: "",
						key: mutation.key,
					});
					expect(
						read !== undefined &&
							canonicalEncode(read) ===
								canonicalEncode(mutation.record ?? null),
						`${field} ${String(probe[field])} was stored altered instead of being refused`,
					);
					await binding.verify?.digest({ scope, buckets: 4 });
					const cursor = await binding.snapshot?.openSnapshot({
						scope,
						chunkSize: 50,
					});
					if (cursor !== undefined) {
						try {
							for (;;) if ((await cursor.next()) === undefined) break;
						} finally {
							await cursor.close();
						}
					}
				});
				if (unreadable instanceof Expectation) throw unreadable;
				expect(
					unreadable === undefined,
					`${field} ${String(probe[field])} was accepted on write and then made the dataset unreadable`,
				);
			}
		},
	},
	{
		id: "records.open-fields-round-trip",
		requires: ["records"],
		dependsOn: ["records.round-trip-canonical"],
		async run(context) {
			const binding = await context.open("a");
			const schema = parseDatasetSchema({
				name: CONFORMANCE_OPEN_DATASET,
				version: 1,
				open: true,
				keyFields: ["id"],
				fields: [{ name: "id", type: "string", nullable: false }],
			});
			// An engine may refuse an open schema outright. What it may not do
			// is accept one and then lose a field.
			const unsupported = await refuses(async () => {
				await binding.datasets.ensureDataset(schema);
			});
			if (unsupported !== undefined) return;
			// Undeclared fields whose names are also names on every object. A
			// store that collects fields by assignment silently drops
			// `__proto__`; built from entries here so the field is really there.
			const record = parseCanonicalRecord(
				schema,
				Object.fromEntries([
					["id", "open-1"],
					["__proto__", { nested: [1, "two"] }],
					["constructor", "c"],
					["toString", 5],
					["extra", { a: null }],
				]),
			);
			expect(
				Object.hasOwn(record, "__proto__"),
				"the kit's own record must carry the field it probes with",
			);
			const key = encodeRecordKey(schema, record);
			const refused = await refuses(async () => {
				await binding.records.write({
					dataset: schema.name,
					mutations: [upsertMutation("", key, record)],
				});
			});
			if (refused !== undefined) return;
			const read = await binding.records.read({
				dataset: schema.name,
				tenant: "",
				key,
			});
			expect(
				read !== undefined && Object.hasOwn(read, "__proto__"),
				"an undeclared field named __proto__ was dropped",
			);
			expect(
				canonicalEncode(read) === canonicalEncode(record),
				"an open-schema record must read back with every undeclared field intact",
			);
			if (binding.verify !== undefined) {
				const expected = new DatasetDigestBuilder(schema.name, "", 4);
				expected.add("", key, record);
				const digest = await binding.verify.digest({
					scope: scopeOf(schema.name),
					buckets: 4,
				});
				expect(
					compareDigests(expected.finish(), digest).equal,
					"the digest of an open-schema record must cover its undeclared fields",
				);
			}
		},
	},
	{
		id: "records.key-must-match-record",
		requires: ["records"],
		dependsOn: ["records.round-trip-canonical"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			// A mutation that names one key and carries another key's record.
			// Wherever an engine put it, some other engine would look for it
			// somewhere else; the only portable answer is to refuse it.
			const claimed = keyOf(schema, "order-claimed");
			const carried = recordFor(schema, "order-carried");
			const refused = await refuses(async () => {
				await binding.records.write({
					dataset: schema.name,
					mutations: [upsertMutation("", claimed, carried)],
				});
			});
			expect(
				refused !== undefined,
				"a write whose key disagrees with its record's key must be refused",
			);
			for (const key of [claimed, encodeRecordKey(schema, carried)]) {
				expect(
					(await binding.records.read({
						dataset: schema.name,
						tenant: "",
						key,
					})) === undefined,
					"a refused write must leave nothing behind, under either key",
				);
			}
		},
	},
	{
		id: "datasets.metadata-names-refused-or-harmless",
		requires: ["datasets", "records"],
		dependsOn: ["records.round-trip-canonical"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			await write(binding, [upsert(schema, "", "before", { qty: "1" })]);
			const names = [
				...new Set([
					...KNOWN_METADATA_NAMES,
					...(context.input.engine.reservedDatasetNames ?? []),
				]),
			];
			for (const name of names) {
				const squat = parseDatasetSchema({
					name,
					version: 1,
					keyFields: ["id"],
					fields: [
						{ name: "id", type: "string", nullable: false },
						{ name: "note", type: "string", nullable: true },
					],
				});
				const refused = await refuses(async () => {
					await binding.datasets.ensureDataset(squat);
				});
				if (refused !== undefined) continue;
				// Accepted: then it has to be an ordinary dataset.
				const record = parseCanonicalRecord(squat, { id: "s-1", note: "n" });
				const key = encodeRecordKey(squat, record);
				await binding.records.write({
					dataset: name,
					mutations: [upsertMutation("", key, record)],
				});
				const read = await binding.records.read({
					dataset: name,
					tenant: "",
					key,
				});
				expect(
					read !== undefined &&
						canonicalEncode(read) === canonicalEncode(record),
					`a dataset named ${name} was accepted but does not behave as a dataset`,
				);
			}
			// Whatever was accepted, the engine's own bookkeeping must still
			// work: every port that leans on it is exercised once more.
			const described = await binding.datasets.describeDataset(schema.name);
			expect(
				described !== undefined &&
					schemaDigest(described) === schemaDigest(schema),
				"the dataset registry must survive a dataset named after it",
			);
			const scope = scopeOf(schema.name);
			const start = await binding.capture?.start({
				scope,
				subscription: "sub_meta",
			});
			await write(binding, [upsert(schema, "", "after", { qty: "2" })]);
			if (binding.capture !== undefined && start !== undefined) {
				const batch = await binding.capture.read({
					scope,
					subscription: "sub_meta",
					after: start,
					limit: 10,
				});
				expect(
					batch.changes.length === 1,
					"capture must still see a write after a dataset was named after engine metadata",
				);
				await binding.capture.stop("sub_meta");
			}
			if (binding.apply !== undefined) {
				await binding.apply.apply({
					dataset: schema.name,
					changes: [upsert(schema, "", "applied", { qty: "3" })],
					source: "meta",
					position: "7",
				});
				expect(
					(await binding.apply.watermark({
						dataset: schema.name,
						source: "meta",
					})) === "7",
					"watermarks must survive a dataset named after engine metadata",
				);
			}
			if (binding.fence !== undefined) {
				const grant = await binding.fence.raise({ scope, reason: "meta" });
				const fenced = await refuses(() =>
					write(binding, [upsert(schema, "", "fenced")]),
				);
				expect(
					fenced instanceof FencedWriteError,
					"the fence must still hold after a dataset was named after engine metadata",
				);
				await binding.fence.release({ scope, fenceToken: grant.fenceToken });
			}
			const kept = await binding.records.read({
				dataset: schema.name,
				tenant: "",
				key: keyOf(schema, "before"),
			});
			expect(kept?.qty === "1", "records written before must still be there");
		},
	},
	{
		id: "apply.idempotent-with-watermark",
		requires: ["apply", "verify"],
		dependsOn: ["records.round-trip-canonical"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const apply = requirePort(binding, "apply");
			const verify = requirePort(binding, "verify");
			const changes = [
				upsert(schema, "", "order-1", { qty: "1" }),
				upsert(schema, "", "order-2", { qty: "2" }),
				upsert(schema, "", "order-1", { qty: "3" }),
				deleteMutation("", keyOf(schema, "order-2")),
			];
			const scope = scopeOf(schema.name);
			expect(
				(await apply.watermark({ dataset: schema.name, source: "s" })) ===
					undefined,
				"a source with no applied batch has no watermark",
			);
			await apply.apply({
				dataset: schema.name,
				changes,
				source: "s",
				position: "41",
			});
			const once = await verify.digest({ scope, buckets: 8 });
			await apply.apply({
				dataset: schema.name,
				changes,
				source: "s",
				position: "41",
			});
			const twice = await verify.digest({ scope, buckets: 8 });
			expect(once.count === 1, "the batch leaves exactly one record");
			expect(
				compareDigests(once, twice).equal,
				"re-applying a batch must change nothing",
			);
			expect(
				(await apply.watermark({ dataset: schema.name, source: "s" })) === "41",
				"apply must record the batch position as the watermark",
			);
			await apply.apply({
				dataset: schema.name,
				changes: [],
				source: "s",
				position: "57",
			});
			expect(
				(await apply.watermark({ dataset: schema.name, source: "s" })) === "57",
				"an empty batch still advances the watermark",
			);
		},
	},
	{
		// A conditional apply is how a migration keeps a driver that has been
		// superseded from writing over its successor: it names the watermark it
		// believes is current, and the store refuses the batch when it is not.
		id: "apply.stale-watermark-is-refused",
		requires: ["apply"],
		dependsOn: ["apply.idempotent-with-watermark"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const apply = requirePort(binding, "apply");
			const dataset = schema.name;
			const watermark = () => apply.watermark({ dataset, source: "s" });
			const qty = async (id: string) =>
				(
					await binding.records.read({
						dataset,
						tenant: "",
						key: keyOf(schema, id),
					})
				)?.qty;
			await apply.apply({
				dataset,
				changes: [upsert(schema, "", "order-1", { qty: "1" })],
				source: "s",
				position: "10",
				expectedWatermark: null,
			});
			expect(
				(await watermark()) === "10" && (await qty("order-1")) === "1",
				"a first batch that expects no watermark lands",
			);
			const second = await refuses(async () => {
				await apply.apply({
					dataset,
					changes: [
						upsert(schema, "", "order-1", { qty: "9" }),
						upsert(schema, "", "order-late", { qty: "9" }),
					],
					source: "s",
					position: "11",
					expectedWatermark: null,
				});
			});
			expect(
				second instanceof StaleApplyError,
				"a batch that expects no watermark where one is recorded must be refused with StaleApplyError",
			);
			expect(
				(await qty("order-1")) === "1" &&
					(await qty("order-late")) === undefined,
				"nothing of a refused batch may land",
			);
			expect(
				(await watermark()) === "10",
				"a refused batch must not move the watermark",
			);
			await apply.apply({
				dataset,
				changes: [upsert(schema, "", "order-1", { qty: "2" })],
				source: "s",
				position: "20",
				expectedWatermark: "10",
			});
			expect(
				(await watermark()) === "20" && (await qty("order-1")) === "2",
				"a batch that names the recorded watermark lands and advances it",
			);
			// The stale driver: it still holds a batch read after "10".
			const stale = await refuses(async () => {
				await apply.apply({
					dataset,
					changes: [
						upsert(schema, "", "order-1", { qty: "7" }),
						deleteMutation("", keyOf(schema, "order-1")),
						upsert(schema, "", "order-late", { qty: "7" }),
					],
					source: "s",
					position: "15",
					expectedWatermark: "10",
				});
			});
			expect(
				stale instanceof StaleApplyError,
				"a batch that names a watermark the store has moved past must be refused with StaleApplyError",
			);
			expect(
				(await qty("order-1")) === "2" &&
					(await qty("order-late")) === undefined &&
					(await watermark()) === "20",
				"a stale batch changes neither a record nor the watermark",
			);
			const empty = await refuses(async () => {
				await apply.apply({
					dataset,
					changes: [],
					source: "s",
					position: "30",
					expectedWatermark: "10",
				});
			});
			expect(
				empty instanceof StaleApplyError && (await watermark()) === "20",
				"an empty stale batch is refused too: it would move the watermark",
			);
			// Two appliers that both name the current watermark: one lands.
			const racers = await Promise.allSettled(
				["a", "b"].map(async (id) => {
					await apply.apply({
						dataset,
						changes: [upsert(schema, "", `order-${id}`, { qty: "5" })],
						source: "s",
						position: `50-${id}`,
						expectedWatermark: "20",
					});
					return id;
				}),
			);
			const landed = racers.flatMap((racer) =>
				racer.status === "fulfilled" ? [racer.value] : [],
			);
			expect(
				landed.length === 1 &&
					racers.every(
						(racer) =>
							racer.status === "fulfilled" ||
							racer.reason instanceof StaleApplyError,
					),
				"of two appliers naming the same watermark exactly one lands, and the other is refused with StaleApplyError",
			);
			const winner = landed[0] ?? "";
			const loser = winner === "a" ? "b" : "a";
			expect(
				(await watermark()) === `50-${winner}` &&
					(await qty(`order-${winner}`)) === "5" &&
					(await qty(`order-${loser}`)) === undefined,
				"the watermark and the records are the winner's, and only the winner's",
			);
			// Watermarks are per source, and an apply that names none is
			// unconditional, as it always was.
			await apply.apply({
				dataset,
				changes: [],
				source: "t",
				position: "1",
				expectedWatermark: null,
			});
			await apply.apply({
				dataset,
				changes: [upsert(schema, "", "order-1", { qty: "3" })],
				source: "s",
				position: "60",
			});
			expect(
				(await watermark()) === "60" && (await qty("order-1")) === "3",
				"an apply that names no watermark is unconditional",
			);
		},
	},
	{
		id: "verify.digest-is-engine-independent",
		requires: ["verify"],
		dependsOn: ["records.round-trip-canonical"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const expected = new DatasetDigestBuilder(schema.name, "", 8);
			const mutations: RecordMutation[] = [];
			for (let index = 0; index < 25; index += 1) {
				const tenant = index % 2 === 0 ? "tenant-a" : "tenant-b";
				const mutation = upsert(schema, tenant, `order-${index}`, {
					qty: String(index),
				});
				mutations.push(mutation);
				if (mutation.record !== undefined)
					expected.add(tenant, mutation.key, mutation.record);
			}
			await write(binding, mutations);
			const digest = await requirePort(binding, "verify").digest({
				scope: scopeOf(schema.name),
				buckets: 8,
			});
			expect(
				compareDigests(expected.finish(), digest).equal,
				"the engine's digest must equal the canonical digest of the same records",
			);
			const scoped = await requirePort(binding, "verify").digest({
				scope: scopeOf(schema.name, "tenant-a"),
				buckets: 8,
			});
			expect(
				scoped.count === 13,
				"a tenant-scoped digest counts only that tenant",
			);
			expect(
				!JSON.stringify(digest).includes(PAYLOAD_SENTINEL),
				"a digest must carry no record payload",
			);
		},
	},
	{
		id: "snapshot.returns-the-scope",
		requires: ["snapshot"],
		dependsOn: ["records.round-trip-canonical"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const mutations: RecordMutation[] = [];
			for (let index = 0; index < 23; index += 1) {
				mutations.push(
					upsert(
						schema,
						index < 20 ? "tenant-a" : "tenant-b",
						`order-${index}`,
					),
				);
			}
			await write(binding, mutations);
			const cursor = await requirePort(binding, "snapshot").openSnapshot({
				scope: scopeOf(schema.name, "tenant-a"),
				chunkSize: 6,
			});
			const seen = new Set<string>();
			let chunks = 0;
			for (;;) {
				const chunk = await cursor.next();
				if (chunk === undefined) break;
				chunks += 1;
				for (const mutation of chunk) {
					expect(mutation.op === "upsert", "a snapshot yields upserts");
					expect(
						mutation.tenant === "tenant-a",
						"a scoped snapshot stays in its tenant",
					);
					seen.add(mutation.key);
				}
			}
			await cursor.close();
			expect(
				seen.size === 20,
				"a snapshot returns every record in scope exactly once",
			);
			expect(chunks >= 4, "a snapshot honours its chunk size");
		},
	},
	{
		id: "capture.ordered-and-resumable",
		requires: ["capture"],
		dependsOn: ["records.round-trip-canonical"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const capture = requirePort(binding, "capture");
			const scope = scopeOf(schema.name);
			await write(binding, [upsert(schema, "", "before", { qty: "0" })]);
			const start = await capture.start({ scope, subscription: "sub_a" });
			await write(binding, [upsert(schema, "", "order-1", { qty: "1" })]);
			await write(binding, [upsert(schema, "", "order-1", { qty: "2" })]);
			await write(binding, [deleteMutation("", keyOf(schema, "order-1"))]);
			await write(binding, [upsert(schema, "", "order-2", { qty: "3" })]);
			expect(
				(await capture.start({ scope, subscription: "sub_a" })) === start,
				"starting an existing subscription returns its original position",
			);
			const first = await capture.read({
				scope,
				subscription: "sub_a",
				after: start,
				limit: 2,
			});
			expect(first.changes.length === 2, "read honours its limit");
			expect(!first.caughtUp, "a partial read is not caught up");
			const rest = await capture.read({
				scope,
				subscription: "sub_a",
				after: first.position,
				limit: 10,
			});
			expect(rest.caughtUp, "reading to the end is caught up");
			const all = [...first.changes, ...rest.changes];
			expect(
				all.every((change) => change.key !== keyOf(schema, "before")),
				"changes before the subscription started are not captured",
			);
			const ops = all.map(
				(change) => `${change.op}:${change.record?.qty ?? "-"}`,
			);
			expect(
				ops.join(",") === "upsert:1,upsert:2,delete:-,upsert:3",
				`changes must arrive in commit order, got ${ops.join(",")}`,
			);
			const again = await capture.read({
				scope,
				subscription: "sub_a",
				after: start,
				limit: 10,
			});
			expect(
				again.changes.length === 4,
				"read does not consume; an unacknowledged read repeats",
			);
			await capture.acknowledge({
				subscription: "sub_a",
				position: rest.position,
			});
			const empty = await capture.read({
				scope,
				subscription: "sub_a",
				after: rest.position,
				limit: 10,
			});
			expect(
				empty.changes.length === 0 && empty.caughtUp,
				"nothing remains after the head",
			);
			await capture.stop("sub_a");
		},
	},
	{
		id: "capture.tenant-scope",
		requires: ["capture"],
		dependsOn: ["capture.ordered-and-resumable"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const capture = requirePort(binding, "capture");
			const scope = scopeOf(schema.name, "tenant-a");
			const start = await capture.start({ scope, subscription: "sub_t" });
			await write(binding, [
				upsert(schema, "tenant-a", "order-1"),
				upsert(schema, "tenant-b", "order-2"),
				upsert(schema, "tenant-a", "order-3"),
			]);
			const batch = await capture.read({
				scope,
				subscription: "sub_t",
				after: start,
				limit: 10,
			});
			expect(
				batch.changes.length === 2 &&
					batch.changes.every((change) => change.tenant === "tenant-a"),
				"a tenant-scoped capture returns only that tenant's changes",
			);
			await capture.stop("sub_t");
		},
	},
	{
		id: "capture.large-key-update",
		requires: ["capture"],
		dependsOn: ["capture.ordered-and-resumable"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const capture = requirePort(binding, "capture");
			const scope = scopeOf(schema.name);
			const start = await capture.start({ scope, subscription: "sub_k" });
			// A key long enough that an engine stores it out of line. An update
			// that leaves such a key alone is where a log may send a placeholder
			// in the new row and the value only in the old one.
			const key = keyOf(schema, LARGE_KEY);
			const refused = await refuses(() =>
				write(binding, [upsert(schema, "", LARGE_KEY, { qty: "1" })]),
			);
			// An engine may bound its key length, loudly. Then there is nothing
			// to capture and nothing was stored.
			if (refused !== undefined) {
				await capture.stop("sub_k");
				return;
			}
			await write(binding, [upsert(schema, "", LARGE_KEY, { qty: "2" })]);
			await write(binding, [deleteMutation("", key)]);
			const batch = await capture.read({
				scope,
				subscription: "sub_k",
				after: start,
				limit: 10,
			});
			const seen = batch.changes.map(
				(change) =>
					`${change.op}:${change.record?.qty ?? "-"}:${change.key === key}`,
			);
			expect(
				seen.join(",") === "upsert:1:true,upsert:2:true,delete:-:true",
				`an update of a record with a large key must be captured under that key, got ${seen.join(",")}`,
			);
			await capture.stop("sub_k");
		},
	},
	{
		id: "capture.invalid-position-is-an-error",
		requires: ["capture"],
		dependsOn: ["capture.ordered-and-resumable"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const capture = requirePort(binding, "capture");
			const scope = scopeOf(schema.name);
			await capture.start({ scope, subscription: "sub_g" });
			await write(binding, [upsert(schema, "", "order-1")]);
			// A position this engine never minted. Answering it with an empty,
			// caught-up batch would tell a tail it had finished when it had
			// read nothing.
			const refused = await refuses(async () => {
				await capture.read({
					scope,
					subscription: "sub_g",
					after: GARBAGE_POSITION,
					limit: 10,
				});
			});
			expect(
				refused !== undefined,
				"reading capture from a position the engine never minted must be an error, not an empty batch",
			);
			await capture.stop("sub_g");
		},
	},
	{
		id: "fence.single-write-authority",
		requires: ["fence"],
		dependsOn: ["records.round-trip-canonical"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const fence = requirePort(binding, "fence");
			const scope = scopeOf(schema.name, "tenant-a");
			const grant = await fence.raise({ scope, reason: "conformance" });
			const again = await fence.raise({ scope, reason: "conformance" });
			expect(
				grant.fenceToken === again.fenceToken,
				"raising a raised fence returns its token",
			);
			expect((await fence.status(scope)).fenced, "status reports the fence");
			const refused = await refuses(() =>
				write(binding, [upsert(schema, "tenant-a", "order-1")]),
			);
			expect(
				refused instanceof FencedWriteError,
				"a write to a fenced scope must be refused with FencedWriteError",
			);
			await write(binding, [upsert(schema, "tenant-b", "order-2")]);
			await write(
				binding,
				[upsert(schema, "tenant-a", "order-3")],
				grant.fenceToken,
			);
			const wrong = await refuses(() =>
				fence.release({ scope, fenceToken: `${grant.fenceToken}-not` }),
			);
			expect(wrong !== undefined, "only the token holder may release a fence");
			await fence.release({ scope, fenceToken: grant.fenceToken });
			expect(!(await fence.status(scope)).fenced, "a released fence is gone");
			await write(binding, [upsert(schema, "tenant-a", "order-4")]);
		},
	},
	{
		id: "fence.raise-waits-for-in-flight-writes",
		requires: ["fence", "verify"],
		dependsOn: ["fence.single-write-authority"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const scope = scopeOf(schema.name);
			// Writes are in flight when the fence is raised. Each must either
			// land before `raise` returns or be refused — none may land after.
			// Each outcome is captured as it settles — the error a refused write
			// threw, or nothing — so a refusal is never an unhandled rejection.
			const writes = Array.from({ length: 24 }, (_, index) =>
				refuses(() => write(binding, [upsert(schema, "", `racing-${index}`)])),
			);
			const grant = await requirePort(binding, "fence").raise({
				scope,
				reason: "conformance",
			});
			const verify = requirePort(binding, "verify");
			const atRaise = await verify.digest({ scope, buckets: 8 });
			const outcomes = await Promise.all(writes);
			const landed = outcomes.filter((outcome) => outcome === undefined).length;
			for (const outcome of outcomes) {
				expect(
					outcome === undefined || outcome instanceof FencedWriteError,
					"a write racing the fence either lands or is refused with FencedWriteError",
				);
			}
			const afterwards = await verify.digest({ scope, buckets: 8 });
			expect(
				compareDigests(atRaise, afterwards).equal,
				"no write may land after raise has returned",
			);
			expect(
				afterwards.count === landed,
				"every write reported as accepted is present, and no refused write is",
			);
			await requirePort(binding, "fence").release({
				scope,
				fenceToken: grant.fenceToken,
			});
		},
	},
	{
		id: "retire.refused-unless-proven",
		requires: ["retire", "fence", "verify"],
		dependsOn: [
			"fence.single-write-authority",
			"verify.digest-is-engine-independent",
		],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			await write(binding, [
				upsert(schema, "tenant-a", "order-1"),
				upsert(schema, "tenant-a", "order-2"),
				upsert(schema, "tenant-b", "order-3"),
			]);
			const scope = scopeOf(schema.name, "tenant-a");
			const retire = requirePort(binding, "retire");
			const verify = requirePort(binding, "verify");
			const digest = await verify.digest({ scope, buckets: 8 });
			const unfenced = await refuses(async () => {
				await retire.retire({ scope, fenceToken: "none", expected: digest });
			});
			expect(
				unfenced !== undefined,
				"retire without a raised fence must be refused",
			);
			const grant = await requirePort(binding, "fence").raise({
				scope,
				reason: "conformance",
			});
			await write(
				binding,
				[upsert(schema, "tenant-a", "order-9")],
				grant.fenceToken,
			);
			const stale = await refuses(async () => {
				await retire.retire({
					scope,
					fenceToken: grant.fenceToken,
					expected: digest,
				});
			});
			expect(stale !== undefined, "retire with a stale digest must be refused");
			const fresh = await verify.digest({ scope, buckets: 8 });
			const receipt = await retire.retire({
				scope,
				fenceToken: grant.fenceToken,
				expected: fresh,
			});
			expect(receipt.removed === 3, "retire removes exactly the scope");
			const remaining = await verify.digest({
				scope: scopeOf(schema.name),
				buckets: 8,
			});
			expect(
				remaining.count === 1,
				"another tenant's records survive a scoped retire",
			);
		},
	},
	{
		// A null and an empty value are different values. An engine that stores
		// one as the other moves data that digests equal on both sides and is
		// still not the data that was written.
		id: "records.null-and-empty-are-distinct",
		requires: ["records"],
		dependsOn: ["records.round-trip-canonical"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const scope = scopeOf(schema.name);
			const start = await binding.capture?.start({
				scope,
				subscription: "sub_v",
			});
			// Each probe names the fields it sets; a field the engine cannot
			// carry is not in the schema and is left out.
			const probes: readonly (readonly [string, JsonObject])[] = [
				["null", { note: null, card: null }],
				["empty-text", { note: "" }],
				["empty-bytes", { blob: "" }],
				["empty-object", { attrs: {} }],
				["empty-array", { attrs: [] }],
				["nested-empties", { attrs: { a: {}, b: [], c: "", d: null } }],
				[
					"zeroes",
					{ qty: "0", price: "0", weight: 0, active: false, note: "0" },
				],
			];
			const written: RecordMutation[] = [];
			for (const [id, probe] of probes) {
				const mutation = upsert(schema, "", `value-${id}`, probe);
				written.push(mutation);
				await write(binding, [mutation]);
			}
			// One record taken through each value in turn: an engine that keeps
			// the old value when the new one is null or empty shows up here.
			const turns: readonly JsonObject[] = [
				{ note: null, attrs: {}, blob: "" },
				{ note: "", attrs: [], blob: "AA==" },
				{ note: null, attrs: {}, blob: "" },
			];
			for (const turn of turns) {
				const mutation = upsert(schema, "", "value-turning", turn);
				await write(binding, [mutation]);
				const read = await binding.records.read({
					dataset: schema.name,
					tenant: "",
					key: mutation.key,
				});
				expect(
					read !== undefined &&
						canonicalEncode(read) === canonicalEncode(mutation.record ?? null),
					`an update to ${canonicalEncode(turn)} must replace the value that was there`,
				);
			}
			written.push(upsert(schema, "", "value-turning", turns[2] ?? {}));
			const expected = new DatasetDigestBuilder(schema.name, "", 8);
			for (const mutation of written) {
				const read = await binding.records.read({
					dataset: schema.name,
					tenant: "",
					key: mutation.key,
				});
				const id = mutation.record?.id ?? "";
				expect(
					read !== undefined,
					`${String(id)} was written and must be readable`,
				);
				expect(
					canonicalEncode(read) === canonicalEncode(mutation.record ?? null),
					`${String(id)} must read back as written: null stays null, empty stays empty, {} stays {} and [] stays []`,
				);
				if (mutation.record !== undefined) {
					expected.add("", mutation.key, mutation.record);
				}
			}
			const want = new Map(
				written.map((mutation) => [
					mutation.key,
					canonicalEncode(mutation.record ?? null),
				]),
			);
			if (binding.verify !== undefined) {
				expect(
					compareDigests(
						expected.finish(),
						await binding.verify.digest({ scope, buckets: 8 }),
					).equal,
					"the digest must tell a null from an empty value, as the canonical digest does",
				);
			}
			if (binding.snapshot !== undefined) {
				const cursor = await binding.snapshot.openSnapshot({
					scope,
					chunkSize: 4,
				});
				let seen = 0;
				try {
					for (;;) {
						const chunk = await cursor.next();
						if (chunk === undefined) break;
						for (const mutation of chunk) {
							seen += 1;
							expect(
								canonicalEncode(mutation.record ?? null) ===
									want.get(mutation.key),
								"a snapshot must carry null and empty values as they were written",
							);
						}
					}
				} finally {
					await cursor.close();
				}
				expect(seen === want.size, "a snapshot returns every probe record");
			}
			if (binding.capture !== undefined && start !== undefined) {
				const latest = new Map<string, string>();
				let after = start;
				for (let round = 0; round < 50; round += 1) {
					const batch = await binding.capture.read({
						scope,
						subscription: "sub_v",
						after,
						limit: 50,
					});
					for (const change of batch.changes) {
						latest.set(change.key, canonicalEncode(change.record ?? null));
					}
					after = batch.position;
					if (batch.caughtUp) break;
				}
				for (const [key, record] of want) {
					expect(
						latest.get(key) === record,
						"capture must carry null and empty values as they were written",
					);
				}
				await binding.capture.stop("sub_v");
			}
			if (binding.apply !== undefined) {
				// The same records arriving through `apply`, on a second store.
				const replica = await context.open("replica");
				await replica.datasets.ensureDataset(schema);
				await requirePort(replica, "apply").apply({
					dataset: schema.name,
					changes: written,
					source: "values",
					position: "1",
				});
				for (const mutation of written) {
					const read = await replica.records.read({
						dataset: schema.name,
						tenant: "",
						key: mutation.key,
					});
					expect(
						read !== undefined &&
							canonicalEncode(read) === want.get(mutation.key),
						"apply must store null and empty values as they arrived",
					);
				}
			}
		},
	},
	{
		// One spelling per key. A key that reaches a store in any other
		// spelling is either refused or lands on the same one row; a delete,
		// which names a key and nothing else, is refused.
		id: "records.keys-are-canonical",
		requires: ["records"],
		dependsOn: ["records.key-must-match-record"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const scope = scopeOf(schema.name);
			await write(binding, [upsert(schema, "", "order-1", { qty: "1" })]);
			const canonical = keyOf(schema, "order-1");
			// The same key value, spelled as no canonical encoder spells it.
			const spellings = [
				`[ ${JSON.stringify("order-1")} ]`,
				JSON.stringify("order-1"),
				`${canonical} `,
			];
			for (const spelling of spellings) {
				const refused = await refuses(() =>
					write(binding, [deleteMutation("", spelling)]),
				);
				expect(
					refused !== undefined,
					"a delete that names a key in a non-canonical spelling must be refused",
				);
				const upserted = await refuses(() =>
					write(binding, [
						upsertMutation(
							"",
							spelling,
							recordFor(schema, "order-1", { qty: "2" }),
						),
					]),
				);
				if (upserted === undefined) {
					// Accepted: then it landed on the one row, under its key.
					expect(
						(await recordOf(binding, schema, "", "order-1"))?.qty === "2",
						"an upsert under a non-canonical key spelling must land on the canonical key",
					);
					await write(binding, [upsert(schema, "", "order-1", { qty: "1" })]);
				}
			}
			expect(
				(await recordOf(binding, schema, "", "order-1"))?.qty === "1",
				"a refused delete must leave the record where it was",
			);
			if (binding.verify !== undefined) {
				expect(
					(await binding.verify.digest({ scope, buckets: 4 })).count === 1,
					"key spellings must never make a second row",
				);
			}
			// A uuid key: the uppercase spelling names the same record.
			const carriesUuid = schema.fields.some((field) => field.type === "uuid");
			if (!carriesUuid) return;
			const refs = parseDatasetSchema({
				name: CONFORMANCE_REFS_DATASET,
				version: 1,
				keyFields: ["ref"],
				fields: [
					{ name: "ref", type: "uuid", nullable: false },
					{ name: "note", type: "string", nullable: true },
				],
			});
			await binding.datasets.ensureDataset(refs);
			const upper = "0F8FAD5B-D9CB-469F-A165-70867728950E";
			const record = parseCanonicalRecord(refs, { ref: upper, note: "one" });
			const lowerKey = encodeRecordKey(refs, record);
			const upperKey = canonicalEncode([upper]);
			expect(
				lowerKey !== upperKey,
				"the kit's own uppercase key must differ from the canonical one",
			);
			const viaUpper = await refuses(async () => {
				await binding.records.write({
					dataset: refs.name,
					mutations: [upsertMutation("", upperKey, record)],
				});
			});
			await binding.records.write({
				dataset: refs.name,
				mutations: [upsertMutation("", lowerKey, record)],
			});
			const stored = await binding.records.read({
				dataset: refs.name,
				tenant: "",
				key: lowerKey,
			});
			expect(
				stored !== undefined &&
					canonicalEncode(stored) === canonicalEncode(record),
				"a uuid-keyed record is stored under its lowercase key",
			);
			if (binding.verify !== undefined) {
				const digest = await binding.verify.digest({
					scope: scopeOf(refs.name),
					buckets: 4,
				});
				expect(
					digest.count === 1,
					`an uppercase uuid key must be refused or normalised to the one row it names${viaUpper === undefined ? "; it was accepted and made a second row" : ""}`,
				);
			}
			const deleted = await refuses(async () => {
				await binding.records.write({
					dataset: refs.name,
					mutations: [deleteMutation("", upperKey)],
				});
			});
			expect(
				deleted !== undefined,
				"a delete naming a uuid key in uppercase must be refused",
			);
			expect(
				(await binding.records.read({
					dataset: refs.name,
					tenant: "",
					key: lowerKey,
				})) !== undefined,
				"a refused delete must leave the uuid-keyed record where it was",
			);
		},
	},
	{
		// Only an engine that states a bound is probed; the kit invents none.
		id: "records.oversize-record-refuses-the-batch",
		requires: ["records"],
		declares: (declaration) => declaration.maxRecordBytes !== undefined,
		dependsOn: ["records.round-trip-canonical"],
		async run(context) {
			const binding = await context.open("a");
			const bound = binding.declaration.maxRecordBytes;
			if (bound === undefined) throw new NotRun("no record bound is declared");
			if (bound > LARGEST_PROBED_RECORD_BYTES) {
				throw new NotRun(
					"the declared record bound is larger than the kit will build a record past",
				);
			}
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			// One field alone is past the bound, so the record is, however the
			// engine counts the rest.
			const oversize = upsert(schema, "", "oversize", {
				note: "x".repeat(bound + 1),
			});
			for (const batch of [
				[upsert(schema, "", "beside-first"), oversize],
				[oversize, upsert(schema, "", "beside-last")],
			]) {
				const refused = await refuses(() => write(binding, batch));
				expect(
					refused !== undefined,
					"a batch carrying a record past the declared bound must be refused",
				);
			}
			for (const id of ["oversize", "beside-first", "beside-last"]) {
				expect(
					(await recordOf(binding, schema, "", id)) === undefined,
					"a batch refused for one oversize record must leave nothing behind",
				);
			}
			await write(binding, [upsert(schema, "", "beside-first")]);
			expect(
				(await recordOf(binding, schema, "", "beside-first")) !== undefined,
				"the store must still take an ordinary write afterwards",
			);
		},
	},
	{
		id: "capture.write-is-read-whole",
		requires: ["capture"],
		dependsOn: ["capture.ordered-and-resumable", "capture.tenant-scope"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const capture = requirePort(binding, "capture");
			const whole = scopeOf(schema.name);
			const tenant = scopeOf(schema.name, "tenant-a");
			const start = await capture.start({
				scope: whole,
				subscription: "sub_w",
			});
			const tenantStart = await capture.start({
				scope: tenant,
				subscription: "sub_wt",
			});
			// One write of five mutations across two tenants, then one more.
			await write(binding, [
				upsert(schema, "tenant-a", "a-1", { qty: "1" }),
				upsert(schema, "tenant-b", "b-1", { qty: "2" }),
				upsert(schema, "tenant-a", "a-2", { qty: "3" }),
				upsert(schema, "tenant-b", "b-2", { qty: "4" }),
				upsert(schema, "tenant-a", "a-3", { qty: "5" }),
			]);
			await write(binding, [upsert(schema, "tenant-a", "a-4", { qty: "6" })]);
			const qtys = (batch: { readonly changes: readonly RecordMutation[] }) =>
				batch.changes.map((change) => String(change.record?.qty)).join(",");
			// A limit smaller than the write: the write still comes back whole.
			const first = await capture.read({
				scope: whole,
				subscription: "sub_w",
				after: start,
				limit: 2,
			});
			expect(
				qtys(first) === "1,2,3,4,5",
				`one write must be read whole and in order whatever the limit, got ${qtys(first)}`,
			);
			expect(
				!first.caughtUp,
				"a read that stopped before a later write is not caught up",
			);
			const rest = await capture.read({
				scope: whole,
				subscription: "sub_w",
				after: first.position,
				limit: 2,
			});
			expect(
				qtys(rest) === "6" && rest.caughtUp,
				`the position after a whole write resumes at the next write, got ${qtys(rest)}`,
			);
			// Under a tenant scope: that tenant's share of the write, whole.
			const scoped = await capture.read({
				scope: tenant,
				subscription: "sub_wt",
				after: tenantStart,
				limit: 2,
			});
			expect(
				qtys(scoped) === "1,3,5",
				`a tenant-scoped read returns the tenant's part of one write whole, got ${qtys(scoped)}`,
			);
			const scopedRest = await capture.read({
				scope: tenant,
				subscription: "sub_wt",
				after: scoped.position,
				limit: 2,
			});
			expect(
				qtys(scopedRest) === "6" && scopedRest.caughtUp,
				`a tenant-scoped read resumes at the next write, got ${qtys(scopedRest)}`,
			);
			await capture.stop("sub_w");
			await capture.stop("sub_wt");
		},
	},
	{
		// An engine with no per-reader log has nothing an acknowledgement
		// releases, and may declare so: the executors acknowledge to free log,
		// and never rely on an acknowledgement being refused.
		id: "capture.acknowledged-positions-are-final",
		limitable: true,
		requires: ["capture"],
		dependsOn: ["capture.invalid-position-is-an-error"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const capture = requirePort(binding, "capture");
			const scope = scopeOf(schema.name);
			const subscription = "sub_f";
			const start = await capture.start({ scope, subscription });
			for (const qty of ["1", "2", "3"]) {
				await write(binding, [upsert(schema, "", `order-${qty}`, { qty })]);
			}
			const first = await capture.read({
				scope,
				subscription,
				after: start,
				limit: 1,
			});
			expect(first.changes.length === 1, "the first write is read on its own");
			const rest = await capture.read({
				scope,
				subscription,
				after: first.position,
				limit: 10,
			});
			expect(
				rest.changes.length === 2 && rest.caughtUp,
				"the remaining two writes are read to the head",
			);
			// A position nobody minted is not an acknowledgement.
			const garbage = await refuses(async () => {
				await capture.acknowledge({ subscription, position: GARBAGE_POSITION });
			});
			expect(
				garbage !== undefined,
				"acknowledging a position the engine never minted must be refused",
			);
			const untouched = await capture.read({
				scope,
				subscription,
				after: start,
				limit: 10,
			});
			expect(
				untouched.changes.length === 3,
				"a refused acknowledgement must release nothing",
			);
			// A real acknowledgement is final: what it released cannot be read.
			await capture.acknowledge({ subscription, position: first.position });
			const below = await refuses(async () => {
				await capture.read({ scope, subscription, after: start, limit: 10 });
			});
			expect(
				below !== undefined,
				"reading from before an acknowledged position must be an error, not a batch with a silent gap",
			);
			const fromAcknowledged = () =>
				capture.read({
					scope,
					subscription,
					after: first.position,
					limit: 10,
				});
			const from = await fromAcknowledged();
			expect(
				from.changes.length === 2 && from.caughtUp,
				"reading from the acknowledged position returns everything after it",
			);
			// Acknowledging an older position afterwards rewinds nothing.
			await refuses(async () => {
				await capture.acknowledge({ subscription, position: start });
			});
			const still = await refuses(async () => {
				await capture.read({ scope, subscription, after: start, limit: 10 });
			});
			expect(
				still !== undefined,
				"acknowledging an older position must not bring released changes back",
			);
			// A position past the head: well-formed, and never read. Accepting
			// it would release changes nobody was handed.
			const past = context.input.engine.positionPastHead;
			if (past === undefined) {
				throw new NotRun(
					"the harness supplies no position past the head; acknowledging one could not be tried",
				);
			}
			const future = past.call(context.input.engine, rest.position);
			const ahead = await refuses(async () => {
				await capture.acknowledge({ subscription, position: future });
			});
			expect(
				ahead !== undefined,
				"acknowledging a position past the head must be refused: nothing was read there",
			);
			const after = await fromAcknowledged();
			expect(
				after.changes.length === 2 && after.caughtUp,
				"a refused acknowledgement past the head must release nothing",
			);
			await capture.stop(subscription);
		},
	},
	{
		id: "capture.subscription-name-is-bound-to-its-scope",
		requires: ["capture"],
		dependsOn: ["capture.tenant-scope"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const second = parseDatasetSchema({
				name: CONFORMANCE_SECOND_DATASET,
				version: 1,
				keyFields: ["id"],
				fields: [
					{ name: "id", type: "string", nullable: false },
					{ name: "note", type: "string", nullable: true },
				],
			});
			await binding.datasets.ensureDataset(second);
			const capture = requirePort(binding, "capture");
			const subscription = "sub_s";
			const home = scopeOf(schema.name, "tenant-a");
			const start = await capture.start({ scope: home, subscription });
			const elsewhere = parseCanonicalRecord(second, {
				id: "s-early",
				note: "",
			});
			// Written after the name was bound to tenant-a and before anyone
			// asked for it anywhere else.
			await write(binding, [
				upsert(schema, "tenant-b", "b-early", { qty: "1" }),
			]);
			await binding.records.write({
				dataset: second.name,
				mutations: [
					upsertMutation("", encodeRecordKey(second, elsewhere), elsewhere),
				],
			});
			await write(binding, [upsert(schema, "tenant-a", "a-1", { qty: "2" })]);
			const others = [scopeOf(schema.name, "tenant-b"), scopeOf(second.name)];
			for (const other of others) {
				let position: string | undefined;
				const refused = await refuses(async () => {
					position = await capture.start({ scope: other, subscription });
				});
				if (refused !== undefined || position === undefined) continue;
				// Accepted: then it is a reader of its own, starting now. The
				// first scope's position would hand it changes from before it
				// asked.
				const batch = await capture.read({
					scope: other,
					subscription,
					after: position,
					limit: 10,
				});
				expect(
					batch.changes.length === 0,
					"the same subscription name on another scope must be refused or independent; it was answered the first scope's position",
				);
			}
			// Either way the first reader is where it was.
			const mine = await capture.read({
				scope: home,
				subscription,
				after: start,
				limit: 10,
			});
			expect(
				mine.changes.length === 1 && mine.changes[0]?.record?.qty === "2",
				"asking for a subscription name on another scope must not disturb the scope it is bound to",
			);
			expect(
				(await capture.start({ scope: home, subscription })) === start,
				"the name still answers its own scope's original position",
			);
			await capture.stop(subscription);
		},
	},
	{
		id: "fence.dataset-wide-covers-tenants",
		requires: ["fence"],
		dependsOn: ["fence.single-write-authority"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const fence = requirePort(binding, "fence");
			const scope = scopeOf(schema.name);
			await write(binding, [
				upsert(schema, "tenant-a", "before", { qty: "1" }),
			]);
			const grant = await fence.raise({ scope, reason: "conformance" });
			// A fence on the whole dataset is a fence on every tenant in it.
			for (const tenant of ["tenant-a", "tenant-b", ""]) {
				const named = tenant === "" ? "the untenanted records" : tenant;
				const refused = await refuses(() =>
					write(binding, [upsert(schema, tenant, "order-1")]),
				);
				expect(
					refused instanceof FencedWriteError,
					`a dataset-wide fence must refuse a write to ${named} with FencedWriteError`,
				);
				expect(
					(await recordOf(binding, schema, tenant, "order-1")) === undefined,
					`a write to ${named} refused by a dataset-wide fence must not land`,
				);
			}
			const erased = await refuses(() =>
				write(binding, [deleteMutation("tenant-a", keyOf(schema, "before"))]),
			);
			expect(
				erased instanceof FencedWriteError &&
					(await recordOf(binding, schema, "tenant-a", "before"))?.qty === "1",
				"a dataset-wide fence must refuse a tenant-scoped delete too",
			);
			// The holder writes through its own fence, into any tenant.
			await write(
				binding,
				[upsert(schema, "tenant-a", "order-2")],
				grant.fenceToken,
			);
			expect(
				(await recordOf(binding, schema, "tenant-a", "order-2")) !== undefined,
				"the fence's holder writes through a dataset-wide fence",
			);
			await fence.release({ scope, fenceToken: grant.fenceToken });
			await write(binding, [upsert(schema, "tenant-a", "order-3")]);
		},
	},
	{
		id: "fence.wrong-token-is-refused",
		requires: ["fence"],
		dependsOn: ["fence.single-write-authority"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const fence = requirePort(binding, "fence");
			const mine = scopeOf(schema.name, "tenant-a");
			const theirs = scopeOf(schema.name, "tenant-b");
			const grant = await fence.raise({ scope: mine, reason: "conformance" });
			const other = await fence.raise({ scope: theirs, reason: "conformance" });
			expect(
				grant.fenceToken !== other.fenceToken,
				"two fences have two tokens",
			);
			// A token is one fence's. Any other text — another fence's token
			// included — opens nothing.
			const wrong: readonly (readonly [string, string])[] = [
				["a token that is not the fence's", `${grant.fenceToken}-not`],
				["an unrelated token", FOREIGN_TOKEN],
				["an empty token", ""],
				["another fence's token", other.fenceToken],
			];
			for (const [named, token] of wrong) {
				const refused = await refuses(() =>
					write(binding, [upsert(schema, "tenant-a", "order-1")], token),
				);
				expect(
					refused instanceof FencedWriteError,
					`a write presenting ${named} into a fenced scope must be refused with FencedWriteError`,
				);
			}
			expect(
				(await recordOf(binding, schema, "tenant-a", "order-1")) === undefined,
				"a write refused for its token must not land",
			);
			// One batch across both fences needs both tokens; it has one.
			const mixed = await refuses(() =>
				write(
					binding,
					[
						upsert(schema, "tenant-a", "order-2"),
						upsert(schema, "tenant-b", "order-2"),
					],
					grant.fenceToken,
				),
			);
			expect(
				mixed instanceof FencedWriteError &&
					(await recordOf(binding, schema, "tenant-a", "order-2")) ===
						undefined,
				"a batch that reaches a fence its token does not open must be refused whole",
			);
			await write(
				binding,
				[upsert(schema, "tenant-a", "order-3")],
				grant.fenceToken,
			);
			expect(
				(await recordOf(binding, schema, "tenant-a", "order-3")) !== undefined,
				"the fence's own token still writes through it",
			);
		},
	},
	{
		// `apply` is a write. A port that lands changes in a fenced scope
		// without the token is a second write authority.
		id: "fence.apply-honours-the-fence",
		requires: ["fence", "apply"],
		dependsOn: [
			"fence.dataset-wide-covers-tenants",
			"apply.idempotent-with-watermark",
		],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const fence = requirePort(binding, "fence");
			const apply = requirePort(binding, "apply");
			const dataset = schema.name;
			const watermark = () => apply.watermark({ dataset, source: "s" });
			const scope = scopeOf(dataset, "tenant-a");
			await write(binding, [
				upsert(schema, "tenant-a", "order-9", { qty: "9" }),
			]);
			const grant = await fence.raise({ scope, reason: "conformance" });
			const attempts: readonly (readonly [string, string | undefined])[] = [
				["no token", undefined],
				["a token that is not the fence's", FOREIGN_TOKEN],
			];
			for (const [named, token] of attempts) {
				const refused = await refuses(async () => {
					await apply.apply({
						dataset,
						// The other tenant's change comes first: refused whole, it
						// must not land either.
						changes: [
							upsert(schema, "tenant-b", "order-1"),
							upsert(schema, "tenant-a", "order-1"),
						],
						source: "s",
						position: "1",
						...(token === undefined ? undefined : { fenceToken: token }),
					});
				});
				expect(
					refused instanceof FencedWriteError,
					`an apply presenting ${named} into a fenced scope must be refused with FencedWriteError`,
				);
				expect(
					(await recordOf(binding, schema, "tenant-a", "order-1")) ===
						undefined &&
						(await recordOf(binding, schema, "tenant-b", "order-1")) ===
							undefined,
					"nothing of an apply refused by a fence may land",
				);
				expect(
					(await watermark()) === undefined,
					"an apply refused by a fence must not move the watermark",
				);
			}
			const erased = await refuses(async () => {
				await apply.apply({
					dataset,
					changes: [deleteMutation("tenant-a", keyOf(schema, "order-9"))],
					source: "s",
					position: "2",
				});
			});
			expect(
				erased instanceof FencedWriteError &&
					(await recordOf(binding, schema, "tenant-a", "order-9"))?.qty === "9",
				"an apply that only deletes is a write into the fenced scope too",
			);
			await apply.apply({
				dataset,
				changes: [upsert(schema, "tenant-a", "order-1", { qty: "4" })],
				source: "s",
				position: "3",
				fenceToken: grant.fenceToken,
			});
			expect(
				(await recordOf(binding, schema, "tenant-a", "order-1"))?.qty === "4" &&
					(await watermark()) === "3",
				"an apply presenting the fence's token lands and records its watermark",
			);
			// A dataset-wide fence stops a tokenless apply into any tenant.
			await fence.release({ scope, fenceToken: grant.fenceToken });
			const whole = scopeOf(dataset);
			const wide = await fence.raise({ scope: whole, reason: "conformance" });
			const under = await refuses(async () => {
				await apply.apply({
					dataset,
					changes: [upsert(schema, "tenant-b", "order-2")],
					source: "s",
					position: "4",
				});
			});
			expect(
				under instanceof FencedWriteError &&
					(await recordOf(binding, schema, "tenant-b", "order-2")) ===
						undefined &&
					(await watermark()) === "3",
				"a dataset-wide fence must refuse a tokenless apply into a tenant",
			);
			await fence.release({ scope: whole, fenceToken: wide.fenceToken });
		},
	},
	{
		id: "retire.foreign-token-is-refused",
		requires: ["retire", "fence", "verify"],
		dependsOn: ["retire.refused-unless-proven", "fence.wrong-token-is-refused"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			await write(binding, [
				upsert(schema, "tenant-a", "order-1"),
				upsert(schema, "tenant-a", "order-2"),
				upsert(schema, "tenant-b", "order-3"),
			]);
			const fence = requirePort(binding, "fence");
			const retire = requirePort(binding, "retire");
			const verify = requirePort(binding, "verify");
			const mine = scopeOf(schema.name, "tenant-a");
			const theirs = scopeOf(schema.name, "tenant-b");
			const grant = await fence.raise({ scope: mine, reason: "conformance" });
			const other = await fence.raise({ scope: theirs, reason: "conformance" });
			const expected = await verify.digest({ scope: mine, buckets: 8 });
			// The fence is up and the digest matches. Only the token is wrong.
			const foreign: readonly (readonly [string, string])[] = [
				["another fence's token", other.fenceToken],
				["a token that is not the fence's", `${grant.fenceToken}-not`],
				["an unrelated token", FOREIGN_TOKEN],
				["an empty token", ""],
			];
			for (const [named, token] of foreign) {
				const refused = await refuses(async () => {
					await retire.retire({ scope: mine, fenceToken: token, expected });
				});
				expect(
					refused !== undefined,
					`retire presenting ${named} must be refused while the scope is fenced`,
				);
				expect(
					(await verify.digest({ scope: mine, buckets: 8 })).count === 2,
					`retire refused for ${named} must remove nothing`,
				);
			}
			// A tenant's fence is not a fence on the dataset.
			const whole = scopeOf(schema.name);
			const all = await verify.digest({ scope: whole, buckets: 8 });
			const widened = await refuses(async () => {
				await retire.retire({
					scope: whole,
					fenceToken: grant.fenceToken,
					expected: all,
				});
			});
			expect(
				widened !== undefined &&
					(await verify.digest({ scope: whole, buckets: 8 })).count === 3,
				"a tenant fence's token must not retire the whole dataset",
			);
			const receipt = await retire.retire({
				scope: mine,
				fenceToken: grant.fenceToken,
				expected,
			});
			expect(
				receipt.removed === 2,
				"the fence's own token retires exactly its scope",
			);
		},
	},
	{
		id: "fence.re-raise-mints-a-new-token",
		requires: ["fence"],
		dependsOn: ["retire.foreign-token-is-refused"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const fence = requirePort(binding, "fence");
			const scope = scopeOf(schema.name, "tenant-a");
			const first = await fence.raise({ scope, reason: "conformance" });
			await fence.release({ scope, fenceToken: first.fenceToken });
			const second = await fence.raise({ scope, reason: "conformance" });
			expect(
				first.fenceToken !== second.fenceToken,
				"a fence raised after a release must have a new token",
			);
			const stale = await refuses(() =>
				write(
					binding,
					[upsert(schema, "tenant-a", "order-1")],
					first.fenceToken,
				),
			);
			expect(
				stale instanceof FencedWriteError,
				"the token of a released fence must not write through the fence raised after it",
			);
			const released = await refuses(() =>
				fence.release({ scope, fenceToken: first.fenceToken }),
			);
			expect(
				released !== undefined && (await fence.status(scope)).fenced,
				"the token of a released fence must not release the fence raised after it",
			);
			if (binding.retire !== undefined && binding.verify !== undefined) {
				const retire = binding.retire;
				await write(
					binding,
					[upsert(schema, "tenant-a", "order-2")],
					second.fenceToken,
				);
				const expected = await binding.verify.digest({ scope, buckets: 8 });
				const retired = await refuses(async () => {
					await retire.retire({
						scope,
						fenceToken: first.fenceToken,
						expected,
					});
				});
				expect(
					retired !== undefined &&
						(await binding.verify.digest({ scope, buckets: 8 })).count === 1,
					"the token of a released fence must not retire the scope",
				);
			}
			await write(
				binding,
				[upsert(schema, "tenant-a", "order-3")],
				second.fenceToken,
			);
		},
	},
	{
		// A retire whose answer was lost is sent again. It has to be safe to.
		id: "retire.redelivery-is-harmless",
		requires: ["retire", "fence", "verify"],
		dependsOn: ["retire.foreign-token-is-refused"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			await write(binding, [
				upsert(schema, "tenant-a", "order-1"),
				upsert(schema, "tenant-a", "order-2"),
				upsert(schema, "tenant-b", "order-3"),
			]);
			const retire = requirePort(binding, "retire");
			const verify = requirePort(binding, "verify");
			const scope = scopeOf(schema.name, "tenant-a");
			const grant = await requirePort(binding, "fence").raise({
				scope,
				reason: "conformance",
			});
			const expected = await verify.digest({ scope, buckets: 8 });
			const request = { scope, fenceToken: grant.fenceToken, expected };
			const receipt = await retire.retire(request);
			expect(receipt.removed === 2, "retire removes the scope");
			let again: number | undefined;
			const redelivered = await refuses(async () => {
				again = (await retire.retire(request)).removed;
			});
			expect(
				redelivered === undefined && again === 0,
				"a retire redelivered after it committed must succeed and remove nothing",
			);
			const wrong = await refuses(async () => {
				await retire.retire({ ...request, fenceToken: FOREIGN_TOKEN });
			});
			expect(
				wrong !== undefined,
				"a wrong token must be refused on the retired scope too: an empty scope is not an unguarded one",
			);
			expect(
				(await verify.digest({ scope: scopeOf(schema.name), buckets: 8 }))
					.count === 1,
				"another tenant's records survive a redelivered retire",
			);
		},
	},
	{
		// What a retire removed is gone, not a change to be delivered: replayed
		// to a later reader as deletes, it would empty the store that reader
		// feeds — which may be the one the records were moved to.
		id: "retire.leaves-nothing-to-capture",
		requires: ["retire", "fence", "verify", "capture"],
		dependsOn: ["retire.refused-unless-proven", "capture.tenant-scope"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			await write(binding, [
				upsert(schema, "tenant-a", "order-1"),
				upsert(schema, "tenant-a", "order-2"),
				upsert(schema, "tenant-b", "order-3"),
			]);
			const capture = requirePort(binding, "capture");
			const scope = scopeOf(schema.name, "tenant-a");
			const whole = scopeOf(schema.name);
			const grant = await requirePort(binding, "fence").raise({
				scope,
				reason: "conformance",
			});
			await requirePort(binding, "retire").retire({
				scope,
				fenceToken: grant.fenceToken,
				expected: await requirePort(binding, "verify").digest({
					scope,
					buckets: 8,
				}),
			});
			const readers: readonly (readonly [string, DatasetScope])[] = [
				["sub_r", whole],
				["sub_rt", scope],
			];
			for (const [subscription, reading] of readers) {
				const start = await capture.start({ scope: reading, subscription });
				const batch = await capture.read({
					scope: reading,
					subscription,
					after: start,
					limit: 50,
				});
				expect(
					batch.changes.length === 0 && batch.caughtUp,
					"a subscription started after a retire must be handed nothing of the retired scope",
				);
			}
			// The reader is live all the same: a write after it started arrives.
			await write(binding, [upsert(schema, "tenant-b", "order-4")]);
			const later = await capture.read({
				scope: whole,
				subscription: "sub_r",
				after: await capture.start({ scope: whole, subscription: "sub_r" }),
				limit: 50,
			});
			expect(
				later.changes.length === 1 && later.changes[0]?.tenant === "tenant-b",
				"capture still delivers a write made after the retire",
			);
			await capture.stop("sub_r");
			await capture.stop("sub_rt");
		},
	},
	{
		// A refusal is logged, shipped to an error tracker, shown to a person.
		// It may say what was refused; it may not carry the credential or the
		// record.
		id: "errors.refusals-carry-no-secrets",
		requires: ["fence"],
		dependsOn: ["fence.wrong-token-is-refused"],
		async run(context) {
			const binding = await context.open("a");
			const schema = conformanceSchema([binding]);
			await binding.datasets.ensureDataset(schema);
			const dataset = schema.name;
			const scope = scopeOf(dataset, "tenant-a");
			// Every record below carries the payload sentinel in its `note`.
			const payload = upsert(schema, "tenant-a", "order-1");
			expect(
				canonicalEncode(payload.record ?? null).includes(PAYLOAD_SENTINEL),
				"the kit's own record must carry the sentinel it looks for",
			);
			await write(binding, [payload]);
			const fence = requirePort(binding, "fence");
			const grant = await fence.raise({ scope, reason: "conformance" });
			const refusals: (readonly [string, Error | undefined])[] = [];
			const tried = async (
				named: string,
				action: () => Awaitable<void>,
			): Promise<void> => {
				refusals.push([named, await refuses(action)]);
			};
			await tried("a fenced write", () => write(binding, [payload]));
			await tried("a write with the wrong token", () =>
				write(binding, [payload], FOREIGN_TOKEN),
			);
			await tried("a release with the wrong token", () =>
				fence.release({ scope, fenceToken: FOREIGN_TOKEN }),
			);
			await tried("a write whose key disagrees with its record", async () => {
				await binding.records.write({
					dataset,
					mutations: [
						upsertMutation(
							"tenant-a",
							keyOf(schema, "order-other"),
							recordFor(schema, "order-1"),
						),
					],
					fenceToken: grant.fenceToken,
				});
			});
			const apply = binding.apply;
			if (apply !== undefined) {
				await tried("a fenced apply", async () => {
					await apply.apply({
						dataset,
						changes: [payload],
						source: "s",
						position: "1",
					});
				});
				await apply.apply({
					dataset,
					changes: [],
					source: "s",
					position: "1",
					fenceToken: grant.fenceToken,
				});
				await tried("a stale apply", async () => {
					await apply.apply({
						dataset,
						changes: [payload],
						source: "s",
						position: "2",
						fenceToken: grant.fenceToken,
						expectedWatermark: null,
					});
				});
			}
			const retire = binding.retire;
			const verify = binding.verify;
			if (retire !== undefined && verify !== undefined) {
				const expected = await verify.digest({ scope, buckets: 8 });
				await tried("a retire with the wrong token", async () => {
					await retire.retire({ scope, fenceToken: FOREIGN_TOKEN, expected });
				});
				await write(
					binding,
					[upsert(schema, "tenant-a", "order-2")],
					grant.fenceToken,
				);
				await tried("a retire with a stale digest", async () => {
					await retire.retire({
						scope,
						fenceToken: grant.fenceToken,
						expected,
					});
				});
			}
			const capture = binding.capture;
			if (capture !== undefined) {
				await capture.start({ scope, subscription: "sub_e" });
				await tried("a read from a position nobody minted", async () => {
					await capture.read({
						scope,
						subscription: "sub_e",
						after: GARBAGE_POSITION,
						limit: 10,
					});
				});
				await capture.stop("sub_e");
			}
			for (const [named, refusal] of refusals) {
				expect(
					refusal !== undefined,
					`${named} must be refused for its refusal to be inspected`,
				);
				const shown = exposureOf(refusal);
				expect(
					!shown.includes(grant.fenceToken),
					`the refusal of ${named} carries the fence token; it is a credential`,
				);
				expect(
					!shown.includes(PAYLOAD_SENTINEL),
					`the refusal of ${named} carries record payload`,
				);
			}
		},
	},
	{
		id: "pattern.snapshot-and-tail.zero-loss-under-load",
		requires: COPY_SOURCE,
		peerRequires: COPY_TARGET,
		dependsOn: [
			"apply.idempotent-with-watermark",
			"capture.ordered-and-resumable",
			"snapshot.returns-the-scope",
			"fence.single-write-authority",
			"retire.refused-unless-proven",
		],
		async run(context) {
			const pair = await seededPair(context, 40);
			// The router keeps the highest journal head it applied (see `AuthorityMoveRef`).
			const applied = new Map<string, number>();
			let flipped = false;
			// Writes keep arriving between every phase: updates, inserts, deletes.
			const load = async (phase: MigrationPhase): Promise<void> => {
				if (flipped) return;
				await write(pair.source, [
					upsert(pair.schema, "", "order-1", { note: `after ${phase}` }),
					upsert(pair.schema, "", `order-new-${phase}`, { qty: "7" }),
					deleteMutation("", keyOf(pair.schema, `order-${phase.length}`)),
				]);
			};
			const result = await runSnapshotAndTail(
				copyOptions(
					pair,
					runtime(
						"zero-loss",
						context.input.now,
						createMemoryMigrationJournal(),
						{
							afterPhase: load,
							pauseAfter: "fence-and-flip",
						},
					),
					{
						flipAuthority: (flip) => {
							admitAuthorityMove(applied, flip);
							flipped = true;
						},
					},
				),
			);
			expect(result.status === "held", "the run pauses in the soak window");
			expect(flipped, "write authority moved exactly once");
			expect(
				await digestsEqual(pair.source, pair.target),
				"source and target must digest equal at the fence position",
			);
			const refused = await refuses(() =>
				write(pair.source, [upsert(pair.schema, "", "late-write")]),
			);
			expect(
				refused instanceof FencedWriteError,
				"after the flip the old authority must refuse writes",
			);
			expect(
				!JSON.stringify(result.facts).includes(PAYLOAD_SENTINEL),
				"migration facts must carry no record payload",
			);
			expect(
				!JSON.stringify(result.facts).includes(await raisedToken(pair.source)),
				"migration facts must not carry the fence token; it is a credential",
			);
		},
	},
	{
		id: "pattern.snapshot-and-tail.resumes-at-every-boundary",
		requires: COPY_SOURCE,
		peerRequires: COPY_TARGET,
		dependsOn: ["pattern.snapshot-and-tail.zero-loss-under-load"],
		async run(context) {
			const boundaries: readonly MigrationPhase[] = [
				"gate",
				"prepare",
				"seed",
				"converge",
				"verify",
				"shift-reads",
				"fence-and-flip",
				"soak",
			];
			for (const boundary of boundaries) {
				const pair = await seededPair(context, 12);
				const journal = createMemoryMigrationJournal();
				let crashed = false;
				const crashing = runtime(
					`resume-${boundary}`,
					context.input.now,
					journal,
					{
						afterPhase: (phase) => {
							if (phase === boundary && !crashed) {
								crashed = true;
								throw new Error(`injected crash after ${phase}`);
							}
						},
					},
				);
				const first = await refuses(async () => {
					await runSnapshotAndTail(copyOptions(pair, crashing));
				});
				expect(
					first !== undefined,
					`the injected crash after ${boundary} must surface`,
				);
				const resumed = await runSnapshotAndTail(
					copyOptions(
						pair,
						runtime(`resume-${boundary}`, context.input.now, journal),
					),
				);
				expect(
					resumed.status === "completed",
					`a run crashed after ${boundary} must resume to completion, got ${resumed.status}`,
				);
				const after = await requirePort(pair.target, "verify").digest({
					scope: scopeOf(CONFORMANCE_DATASET),
					buckets: 8,
				});
				expect(
					after.count === 12,
					`resume after ${boundary} must not lose or duplicate records`,
				);
				const emptied = await requirePort(pair.source, "verify").digest({
					scope: scopeOf(CONFORMANCE_DATASET),
					buckets: 8,
				});
				expect(emptied.count === 0, "a completed migration retires the source");
			}
		},
	},
	{
		id: "pattern.snapshot-and-tail.lossless-soak-rollback",
		requires: [...COPY_SOURCE, "apply"],
		peerRequires: [...COPY_TARGET, "capture"],
		dependsOn: ["pattern.snapshot-and-tail.zero-loss-under-load"],
		async run(context) {
			const pair = await seededPair(context, 10);
			const journal = createMemoryMigrationJournal();
			const held = await runSnapshotAndTail(
				copyOptions(pair, runtime("soak", context.input.now, journal), {
					soakDecision: () => "hold",
				}),
			);
			expect(
				held.status === "held" && held.rollback === "lossless",
				"soak holds losslessly",
			);
			// The target is now the authority; these writes exist only there.
			await write(pair.target, [
				upsert(pair.schema, "", "written-after-flip", { qty: "99" }),
				deleteMutation("", keyOf(pair.schema, "order-3")),
			]);
			// The router keeps the highest journal head it applied (see `AuthorityMoveRef`).
			const applied = new Map<string, number>();
			const directions: string[] = [];
			const rolled = await runSnapshotAndTail(
				copyOptions(pair, runtime("soak", context.input.now, journal), {
					soakDecision: () => "rollback",
					flipAuthority: (flip) => {
						admitAuthorityMove(applied, flip);
						directions.push(flip.direction);
					},
				}),
			);
			expect(rolled.status === "rolled-back", "the run rolls back from soak");
			expect(
				directions.join(",") === "to-source",
				"authority returns to the source once",
			);
			expect(
				await digestsEqual(pair.source, pair.target),
				"a rollback under a reverse tail loses no acknowledged write",
			);
			const kept = await pair.source.records.read({
				dataset: CONFORMANCE_DATASET,
				tenant: "",
				key: keyOf(pair.schema, "written-after-flip"),
			});
			expect(
				kept?.qty === "99",
				"a write made after the flip survives the rollback",
			);
			await write(pair.source, [upsert(pair.schema, "", "after-rollback")]);
		},
	},
	{
		id: "pattern.snapshot-and-tail.rollback-never-resurrects",
		requires: COPY_SOURCE,
		peerRequires: COPY_TARGET,
		dependsOn: ["pattern.snapshot-and-tail.zero-loss-under-load"],
		async run(context) {
			const seeded = await seededPair(context, 6);
			// No reverse tail: the source goes stale at the flip, so a rollback
			// is to-snapshot. An erasure made meanwhile must still hold.
			const pair: Pair = {
				...seeded,
				target: withoutPorts(seeded.target, ["capture"]),
			};
			const journal = createMemoryMigrationJournal();
			const held = await runSnapshotAndTail(
				copyOptions(pair, runtime("erase", context.input.now, journal), {
					soakDecision: () => "hold",
				}),
			);
			expect(
				held.status === "held" && held.rollback === "to-snapshot",
				"without a reverse tail the soak posture is to-snapshot, and says so",
			);
			const erasedKey = keyOf(pair.schema, "order-2");
			await write(pair.target, [deleteMutation("", erasedKey)]);
			const rolled = await runSnapshotAndTail(
				copyOptions(pair, runtime("erase", context.input.now, journal), {
					soakDecision: () => "rollback",
					erasures: { since: () => [deleteMutation("", erasedKey)] },
				}),
			);
			expect(rolled.status === "rolled-back", "the run rolls back");
			expect(
				(await pair.source.records.read({
					dataset: CONFORMANCE_DATASET,
					tenant: "",
					key: erasedKey,
				})) === undefined,
				"a rollback must not resurrect an erased subject",
			);
			expect(
				(rolled.reason ?? "").includes("lost"),
				"a lossy rollback states its loss instead of claiming none",
			);
		},
	},
	{
		id: "pattern.snapshot-and-tail.tenant-move",
		requires: COPY_SOURCE,
		peerRequires: COPY_TARGET,
		dependsOn: [
			"pattern.snapshot-and-tail.zero-loss-under-load",
			"capture.tenant-scope",
		],
		async run(context) {
			const source = await context.open("pooled");
			const target = await context.openPeer("silo");
			const schema = conformanceSchema([source, target]);
			await source.datasets.ensureDataset(schema);
			await write(source, [
				upsert(schema, "tenant-a", "order-1"),
				upsert(schema, "tenant-b", "order-2"),
				upsert(schema, "tenant-a", "order-3"),
			]);
			const result = await runSnapshotAndTail(
				copyOptions(
					{ source, target, schema },
					runtime(
						"tenant-move",
						context.input.now,
						createMemoryMigrationJournal(),
					),
					{ scope: scopeOf(CONFORMANCE_DATASET, "tenant-a") },
				),
			);
			expect(result.status === "completed", "a pooled-to-silo move completes");
			const silo = await requirePort(target, "verify").digest({
				scope: scopeOf(CONFORMANCE_DATASET),
				buckets: 8,
			});
			expect(silo.count === 2, "the silo holds exactly the moved tenant");
			const pooled = await requirePort(source, "verify").digest({
				scope: scopeOf(CONFORMANCE_DATASET),
				buckets: 8,
			});
			expect(
				pooled.count === 1,
				"the pooled store keeps the other tenant, untouched",
			);
			await write(source, [upsert(schema, "tenant-b", "order-9")]);
		},
	},
	{
		// Retiring the source is the last thing a migration does. It must stay
		// on the source: carried to the target, or replayed to a later reader of
		// the source's log, it would arrive as deletes of everything just moved.
		id: "pattern.snapshot-and-tail.retire-stays-on-the-source",
		requires: COPY_SOURCE,
		peerRequires: COPY_TARGET,
		dependsOn: [
			"pattern.snapshot-and-tail.zero-loss-under-load",
			"retire.leaves-nothing-to-capture",
		],
		async run(context) {
			const pair = await seededPair(context, 9);
			const journal = createMemoryMigrationJournal();
			const held = await runSnapshotAndTail(
				copyOptions(pair, runtime("retire-stays", context.input.now, journal), {
					soakDecision: () => "hold",
				}),
			);
			expect(held.status === "held", "the run holds in the soak window");
			const scope = scopeOf(CONFORMANCE_DATASET);
			const moved = await requirePort(pair.target, "verify").digest({
				scope,
				buckets: 8,
			});
			expect(moved.count === 9, "the target holds every record at the soak");
			const done = await runSnapshotAndTail(
				copyOptions(pair, runtime("retire-stays", context.input.now, journal)),
			);
			expect(
				done.status === "completed",
				`the run finishes from the soak window, got ${done.status}`,
			);
			expect(
				(await countIn(pair.source)) === 0,
				"a completed migration retires the source",
			);
			const kept = await requirePort(pair.target, "verify").digest({
				scope,
				buckets: 8,
			});
			expect(
				compareDigests(moved, kept).equal,
				"retiring the source must not reach the migration's own target",
			);
			// A reader that arrives on the retired source afterwards — a second
			// migration, say — is handed nothing: no deletes to carry anywhere.
			const capture = requirePort(pair.source, "capture");
			const start = await capture.start({ scope, subscription: "sub_late" });
			const batch = await capture.read({
				scope,
				subscription: "sub_late",
				after: start,
				limit: 50,
			});
			expect(
				batch.changes.length === 0 && batch.caughtUp,
				"a reader started on the retired source must not be handed the retire as deletes",
			);
			await capture.stop("sub_late");
			// Run again, a completed migration changes nothing.
			const again = await runSnapshotAndTail(
				copyOptions(pair, runtime("retire-stays", context.input.now, journal)),
			);
			expect(
				again.status === "completed" && (await countIn(pair.target)) === 9,
				"re-running a completed migration is a no-op",
			);
		},
	},
	{
		// The cutover, killed at each of its side effects — the fence raised and
		// nobody told, authority moved and the process gone, the retire
		// committed with no fact after it. Every resume ends in the one outcome.
		id: "pattern.snapshot-and-tail.crash-windows.cutover",
		requires: COPY_SOURCE,
		peerRequires: COPY_TARGET,
		dependsOn: [
			"pattern.snapshot-and-tail.resumes-at-every-boundary",
			"retire.redelivery-is-harmless",
		],
		async run(context) {
			const rows = 6;
			await sweepCrashWindows(context, {
				name: "cutover",
				windows: [
					"source.fence.raise",
					"journal.append CutOver",
					"flip to-target",
					"source.capture.stop",
					"source.retire",
				],
				required: ["source.fence.raise", "flip to-target", "source.retire"],
				stage: () => seededPair(context, rows),
				crashing: {},
				resuming: {},
				async baseline(world, result) {
					await expectCutOverCompleted(world, result, "cutover", rows);
				},
				settled: (world, result, where) =>
					expectCutOverCompleted(world, result, where, rows),
			});
		},
	},
	{
		// Verification under the fence fails, and the run gives authority back:
		// it journals the hold and releases the fence. Killed either side of
		// that release, the source must end up the one writer, and the run must
		// still complete once the cause is gone.
		id: "pattern.snapshot-and-tail.crash-windows.compensation",
		requires: COPY_SOURCE,
		peerRequires: COPY_TARGET,
		dependsOn: ["pattern.snapshot-and-tail.crash-windows.cutover"],
		async run(context) {
			const rows = 6;
			const stray = (pair: Pair): RecordMutation =>
				upsert(pair.schema, "", "stray", { qty: "1" });
			await sweepCrashWindows(context, {
				name: "compensation",
				windows: [
					"source.fence.raise",
					"journal.append Held",
					"source.fence.release",
				],
				required: ["source.fence.raise", "source.fence.release"],
				stage: () => seededPair(context, rows),
				// Reach the read ramp cleanly, then put a record on the target
				// behind the migration's back: the comparison under the fence
				// fails, and the crashing run is the one that compensates.
				async prepare(world) {
					const paused = await attemptRun(
						context,
						world,
						undefined,
						{},
						{ pauseAfter: "shift-reads" },
					);
					expect(
						paused.status === "held",
						"the run pauses after the read ramp",
					);
					await write(world.pair.target, [stray(world.pair)]);
				},
				crashing: {},
				resuming: {},
				async baseline(world, result) {
					expect(
						result.status === "held",
						`a failed verification under the fence must hold, got ${result.status}`,
					);
					expect(
						world.authority.flips.length === 0 &&
							!(await fencedAt(world.pair.source)),
						"a compensated run leaves the source the authority, and writable",
					);
				},
				// The cause goes away, and the supervisor runs it again.
				async repair(world) {
					expect(
						world.authority.side === "source",
						"a failed verification must never move authority",
					);
					await write(world.pair.target, [
						deleteMutation("", keyOf(world.pair.schema, "stray")),
					]);
				},
				settled: (world, result, where) =>
					expectCutOverCompleted(world, result, where, rows),
			});
		},
	},
	{
		// A rollback from soak under a reverse tail, killed at each side effect:
		// it must end rolled back, the source the one writer, nothing lost.
		id: "pattern.snapshot-and-tail.crash-windows.rollback",
		requires: [...COPY_SOURCE, "apply"],
		peerRequires: [...COPY_TARGET, "capture", "fence"],
		dependsOn: [
			"pattern.snapshot-and-tail.lossless-soak-rollback",
			"pattern.snapshot-and-tail.crash-windows.cutover",
		],
		async run(context) {
			const rows = 6;
			const settled = async (
				world: CrashWorld,
				result: MigrationRunResult,
				where: string,
			): Promise<void> => {
				const { pair, authority, journal, migrationId } = world;
				expect(
					result.status === "rolled-back",
					`${where}: the run must end rolled back, got ${result.status}: ${result.reason ?? ""}`,
				);
				expect(
					authority.side === "source",
					`${where}: write authority must end on the source`,
				);
				expect(
					!(await fencedAt(pair.source)) && (await fencedAt(pair.target)),
					`${where}: the source must be the one writer, and the target fenced`,
				);
				expect(
					(await recordOf(pair.source, pair.schema, "", "after-flip"))?.qty ===
						"99",
					`${where}: a write the target took after the flip must survive the rollback`,
				);
				expect(
					(await recordOf(pair.source, pair.schema, "", "order-2")) ===
						undefined,
					`${where}: a record erased after the flip must stay erased`,
				);
				expect(
					(await countIn(pair.source)) === rows &&
						(await digestsEqual(pair.source, pair.target)),
					`${where}: a rollback under a reverse tail loses no acknowledged write`,
				);
				const facts = await journal.load(migrationId);
				expect(
					facts.filter((fact) => fact.type === MIGRATION_EVENTS.RolledBack)
						.length === 1,
					`${where}: the rollback is recorded once`,
				);
			};
			await sweepCrashWindows(context, {
				name: "rollback",
				windows: [
					"target.fence.raise",
					"journal.append RollbackDecided",
					"flip to-source",
					"source.fence.release",
					"target.capture.stop",
				],
				required: [
					"target.fence.raise",
					"flip to-source",
					"source.fence.release",
				],
				stage: () => seededPair(context, rows),
				// Reach the soak window, and let the new authority take writes.
				async prepare(world) {
					const held = await attemptRun(context, world, undefined, {
						soakDecision: () => "hold",
					});
					expect(
						held.status === "held" && held.rollback === "lossless",
						"the run holds in the soak window with a reverse tail",
					);
					await write(world.pair.target, [
						upsert(world.pair.schema, "", "after-flip", { qty: "99" }),
						deleteMutation("", keyOf(world.pair.schema, "order-2")),
					]);
				},
				crashing: { soakDecision: () => "rollback" },
				resuming: { soakDecision: () => "rollback" },
				baseline: (world, result) => settled(world, result, "rollback"),
				settled,
			});
		},
	},
	{
		id: "pattern.snapshot-and-tail.native.zero-loss-under-load",
		native: "snapshot-and-tail",
		requires: NATIVE_SOURCE,
		peerRequires: NATIVE_TARGET,
		dependsOn: [
			"verify.digest-is-engine-independent",
			"fence.single-write-authority",
			"retire.refused-unless-proven",
		],
		async run(context) {
			const pair = await seededNativePair(context, 40);
			const journal = createMemoryMigrationJournal();
			const tally: WriterTally = { acknowledged: [], problems: [] };
			let quiet = false;
			// The router keeps the highest journal head it applied (see `AuthorityMoveRef`).
			const applied = new Map<string, number>();
			let flips = 0;
			let writers: Promise<void>[] = [];
			const start = (names: readonly string[]): void => {
				quiet = false;
				writers = names.map((name) =>
					keepWriting(pair, name, tally, () => quiet),
				);
			};
			const settle = async (): Promise<void> => {
				quiet = true;
				await Promise.all(writers);
				writers = [];
			};
			// Writers run concurrently with the engine's own copy and tail,
			// pause while the two sides are compared unfenced, and then race
			// the fence itself: each either lands before it or is refused.
			const load = async (phase: MigrationPhase): Promise<void> => {
				if (phase === "gate") start(["during-copy-a", "during-copy-b"]);
				if (phase === "converge") {
					await settle();
					await write(pair.source, [
						upsert(pair.schema, "", "order-1", { note: "after converge" }),
						deleteMutation("", keyOf(pair.schema, "order-2")),
					]);
				}
				if (phase === "verify") {
					await write(pair.source, [
						upsert(pair.schema, "", "order-new", { qty: "7" }),
						deleteMutation("", keyOf(pair.schema, "order-3")),
					]);
				}
				if (phase === "shift-reads") {
					start(["racing-a", "racing-b", "racing-c"]);
				}
			};
			const options = (
				extra: Partial<MigrationRuntime>,
			): CopyMigrationOptions =>
				copyOptions(
					pair,
					runtime("native-zero-loss", context.input.now, journal, extra),
					{
						...nativeOptions(context),
						flipAuthority: (flip) => {
							admitAuthorityMove(applied, flip);
							flips += 1;
						},
					},
				);
			let result: MigrationRunResult;
			try {
				result = await runSnapshotAndTail(
					options({ afterPhase: load, pauseAfter: "fence-and-flip" }),
				);
			} finally {
				await settle();
			}
			expect(
				tally.problems.length === 0,
				`a concurrent write either lands or is refused by the fence: ${tally.problems.join("; ")}`,
			);
			expect(
				result.status === "held",
				`the run pauses in the soak window, got ${result.status}: ${result.reason ?? ""}`,
			);
			expect(
				result.state.realization === "native" &&
					result.state.profile === context.nativeProfile,
				"the journal must record the realization that ran",
			);
			expect(flips === 1, "write authority moved exactly once");
			expect(
				result.rollback === "to-snapshot",
				"a native realization has no reverse tail, and its soak posture says so",
			);
			expect(
				await digestsEqual(pair.source, pair.target),
				"source and target must digest equal at the fence position",
			);
			expect(
				tally.acknowledged.length > 0,
				"the concurrent writers must have landed writes for the case to mean anything",
			);
			for (const id of tally.acknowledged.slice(-40)) {
				expect(
					(await pair.target.records.read({
						dataset: CONFORMANCE_DATASET,
						tenant: "",
						key: keyOf(pair.schema, id),
					})) !== undefined,
					`an acknowledged write (${id}) is missing from the target`,
				);
			}
			const refused = await refuses(() =>
				write(pair.source, [upsert(pair.schema, "", "late-write")]),
			);
			expect(
				refused instanceof FencedWriteError,
				"after the flip the old authority must refuse writes",
			);
			const facts = JSON.stringify(result.facts);
			expect(
				!facts.includes(PAYLOAD_SENTINEL),
				"migration facts must carry no record payload",
			);
			expect(
				!facts.includes(await raisedToken(pair.source)),
				"migration facts must not carry the fence token; it is a credential",
			);
			// Finishing retires the source. The engine's own transport must be
			// gone by then: carried across it, the retirement would arrive at
			// the new authority as deletes.
			const moved = await requirePort(pair.target, "verify").digest({
				scope: scopeOf(CONFORMANCE_DATASET),
				buckets: 8,
			});
			const finished = await runSnapshotAndTail(options({}));
			expect(
				finished.status === "completed",
				`the run finishes from the soak window, got ${finished.status}`,
			);
			expect(flips === 1, "finishing does not move authority a second time");
			const emptied = await requirePort(pair.source, "verify").digest({
				scope: scopeOf(CONFORMANCE_DATASET),
				buckets: 8,
			});
			expect(emptied.count === 0, "a completed migration retires the source");
			const kept = await requirePort(pair.target, "verify").digest({
				scope: scopeOf(CONFORMANCE_DATASET),
				buckets: 8,
			});
			expect(
				compareDigests(moved, kept).equal,
				"retiring the source must not reach the target through the engine's transport",
			);
		},
	},
	{
		id: "pattern.snapshot-and-tail.native.resumes-at-every-boundary",
		native: "snapshot-and-tail",
		requires: NATIVE_SOURCE,
		peerRequires: NATIVE_TARGET,
		dependsOn: ["pattern.snapshot-and-tail.native.zero-loss-under-load"],
		async run(context) {
			const boundaries: readonly MigrationPhase[] = [
				"gate",
				"prepare",
				"seed",
				"converge",
				"verify",
				"shift-reads",
				"fence-and-flip",
				"soak",
			];
			for (const boundary of boundaries) {
				const pair = await seededNativePair(context, 12);
				const journal = createMemoryMigrationJournal();
				let crashed = false;
				const crashing = runtime(
					`native-resume-${boundary}`,
					context.input.now,
					journal,
					{
						afterPhase: async (phase) => {
							if (phase === boundary && !crashed) {
								crashed = true;
								// A write the crashed run never saw: the resumed run
								// has to carry it, wherever the crash fell.
								if (phase !== "fence-and-flip" && phase !== "soak") {
									await write(pair.source, [
										upsert(pair.schema, "", "order-0", { note: phase }),
									]);
								}
								throw new Error(`injected crash after ${phase}`);
							}
						},
					},
				);
				const first = await refuses(async () => {
					await runSnapshotAndTail(
						copyOptions(pair, crashing, nativeOptions(context)),
					);
				});
				expect(
					first !== undefined,
					`the injected crash after ${boundary} must surface`,
				);
				const resumed = await runSnapshotAndTail(
					copyOptions(
						pair,
						runtime(`native-resume-${boundary}`, context.input.now, journal),
						nativeOptions(context),
					),
				);
				expect(
					resumed.status === "completed",
					`a native run crashed after ${boundary} must resume to completion, got ${resumed.status}: ${resumed.reason ?? ""}`,
				);
				expect(
					resumed.state.realization === "native",
					"a resumed run keeps the realization it was planned with",
				);
				const after = await requirePort(pair.target, "verify").digest({
					scope: scopeOf(CONFORMANCE_DATASET),
					buckets: 8,
				});
				expect(
					after.count === 12,
					`resume after ${boundary} must not lose or duplicate records`,
				);
				const carried = await pair.target.records.read({
					dataset: CONFORMANCE_DATASET,
					tenant: "",
					key: keyOf(pair.schema, "order-0"),
				});
				expect(
					boundary === "fence-and-flip" ||
						boundary === "soak" ||
						carried?.note === boundary,
					`a write made before the crash after ${boundary} must reach the target`,
				);
				const emptied = await requirePort(pair.source, "verify").digest({
					scope: scopeOf(CONFORMANCE_DATASET),
					buckets: 8,
				});
				expect(emptied.count === 0, "a completed migration retires the source");
			}
		},
	},
	{
		// The same cutover with the engine's own transport carrying the
		// records: killed around the fence, around each stop of the transfer,
		// around the flip and the retire.
		id: "pattern.snapshot-and-tail.native.crash-windows.cutover",
		native: "snapshot-and-tail",
		requires: NATIVE_SOURCE,
		peerRequires: NATIVE_TARGET,
		dependsOn: ["pattern.snapshot-and-tail.native.resumes-at-every-boundary"],
		async run(context) {
			const rows = 6;
			await sweepCrashWindows(context, {
				name: "native cutover",
				windows: [
					"source.fence.raise",
					"target.native.stop",
					"source.native.stop",
					"flip to-target",
					"source.retire",
				],
				required: [
					"source.fence.raise",
					"target.native.stop",
					"source.native.stop",
					"flip to-target",
					"source.retire",
				],
				stage: () => seededNativePair(context, rows),
				base: nativeOptions(context),
				crashing: {},
				resuming: {},
				async baseline(world, result) {
					await expectCutOverCompleted(world, result, "native cutover", rows);
				},
				settled: (world, result, where) =>
					expectCutOverCompleted(world, result, where, rows),
			});
		},
	},
	{
		id: "pattern.offline-copy.exact",
		requires: ["snapshot", "verify", "fence", "retire"],
		peerRequires: COPY_TARGET,
		dependsOn: ["snapshot.returns-the-scope", "retire.refused-unless-proven"],
		async run(context) {
			const pair = await seededPair(context, 15);
			const result = await runOfflineCopy(
				copyOptions(
					pair,
					runtime("offline", context.input.now, createMemoryMigrationJournal()),
				),
			);
			expect(result.status === "completed", "an offline copy completes");
			const target = await requirePort(pair.target, "verify").digest({
				scope: scopeOf(CONFORMANCE_DATASET),
				buckets: 8,
			});
			expect(target.count === 15, "every record arrived");
			const source = await requirePort(pair.source, "verify").digest({
				scope: scopeOf(CONFORMANCE_DATASET),
				buckets: 8,
			});
			expect(source.count === 0, "the source is retired after a verified copy");
		},
	},
	{
		id: "pattern.in-place-evolve.gated-and-restorable",
		requires: ["schema"],
		async run(context) {
			const fixture = context.input.engine.schemaFixture;
			if (fixture === undefined)
				throw new NotRun("the harness supplies no schema fixture");
			const binding = await context.open("a");
			const port = requirePort(binding, "schema");
			await port.applyPhase("expand", fixture.setup);
			const blocked = await runInPlaceEvolve({
				port,
				plan: fixture.plan,
				clock: () => context.input.now,
				compatGate: () => ({
					gateId: "conformance",
					consumersOnLegacySchema: ["legacy-consumer"],
					verifiedAt: context.input.now,
				}),
			});
			expect(
				blocked.status === "contract-blocked" && blocked.dualWindowOpen,
				"a consumer on the old shape blocks the destructive phase and keeps the dual window open",
			);
			expect(
				(await port.verify(fixture.provesContractApplied)).length === 0,
				"a blocked contract phase must not have run",
			);
		},
	},
	{
		id: "pattern.in-place-evolve.failure-restores",
		requires: ["schema"],
		dependsOn: ["pattern.in-place-evolve.gated-and-restorable"],
		async run(context) {
			const fixture = context.input.engine.schemaFixture;
			if (fixture === undefined)
				throw new NotRun("the harness supplies no schema fixture");
			const binding = await context.open("a");
			const port = requirePort(binding, "schema");
			await port.applyPhase("expand", fixture.setup);
			let replayed = 0;
			const failed = await runInPlaceEvolve({
				port,
				plan: { ...fixture.plan, contract: [fixture.failingStatement] },
				clock: () => context.input.now,
				compatGate: () => ({
					gateId: "conformance",
					consumersOnLegacySchema: [],
					verifiedAt: context.input.now,
				}),
				replayErasures: () => {
					replayed += 1;
					return 0;
				},
			});
			expect(
				failed.status === "rolled-back",
				"a failed phase restores the snapshot",
			);
			expect(
				replayed === 1,
				"a restore re-applies erasures recorded since the snapshot",
			);
			const completed = await runInPlaceEvolve({
				port,
				plan: fixture.plan,
				clock: () => context.input.now,
				compatGate: () => ({
					gateId: "conformance",
					consumersOnLegacySchema: [],
					verifiedAt: context.input.now,
				}),
			});
			expect(
				completed.status === "completed",
				"the same plan then completes from the restored state",
			);
			expect(
				(await port.verify(fixture.provesContractApplied)).length > 0,
				"the contract phase ran",
			);
		},
	},
	{
		// Two bindings on one store each take a snapshot. They must be two
		// snapshots: a second that overwrote the first would leave the first
		// binding restoring a state it never saw.
		id: "schema.snapshots-are-per-binding",
		requires: ["schema"],
		dependsOn: ["pattern.in-place-evolve.failure-restores"],
		async run(context) {
			const fixture = context.input.engine.schemaFixture;
			if (fixture === undefined)
				throw new NotRun("the harness supplies no schema fixture");
			const first = await context.open("a");
			const port = requirePort(first, "schema");
			await port.applyPhase("expand", fixture.setup);
			const second = requirePort(await context.attach(first, "b"), "schema");
			const before = await port.snapshot();
			await port.applyPhase("expand", fixture.plan.expand);
			const after = await second.snapshot();
			expect(
				before.ref !== after.ref,
				"two bindings on one store must take distinct snapshots",
			);
			await second.applyPhase("backfill", fixture.plan.backfill);
			await second.applyPhase("contract", fixture.plan.contract);
			expect(
				(await second.verify(fixture.provesContractApplied)).length > 0,
				"the second binding ran the contract phase",
			);
			await port.restore(before);
			expect(
				(await port.verify(fixture.provesContractApplied)).length === 0,
				"the first binding's snapshot must still restore after a second binding took its own",
			);
			// What came back is the first snapshot — taken before the expand
			// phase — and not the second: the expand phase applies again.
			const expanded = await refuses(async () => {
				await port.applyPhase("expand", fixture.plan.expand);
			});
			expect(
				expanded === undefined,
				"restoring the first snapshot must bring back the state it was taken in, not the second snapshot's",
			);
		},
	},
	{
		// One entry of a phase is one statement to the caller. An engine that
		// compiles the first statement of an entry and drops the rest reports a
		// phase applied that was not.
		id: "schema.multi-statement-entry-is-whole-or-refused",
		requires: ["schema"],
		dependsOn: ["pattern.in-place-evolve.gated-and-restorable"],
		async run(context) {
			const fixture = context.input.engine.schemaFixture;
			const probes = fixture?.probes;
			if (fixture === undefined || probes === undefined) {
				throw new NotRun("the harness supplies no schema statement probes");
			}
			const binding = await context.open("a");
			const port = requirePort(binding, "schema");
			await port.applyPhase("expand", fixture.setup);
			expect(
				(await port.verify(probes.provesFirst)).length === 0 &&
					(await port.verify(probes.provesSecond)).length === 0,
				"neither probe statement has run yet",
			);
			const refused = await refuses(async () => {
				await port.applyPhase("expand", [`${probes.first}; ${probes.second}`]);
			});
			const first = (await port.verify(probes.provesFirst)).length > 0;
			const second = (await port.verify(probes.provesSecond)).length > 0;
			if (refused === undefined) {
				expect(
					first && second,
					"a phase entry of two statements was accepted, so both must have run",
				);
			} else {
				expect(
					!first && !second,
					"a phase entry of two statements was refused, so neither may have run",
				);
			}
		},
	},
	{
		id: "schema.verify-refuses-a-trailing-statement",
		requires: ["schema"],
		dependsOn: ["pattern.in-place-evolve.gated-and-restorable"],
		async run(context) {
			const fixture = context.input.engine.schemaFixture;
			const probes = fixture?.probes;
			if (fixture === undefined || probes === undefined) {
				throw new NotRun("the harness supplies no schema statement probes");
			}
			const binding = await context.open("a");
			const port = requirePort(binding, "schema");
			await port.applyPhase("expand", fixture.setup);
			// A violations query with a statement after it. Run, the statement
			// would change the store from inside a check; dropped, the check
			// would have verified something other than what it was handed.
			const refused = await refuses(async () => {
				await port.verify(`${probes.provesFirst}; ${probes.second}`);
			});
			expect(
				refused !== undefined,
				"a verify query with a trailing statement must be refused",
			);
			expect(
				(await port.verify(probes.provesSecond)).length === 0,
				"the statement trailing a refused verify query must not have run",
			);
		},
	},
]);

/** Thrown by a case that applies but cannot be exercised. */
class NotRun extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NotRun";
	}
}

export const ENGINE_CONFORMANCE_CASE_IDS: readonly string[] = Object.freeze(
	CASES.map((entry) => entry.id),
);

/**
 * The cases that prove a `native` realization. They run only when engine and
 * peer declare a shared native profile, and are reported as skipped otherwise.
 */
export const NATIVE_CONFORMANCE_CASE_IDS: readonly string[] = Object.freeze(
	CASES.filter((entry) => entry.native !== undefined).map((entry) => entry.id),
);

function declares(
	binding: EngineBinding,
	ports: readonly SpiPortName[],
): boolean {
	return ports.every((port) => binding.declaration.ports.includes(port));
}

/**
 * Run the suite. A case whose ports the engine does not declare is skipped —
 * skipping is not forgiveness, the pattern that needs the port simply becomes
 * ineligible at selection. A case that applies but could not run is `not-run`.
 */
export async function runEngineConformance(
	input: RunEngineConformanceInput,
): Promise<EngineConformanceReport> {
	const probe = await input.engine.create("probe");
	const peerHarness = input.peer ?? input.engine;
	const peerProbe =
		input.peer === undefined ? probe : await peerHarness.create("peer-probe");
	const engine = probe.declaration.engine;
	const results: EngineConformanceResult[] = [];
	const skipped: string[] = [];
	const failed = new Set<string>();
	const unproven = new Set<string>();
	const unknownIds = (input.only ?? []).filter(
		(id) => !ENGINE_CONFORMANCE_CASE_IDS.includes(id),
	);
	if (unknownIds.length > 0) {
		throw new DataCoreError(
			"CONFORMANCE_SUITE_INVALID",
			`unknown case ${unknownIds.join(", ")}`,
			{
				detail: { cases: unknownIds.join(",") },
			},
		);
	}
	if (input.only !== undefined && input.only.length === 0) {
		// A filter that selects nothing would run nothing and fail nothing.
		throw new DataCoreError(
			"CONFORMANCE_SUITE_INVALID",
			"only must name at least one case; leave it out to run them all",
			{ detail: { cases: "" } },
		);
	}
	const only = [...new Set(input.only ?? [])];
	const limits = input.engine.declaredLimits ?? {};
	for (const [caseId, code] of Object.entries(limits)) {
		const claimed = CASES.find((entry) => entry.id === caseId);
		// A limit is the kit's to allow and the declaration's to state. A
		// harness that could wave any case away would make the report mean
		// nothing.
		if (
			claimed?.limitable !== true ||
			!probe.declaration.impedance.includes(code)
		) {
			await probe.close();
			await input.engine.dispose?.(probe);
			if (peerProbe !== probe) {
				await peerProbe.close();
				await peerHarness.dispose?.(peerProbe);
			}
			throw new DataCoreError(
				"CONFORMANCE_SUITE_INVALID",
				claimed?.limitable === true
					? `${code} is not an impedance code ${engine} declares; a limit has to be in the declaration`
					: `${caseId} is not a property an engine may declare a limit on`,
				{ detail: { cases: caseId } },
			);
		}
	}
	try {
		for (const testCase of CASES) {
			if (input.only !== undefined && !input.only.includes(testCase.id))
				continue;
			if (
				!declares(probe, testCase.requires) ||
				testCase.declares?.(probe.declaration) === false
			) {
				skipped.push(testCase.id);
				continue;
			}
			const nativeProfile =
				testCase.native === undefined
					? undefined
					: sharedNativeProfile(
							probe.declaration,
							peerProbe.declaration,
							testCase.native,
						);
			if (testCase.native !== undefined && nativeProfile === undefined) {
				// No shared fast path is a declaration, like an absent port: the
				// selector then offers no native candidate for the pattern.
				skipped.push(testCase.id);
				continue;
			}
			const dependencies = (testCase.dependsOn ?? []).filter(
				(id) => input.only === undefined || input.only.includes(id),
			);
			const failedDependency = dependencies.find((id) => failed.has(id));
			if (failedDependency !== undefined) {
				failed.add(testCase.id);
				results.push({
					caseId: testCase.id,
					status: "blocked",
					detail: `dependency ${failedDependency} failed`,
				});
				continue;
			}
			const unprovenDependency = dependencies.find((id) => unproven.has(id));
			if (unprovenDependency !== undefined) {
				unproven.add(testCase.id);
				results.push({
					caseId: testCase.id,
					status: "not-run",
					detail: `dependency ${unprovenDependency} was not run`,
				});
				continue;
			}
			if (!declares(peerProbe, testCase.peerRequires ?? [])) {
				unproven.add(testCase.id);
				results.push({
					caseId: testCase.id,
					status: "not-run",
					detail: `peer ${peerProbe.declaration.engine} lacks ${(testCase.peerRequires ?? []).join(", ")}`,
				});
				continue;
			}
			const opened: { binding: EngineBinding; harness: EngineHarness }[] = [];
			let counter = 0;
			const context: CaseContext = {
				input,
				nativeProfile,
				async openNativePair(label) {
					const stage = input.engine.createNativePair;
					if (stage === undefined || input.peer !== undefined) {
						const source = await context.open(`${label}-source`);
						const target = await context.openPeer(`${label}-target`);
						return { source, target };
					}
					counter += 1;
					const pair = await stage.call(
						input.engine,
						`${testCase.id}:${label}:${counter}`,
					);
					// The target is closed first: its side reads from the source.
					opened.push({ binding: pair.target, harness: input.engine });
					opened.push({ binding: pair.source, harness: input.engine });
					return pair;
				},
				async open(label) {
					counter += 1;
					const binding = await input.engine.create(
						`${testCase.id}:${label}:${counter}`,
					);
					opened.push({ binding, harness: input.engine });
					return binding;
				},
				async openPeer(label) {
					counter += 1;
					const binding = await peerHarness.create(
						`${testCase.id}:${label}:${counter}`,
					);
					opened.push({ binding, harness: peerHarness });
					return binding;
				},
				async attach(binding, label) {
					const attach = input.engine.attach;
					if (attach === undefined) {
						throw new NotRun(
							"the harness cannot attach a second binding to a store",
						);
					}
					counter += 1;
					const second = await attach.call(
						input.engine,
						binding,
						`${testCase.id}:${label}:${counter}`,
					);
					// Closed before the binding it shares a store with.
					opened.unshift({ binding: second, harness: input.engine });
					return second;
				},
			};
			const limit = limits[testCase.id];
			try {
				await testCase.run(context);
				if (limit === undefined) {
					results.push({ caseId: testCase.id, status: "pass", detail: "ok" });
				} else {
					failed.add(testCase.id);
					results.push({
						caseId: testCase.id,
						status: "fail",
						detail: `the declaration states ${limit}, but the engine holds the property; a declared limit has to be a real one`,
					});
				}
			} catch (error) {
				if (limit !== undefined && error instanceof Expectation) {
					results.push({
						caseId: testCase.id,
						status: "declared-limit",
						detail: `${limit}: ${error.message}`,
					});
				} else if (error instanceof NotRun) {
					unproven.add(testCase.id);
					results.push({
						caseId: testCase.id,
						status: "not-run",
						detail: error.message,
					});
				} else {
					failed.add(testCase.id);
					if (error instanceof Error) input.onFailure?.(testCase.id, error);
					results.push({
						caseId: testCase.id,
						status: "fail",
						// An expectation's message is ours and safe to record. Anything
						// else may carry a connection string, so only its class is kept.
						detail:
							error instanceof Expectation
								? error.message
								: error instanceof DataCoreError
									? `${error.name}: ${error.code}`
									: error instanceof Error
										? `threw ${error.name}`
										: "threw a non-Error value",
					});
				}
			} finally {
				for (const { binding, harness } of opened) {
					try {
						await binding.close();
						await harness.dispose?.(binding);
					} catch {
						// Cleanup is best-effort; a case result is already recorded.
					}
				}
			}
		}
	} finally {
		await probe.close();
		await input.engine.dispose?.(probe);
		if (peerProbe !== probe) {
			await peerProbe.close();
			await peerHarness.dispose?.(peerProbe);
		}
	}
	return Object.freeze({
		suite: ENGINE_CONFORMANCE_SUITE,
		engine,
		outcome: foldConformance(results, only),
		results: Object.freeze(results.map((result) => Object.freeze(result))),
		skipped: Object.freeze(skipped),
		only: Object.freeze(only),
		checkedAt: input.now,
	});
}
